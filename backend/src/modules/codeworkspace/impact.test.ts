/**
 * CodeConclave — Impact Oracle tests (pure graph logic, no disk).
 * Covers: relative/parent/extensionless/index/export-from/require/dynamic
 * imports, bare-specifier exclusion, transitive closure, cycle safety,
 * evidence chains, determinism.
 */
import { describe, it, expect } from 'vitest';
import { parseImports, resolveImport, buildImportGraph, blastRadius } from './impact.js';

const FILES = new Map<string, string>([
  ['src/a.ts', `import { b } from './b';\nimport x from '../lib/x';\n`],
  ['src/b.ts', `export * from './c';\nconst u = require('./util');\n`],
  ['src/c.ts', `export const c = 1;\n`],
  ['src/util.ts', `export const u = 1;\n`],
  ['lib/x.ts', `import('./lazy');\nimport lodash from 'lodash';\n`],
  ['lib/lazy.ts', `import { a } from '../src/a';\n`], // cycle a -> x -> lazy -> a
  ['src/d.ts', `export const d = 1;\n`], // orphan
]);

describe('Impact Oracle', () => {
  it('parses all import syntaxes', () => {
    expect(parseImports(`import a from './a';\nexport * from './b';\nconst c = require('./c');\nimport('./d');\nimport fs from 'fs';\n`)).toEqual([
      './a',
      './b',
      './c',
      './d',
      'fs',
    ]);
  });

  it('resolves extensionless, parent, and index imports', () => {
    const known = new Set(['src/a.ts', 'src/index.ts', 'lib/x.ts']);
    expect(resolveImport('src/b.ts', './a', known)).toBe('src/a.ts');
    expect(resolveImport('src/deep/c.ts', '../../lib/x', known)).toBe('lib/x.ts');
    expect(resolveImport('src/b.ts', './', known)).toBe('src/index.ts');
    expect(resolveImport('src/b.ts', 'lodash', known)).toBeNull();
    expect(resolveImport('src/b.ts', './missing', known)).toBeNull();
  });

  it('builds the forward graph, excluding bare specifiers', () => {
    const { graph, external, unresolved } = buildImportGraph(FILES);
    expect([...graph.get('src/a.ts')!].sort()).toEqual(['lib/x.ts', 'src/b.ts']);
    expect(graph.get('src/c.ts')!.size).toBe(0);
    expect(external).toBe(1); // lodash
    expect(unresolved).toBe(0);
  });

  it('computes transitive blast radius with evidence chains', () => {
    const { graph } = buildImportGraph(FILES);
    const hit = blastRadius(graph, 'src/c.ts');
    const files = hit.map((e) => e.file);
    expect(files).toContain('src/b.ts');
    expect(files).toContain('src/a.ts');
    expect(files).toContain('lib/x.ts');
    expect(files).toContain('lib/lazy.ts');
    expect(files).not.toContain('src/d.ts');
    expect(files).not.toContain('src/c.ts');
    const b = hit.find((e) => e.file === 'src/b.ts')!;
    expect(b.depth).toBe(1);
    expect(b.via).toEqual(['src/c.ts', 'src/b.ts']);
  });

  it('is cycle-safe and deterministic', () => {
    const { graph } = buildImportGraph(FILES);
    const once = blastRadius(graph, 'src/a.ts');
    const twice = blastRadius(graph, 'src/a.ts');
    expect(once).toEqual(twice);
    expect(new Set(once.map((e) => e.file)).size).toBe(once.length);
    expect(once.every((e) => e.depth >= 1)).toBe(true);
  });

  it('orders by depth then file', () => {
    const { graph } = buildImportGraph(FILES);
    const hit = blastRadius(graph, 'src/util.ts');
    expect(hit[0]!.file).toBe('src/b.ts');
    expect(hit[0]!.depth).toBe(1);
  });
});
