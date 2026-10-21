/**
 * "Beyond agentic" systems — deterministic parts, on real code samples.
 * (Database-backed flows are checked against real Postgres in the e2e run.)
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { levelOf, maxNesting, measure, normalizeLine } from './thermostat.js';
import { buildGravityMap, importsOf, resolveImport } from './gravity.js';
import { consensusOf, convene, deterministicFindings, parseAiOpinion, verdictOf } from './council.js';
import { matchLines, unsafeRegexReason, validateVaccine } from './immunity.js';
import { headlineOf, localHour } from './nightShift.js';
import { manifestHashOf, signHash, TELEPORT_FORMAT, TELEPORT_VERSION, verifyBundle, type TeleportBundle } from './teleport.js';

const repeated = Array.from({ length: 8 }, (_, i) => `  const value${i} = computeSomething(input, ${i});`).join('\n');

describe('Code Thermostat', () => {
  it('a small clean project is cool', () => {
    const m = measure([{ path: 'src/a.ts', text: 'export function add(a: number, b: number) {\n  return a + b;\n}\n' }]);
    expect(m.temperature).toBeLessThan(25);
    expect(m.level).toBe('COOL');
    expect(m.codeFiles).toBe(1);
  });

  it('duplication, size, nesting and TODOs all raise the temperature — with the reasons', () => {
    const big = Array.from({ length: 450 }, (_, i) => `const line${i} = ${i}; // TODO tidy`).join('\n');
    const deep = 'function f() {\n' + Array.from({ length: 7 }, (_, d) => `${'  '.repeat(d + 1)}if (x${d}) {`).join('\n') + '\n' + '  '.repeat(8) + 'go();\n}';
    const m = measure([
      { path: 'src/one.ts', text: `function a() {\n${repeated}\n}\n` },
      { path: 'src/two.ts', text: `function b() {\n${repeated}\n}\n` },
      { path: 'src/big.ts', text: big },
      { path: 'src/deep.ts', text: deep },
      { path: 'README.md', text: repeated }, // not code: ignored
    ]);
    expect(m.codeFiles).toBe(4);
    expect(m.components.duplication.duplicatedLines).toBeGreaterThanOrEqual(16);
    expect(m.components.size.largeFiles).toBe(1);
    expect(m.components.nesting.deepFiles).toBe(1);
    expect(m.components.markers.count).toBe(450);
    expect(m.temperature).toBeGreaterThan(25);
    const big1 = m.hottest.find((h) => h.path === 'src/big.ts')!;
    expect(big1.reasons.join(' ')).toMatch(/450 lines long/);
    expect(big1.reasons.join(' ')).toMatch(/TODO/);
    expect(m.hottest.find((h) => h.path === 'src/one.ts')!.reasons[0]).toMatch(/duplicated/);
  });

  it('is deterministic and explains its levels', () => {
    const files = [{ path: 'x.ts', text: repeated + '\n' + repeated }];
    expect(measure(files)).toEqual(measure(files));
    expect([levelOf(10), levelOf(30), levelOf(60), levelOf(90)]).toEqual(['COOL', 'WARM', 'HOT', 'CRITICAL']);
    expect(normalizeLine("import x from 'y';")).toBeNull();
    expect(normalizeLine('   }')).toBeNull();
    expect(maxNesting('a\n  b\n    c\n      d')).toBe(3);
  });
});

describe('Gravity Map', () => {
  const files = [
    { path: 'src/ui/Button.tsx', text: "import { cx } from '../lib/cx';\nimport { theme } from '../lib/theme';\nimport { size } from '../lib/buttonSize';" },
    { path: 'src/ui/Card.tsx', text: "import { Button } from './Button';\nimport { cx } from '../lib/cx';\nimport { size } from '../lib/buttonSize';" },
    { path: 'src/ui/Badge.tsx', text: "import { size } from '../lib/buttonSize';" },
    { path: 'src/lib/buttonSize.ts', text: 'export const size = 2;' },
    { path: 'src/lib/cx.ts', text: 'export const cx = () => 1;' },
    { path: 'src/lib/theme.ts', text: "import { cx } from './cx';" },
    { path: 'src/lib/format.ts', text: "import { Button } from '../ui/Button';\nimport { Card } from '../ui/Card.js';\nimport x from '../ui/Button.tsx';\nimport { cx } from '../ui/../lib/cx';" },
    { path: 'src/old/unused.ts', text: 'export const nobody = 1;' },
    { path: 'src/index.ts', text: "import React from 'react';" },
  ];

  it('reads JS/TS and Python imports and resolves them to project files', () => {
    expect(importsOf('a.ts', "import a from './a'; export * from './b'; const c = require('./c'); await import('./d');")).toEqual(['./a', './b', './c', './d']);
    expect(importsOf('m.py', 'from .utils import x\nimport os, pkg.mod\n')).toEqual(['py:.utils', 'py:os', 'py:pkg.mod']);
    const set = new Set(['src/a/b.ts', 'src/a/index.ts', 'pkg/mod.py', 'app/utils.py']);
    expect(resolveImport('src/a/c.ts', './b.js', set)).toBe('src/a/b.ts');
    expect(resolveImport('src/x.ts', './a', set)).toBe('src/a/index.ts');
    expect(resolveImport('src/x.ts', 'react', set)).toBeNull();
    expect(resolveImport('app/main.py', 'py:.utils', set)).toBe('app/utils.py');
    expect(resolveImport('x.py', 'py:pkg.mod', set)).toBe('pkg/mod.py');
  });

  it('finds the wells, the drifters and a misplaced file', () => {
    const map = buildGravityMap(files);
    expect(map.wells[0]).toEqual({ path: 'src/lib/cx.ts', dependents: 4 });
    expect(map.drifters).toEqual(['src/old/unused.ts']); // index.ts is an entry point, not a drifter
    // buttonSize lives in lib but only ui files use it; ui files that USE lib helpers stay put.
    expect(map.misplaced).toEqual([{ path: 'src/lib/buttonSize.ts', folder: 'src/lib', pulledTo: 'src/ui', share: 1 }]);
    expect(map.constellations.length).toBeGreaterThanOrEqual(1);
    expect(map.constellations[0]!.files).toContain('src/lib/cx.ts');
  });
});

describe('Council', () => {
  const risky = [
    "import { exec } from 'child_process';",
    'export async function run(userInput: string, ids: string[]) {',
    '  exec(`ls ${userInput}`);',
    "  const rows = await db.query(`SELECT * FROM users WHERE name = '${userInput}'`);",
    '  for (const id of ids) {',
    '    await db.query(`SELECT 1 WHERE id = $1`, [id]);',
    '  }',
    '  try { risky(); } catch {}',
    '  const token = Math.random().toString(36);',
    '  return rows;',
    '}',
  ].join('\n');

  it('each bot finds what it is responsible for, with line numbers', () => {
    const f = deterministicFindings('src/run.ts', risky, { projectPaths: ['src/run.ts'] });
    const rules = (lens: string) => f.filter((x) => x.lens === lens).map((x) => x.rule);
    expect(rules('security')).toEqual(expect.arrayContaining(['shell-concat', 'sql-concat', 'random-secret']));
    expect(rules('performance')).toContain('n-plus-one');
    expect(rules('correctness')).toEqual(expect.arrayContaining(['swallowed-error', 'no-tests']));
    expect(f.find((x) => x.rule === 'shell-concat')!.line).toBe(3);
  });

  it('security HIGH blocks; the consensus says do not ship', async () => {
    const r = await convene({ path: 'src/run.ts', text: risky });
    expect(r.lenses.find((l) => l.lens === 'security')!.verdict).toBe('BLOCK');
    expect(r.consensus.verdict).toBe('DO_NOT_SHIP');
    expect(r.ai).toEqual({ requested: false, available: false });
  });

  it('clean code ships, and a live credential is a CRITICAL block without showing the value', async () => {
    const clean = await convene({ path: 'src/sum.ts', text: 'export const sum = (a: number, b: number) => a + b;\n' });
    expect(clean.consensus.verdict).toBe('SHIP');
    const leaked = deterministicFindings('src/c.ts', `const k = 'ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}';`);
    expect(leaked[0]).toMatchObject({ rule: 'live-credential', severity: 'CRITICAL', evidence: '[value hidden]' });
  });

  it('votes and parses AI opinions strictly', () => {
    expect(verdictOf('performance', [{ severity: 'HIGH' } as never])).toBe('CONCERNS');
    expect(verdictOf('security', [{ severity: 'HIGH' } as never])).toBe('BLOCK');
    expect(consensusOf([{ verdict: 'PASS' }, { verdict: 'CONCERNS' }, { verdict: 'CONCERNS' }, { verdict: 'PASS' }]).verdict).toBe('FIX_FIRST');
    expect(parseAiOpinion('Sure! {"verdict":"concerns","points":["line 3 builds a shell string"]}')).toEqual({ verdict: 'CONCERNS', points: ['line 3 builds a shell string'] });
    expect(parseAiOpinion('{"verdict":"maybe"}')).toBeNull();
    expect(parseAiOpinion('no json')).toBeNull();
  });
});

describe('Immunity', () => {
  it('refuses regexes that could hang the server', () => {
    expect(unsafeRegexReason('(a+)+$')).toMatch(/repeated group/);
    expect(unsafeRegexReason('(a|aa)+')).toMatch(/alternatives/);
    expect(unsafeRegexReason('(\\w)\\1')).toMatch(/backreferences/);
    expect(unsafeRegexReason('(?=x)')).toMatch(/lookarounds/);
    expect(unsafeRegexReason('[unclosed')).toMatch(/invalid regex/);
    expect(unsafeRegexReason('\\.innerHTML\\s*=')).toBeNull();
  });

  it('validates vaccines and finds the pattern line by line', () => {
    expect(() => validateVaccine({ name: 'x', pattern: 'ab' })).toThrow(/at least 4/);
    expect(validateVaccine({ name: 'No innerHTML', pattern: '\\.innerHTML\\s*=', kind: 'regex', severity: 'HIGH' })).toMatchObject({ kind: 'regex', severity: 'HIGH' });
    const hits = matchLines('a\nel.innerHTML = x\nb\nother.innerHTML=y', { pattern: '\\.innerHTML\\s*=', kind: 'regex' });
    expect(hits.map((h) => h.line)).toEqual([2, 4]);
    expect(matchLines('Hello TODO world', { pattern: 'todo', kind: 'literal' })).toEqual([{ line: 1, preview: 'Hello TODO world' }]);
  });
});

describe('Night Shift', () => {
  it('writes an honest one-line headline', () => {
    expect(headlineOf({ projects: [], council: [], immunity: [], filesReviewed: 0, errors: [] })).toBe('No recently active projects to check.');
    const h = headlineOf({
      projects: [
        { id: 'p1', name: 'A', temperature: 40, level: 'WARM', delta: 5, hottest: [] },
        { id: 'p2', name: 'B', temperature: 10, level: 'COOL', delta: -3, hottest: [] },
      ],
      council: [{ projectId: 'p1', projectName: 'A', path: 'x.ts', verdict: 'DO_NOT_SHIP', top: [] }],
      immunity: [{ vaccineId: 'v', name: 'n', matches: 3 }],
      filesReviewed: 1,
      errors: [],
    });
    expect(h).toBe('2 projects measured · 1 got warmer · 1 cooled down · 1 changed file blocked by the Council · 3 Immunity matches.');
  });

  it('computes the local hour from the account offset (IST = +330 min)', () => {
    expect(localHour(new Date('2026-10-21T20:45:00Z'), 330)).toBe(2); // 02:15 IST
    expect(localHour(new Date('2026-10-21T00:10:00Z'), 0)).toBe(0);
  });
});

describe('Teleport', () => {
  function bundle(): TeleportBundle {
    const content = Buffer.from('export const a = 1;\n');
    const body = {
      format: TELEPORT_FORMAT,
      version: TELEPORT_VERSION,
      project: { name: 'Demo', description: null, tags: [] },
      files: [{ path: 'src/a.ts', mimeType: 'text/plain', sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length, content: content.toString('base64') }],
      memories: [{ type: 'PROJECT', content: 'Uses pnpm', confidence: 0.9 }],
    } as const;
    const manifestHash = manifestHashOf(body);
    return { ...body, files: [...body.files], memories: [...body.memories], createdAt: new Date().toISOString(), manifestHash, signature: signHash(manifestHash) };
  }
  const pack = (b: unknown) => zlib.gzipSync(Buffer.from(JSON.stringify(b)));

  it('a sealed bundle verifies, and says it was signed here', () => {
    expect(verifyBundle(pack(bundle()))).toMatchObject({ fileCount: 1, memoryCount: 1, signedHere: true });
  });

  it('one changed byte, or a changed manifest, rejects the whole bundle', () => {
    const b = bundle();
    b.files[0]!.content = Buffer.from('export const a = 2;\n').toString('base64');
    expect(() => verifyBundle(pack(b))).toThrow(/changed after it was sealed/);
    const c = bundle();
    c.project.name = 'Renamed';
    expect(() => verifyBundle(pack(c))).toThrow(/manifest does not match/);
  });

  it('a bundle from another server is intact but not signed here; junk is refused', () => {
    const b = bundle();
    b.signature = 'f'.repeat(64);
    expect(verifyBundle(pack(b)).signedHere).toBe(false);
    expect(() => verifyBundle(Buffer.from('not a bundle'))).toThrow(/not a CodeConClave Teleport bundle/);
  });
});
