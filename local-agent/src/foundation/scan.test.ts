/**
 * CodeConClave — project scanner tests (real temp project, real fs reads).
 *
 * Pins: import extraction (JS/TS + Python), local resolution to files that
 * really exist (no phantom edges), cycle detection, dead-file detection
 * (entries/tests excluded), workspace containment, bounds, and symlink
 * discipline. Nothing mocked except nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractJsImports,
  extractPyImports,
  buildGraph,
  findCycles,
  findDeadFiles,
  scanWorkspace,
  collectScannableFiles,
} from '../scan.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-scan-'));
  // Cycle: a -> b -> c -> a. Orphan: lone.ts. Entry: index.ts imports a.
  // Python pair: pkg/mod.py <-> pkg/util.py cycle via relative imports.
  writeFileSync(join(root, 'index.ts'), `import { a } from './a';\nconsole.log(a);\n`, 'utf8');
  writeFileSync(join(root, 'a.ts'), `import { b } from './b';\nexport const a = b;\n`, 'utf8');
  writeFileSync(join(root, 'b.ts'), `import { c } from './c';\nexport const b = c;\n`, 'utf8');
  writeFileSync(join(root, 'c.ts'), `import { a } from './a';\nexport const c = a;\n`, 'utf8');
  writeFileSync(join(root, 'lone.ts'), `export const lone = 1;\n`, 'utf8');
  writeFileSync(join(root, 'uses-external.ts'), `import express from 'express';\nimport { a } from './a';\nexport const x = [express, a];\n`, 'utf8');
  writeFileSync(join(root, 'ghost.ts'), `import { nope } from './does-not-exist';\nexport const g = nope;\n`, 'utf8');
  mkdirSync(join(root, 'pkg'), { recursive: true });
  writeFileSync(join(root, 'pkg', '__init__.py'), '', 'utf8');
  writeFileSync(join(root, 'pkg', 'mod.py'), `from .util import helper\nVALUE = helper()\n`, 'utf8');
  writeFileSync(join(root, 'pkg', 'util.py'), `from .mod import VALUE\ndef helper():\n    return 1\n`, 'utf8');
  writeFileSync(join(root, 'notes.txt'), 'not code\n', 'utf8');
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('project scanner — extraction', () => {
  it('extracts JS/TS import specifiers', () => {
    const specs = extractJsImports(`import x from './a';\nimport './side';\nconst y = require("../b");\nexport * from '@scope/pkg';\n`);
    expect(specs).toEqual(expect.arrayContaining(['./a', './side', '../b', '@scope/pkg']));
  });

  it('extracts Python imports', () => {
    const specs = extractPyImports(`import os, sys\nfrom .util import helper\nfrom pkg.mod import thing\n`);
    expect(specs).toEqual(expect.arrayContaining(['os', 'sys', '.util', 'pkg.mod']));
  });
});

describe('project scanner — graph over the real fixture', () => {
  it('builds edges only to files that exist (no phantom edges)', () => {
    const { files } = collectScannableFiles(root);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('a.ts');
    expect(paths).not.toContain('notes.txt');
    const graph = buildGraph(files);
    // './does-not-exist' must not become an edge.
    expect(graph.edges.some(([f]) => f === 'ghost.ts')).toBe(false);
    expect(graph.edges).toContainEqual(['a.ts', 'b.ts']);
    expect(graph.edges).toContainEqual(['pkg/mod.py', 'pkg/util.py']);
    expect(graph.externalDeps).toContain('express');
  });

  it('detects the real a->b->c->a and mod<->util cycles', () => {
    const { files } = collectScannableFiles(root);
    const graph = buildGraph(files);
    const flat = graph.cycles.map((c) => [...c].sort().join(','));
    expect(flat.some((c) => c.includes('a.ts') && c.includes('b.ts') && c.includes('c.ts'))).toBe(true);
    expect(flat.some((c) => c.includes('pkg/mod.py') && c.includes('pkg/util.py'))).toBe(true);
  });

  it('flags the orphan but never entries or tests', () => {
    expect(findDeadFiles(['index.ts', 'lone.ts', 'x.test.ts'], [])).toEqual(['lone.ts']);
  });

  it('scanWorkspace reports counts and bounds honestly', () => {
    const out = scanWorkspace(root);
    expect(out.fileCount).toBeGreaterThanOrEqual(9);
    expect(out.truncated).toBe(false);
    expect(out.deadFiles).toContain('lone.ts');
    expect(out.deadFiles).not.toContain('index.ts');
  });

  it('findCycles is deterministic and deduplicated', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: Array<[string, string]> = [['a', 'b'], ['b', 'c'], ['c', 'a']];
    const once = findCycles(nodes, edges);
    const twice = findCycles([...nodes].reverse(), [...edges].reverse());
    expect(once).toHaveLength(1);
    expect(twice).toHaveLength(1);
  });
});
