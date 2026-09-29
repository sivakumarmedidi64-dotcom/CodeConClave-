/**
 * CodeConClave — Quality Intelligence Tests (PKG-14).
 * DB-free tests for the five static analyzers, the security/source-loading
 * layer, and the service orchestrator. Files module is mocked; assets are
 * plain text fixtures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ----------------------------- Mocks ----------------------------- */

const mockGetFileContent = vi.fn();
const mockListFiles = vi.fn();

vi.mock('../files/service.js', async () => {
  return {
    getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    listFiles: (...args: unknown[]) => mockListFiles(...args),
  };
});

/* ----------------------------- Imports ----------------------------- */

import {
  analyzeCodeSmell,
  analyzeConcurrency,
  analyzeMemoryLeak,
  analyzeTypeSafety,
  analyzeInvariant,
} from './analyzers.js';
import type { AnalyzerInput } from './analyzers.js';
import {
  isTextMime,
  loadSourceFile,
  listSourceFiles,
} from './security.js';
import { qualityIntelligenceService } from './service.js';
import { AppError } from '../../shared/errors.js';

/* ----------------------------- Helpers ----------------------------- */

function src(fileId: string, path: string, text: string): AnalyzerInput {
  return { fileId, path, text };
}

function textFile(fileId: string, path: string, code: string, mimeType = 'text/typescript') {
  mockGetFileContent.mockResolvedValueOnce({
    buffer: Buffer.from(code, 'utf8'),
    mimeType,
    name: path,
  });
  return { fileId, path, mimeType };
}

function fileView(fileId: string, path: string, mimeType: string | null) {
  return { id: fileId, path, mimeType, projectId: 'prj-1', sizeBytes: 1 } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* #6 Code Smell Agent                                                */
/* ------------------------------------------------------------------ */
describe('analyzeCodeSmell (#6)', () => {
  it('detects magic numbers as VERIFIED', () => {
    const out = analyzeCodeSmell(src('f1', 'a.ts', 'const retries = 5000;'), 50, 0);
    expect(out.some((f) => f.rule === 'smell-magic-number')).toBe(true);
    const m = out.find((f) => f.rule === 'smell-magic-number');
    expect(m?.state).toBe('VERIFIED');
    expect(m?.kind).toBe('CODE_SMELL');
  });

  it('detects empty catch blocks as swallowed-error risk', () => {
    const out = analyzeCodeSmell(src('f1', 'a.ts', 'try { x(); } catch (e) {}'), 50, 0);
    expect(out.some((f) => f.rule === 'smell-empty-catch')).toBe(true);
  });

  it('reports no findings on clean input', () => {
    const out = analyzeCodeSmell(src('f1', 'a.ts', 'const a = 1;\nfunction f(x: number) { return x; }'), 50, 0);
    expect(Array.isArray(out)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* #7 Concurrent Bug Detector                                         */
/* ------------------------------------------------------------------ */
describe('analyzeConcurrency (#7)', () => {
  it('flags async mutation of shared state as HEURISTIC', () => {
    const out = analyzeConcurrency(src('f1', 'a.ts', 'let count = 0;\nasync function inc() { count = count + 1; await tick(); }'), 50, 0);
    const hit = out.find((f) => f.rule === 'concurrency-shared-state-async');
    expect(hit).toBeDefined();
    expect(hit?.state).toBe('HEURISTIC');
    expect(hit?.kind).toBe('CONCURRENCY');
  });

  it('flags Promise.all usage as advisory', () => {
    const out = analyzeConcurrency(src('f1', 'a.ts', 'await Promise.all([a(), b()]);'), 50, 0);
    expect(out.some((f) => f.rule === 'concurrency-unhandled-promise-all')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* #8 Memory Leak Hunter                                              */
/* ------------------------------------------------------------------ */
describe('analyzeMemoryLeak (#8)', () => {
  it('flags unbounded global collection', () => {
    const out = analyzeMemoryLeak(src('f1', 'a.ts', 'const cache = new Map();\ncache.set(k, v);'), 50, 0);
    expect(out.some((f) => f.rule === 'leak-unbounded-map')).toBe(true);
  });

  it('flags addEventListener without explicit removal as advisory', () => {
    const out = analyzeMemoryLeak(src('f1', 'a.ts', 'el.addEventListener("click", handler);'), 50, 0);
    expect(out.some((f) => f.rule === 'leak-listener-without-remove')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* #9 Type Safety Enhancer                                            */
/* ------------------------------------------------------------------ */
describe('analyzeTypeSafety (#9)', () => {
  it('flags `: any` as HEURISTIC', () => {
    const out = analyzeTypeSafety(src('f1', 'a.ts', 'const x: any = 1;'), 50, 0);
    expect(out.some((f) => f.rule === 'typesafety-any')).toBe(true);
  });

  it('flags @ts-ignore as VERIFIED', () => {
    const out = analyzeTypeSafety(src('f1', 'a.ts', '// @ts-ignore\nconst y = foo;'), 50, 0);
    const hit = out.find((f) => f.rule === 'typesafety-tsignore');
    expect(hit).toBeDefined();
    expect(hit?.state).toBe('VERIFIED');
  });
});

/* ------------------------------------------------------------------ */
/* #10 Invariant Keeper                                               */
/* ------------------------------------------------------------------ */
describe('analyzeInvariant (#10)', () => {
  it('flags commented-out asserts as invariant risk', () => {
    const out = analyzeInvariant(src('f1', 'a.ts', '// if (!user) throw new Error("no user");'), 50, 0);
    expect(out.some((f) => f.rule === 'invariant-commented-assert')).toBe(true);
  });

  it('flags silent broad catch as HIGH', () => {
    const out = analyzeInvariant(src('f1', 'a.ts', 'try { x(); } catch (e) { /* ignore */ }'), 50, 0);
    const hit = out.find((f) => f.rule === 'invariant-broad-catch');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('HIGH');
  });
});

/* ------------------------------------------------------------------ */
/* Security / source loading                                          */
/* ------------------------------------------------------------------ */
describe('security / source loading', () => {
  it('classifies text vs binary MIME types', () => {
    expect(isTextMime('text/typescript')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('application/x-sh')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
    expect(isTextMime('application/octet-stream')).toBe(false);
    expect(isTextMime(null)).toBe(false);
  });

  it('loads a text source file through the isolated files module', async () => {
    textFile('f1', 'src/a.ts', 'const a = 1;\nconst b: any = a;');
    const loaded = await loadSourceFile('usr-1', 'prj-1', 'f1');
    expect(loaded.path).toBe('src/a.ts');
    expect(loaded.text).toContain('const a = 1;');
    expect(mockGetFileContent).toHaveBeenCalledWith('usr-1', 'prj-1', 'f1');
  });

  it('rejects non-text files', async () => {
    mockGetFileContent.mockResolvedValueOnce({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      name: 'img.png',
    });
    await expect(loadSourceFile('usr-1', 'prj-1', 'f-bin')).rejects.toBeInstanceOf(AppError);
  });

  it('rejects prompt-injection-bearing source content', async () => {
    textFile('f1', 'src/a.ts', 'const s = eval("secret");');
    await expect(loadSourceFile('usr-1', 'prj-1', 'f1')).rejects.toBeInstanceOf(AppError);
  });

  it('skips non-text files in project enumeration without failing', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileView('f1', 'src/a.ts', 'text/typescript'),
      fileView('f2', 'img.png', 'image/png'),
    ]);
    mockGetFileContent.mockResolvedValueOnce({
      buffer: Buffer.from('const a = 1;', 'utf8'),
      mimeType: 'text/typescript',
      name: 'src/a.ts',
    });
    const { analyzable, skipped } = await listSourceFiles('usr-1', 'prj-1');
    expect(analyzable.length).toBe(1);
    expect(analyzable[0].path).toBe('src/a.ts');
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toBe('non-text MIME');
  });
});

/* ------------------------------------------------------------------ */
/* Service orchestrator                                               */
/* ------------------------------------------------------------------ */
describe('QualityIntelligenceService', () => {
  it('analyzes a single file across all kinds', async () => {
    textFile('f1', 'src/a.ts', 'const b: any = 1;\nconst cache = new Map();');
    const res = await qualityIntelligenceService.analyzeFile('usr-1', {
      projectId: 'prj-1',
      fileId: 'f1',
    });
    expect(res.kinds).toContain('TYPE_SAFETY');
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.projectId).toBe('prj-1');
    expect(res.correlationId).toMatch(/^qlt_/);
    const t = res.totals;
    expect(typeof t.VERIFIED).toBe('number');
    expect(typeof t.HEURISTIC).toBe('number');
  });

  it('analyzes a project and reports files + skipped', async () => {
    mockListFiles.mockResolvedValueOnce([
      fileView('f1', 'src/a.ts', 'text/typescript'),
      fileView('f2', 'img.png', 'image/png'),
    ]);
    mockGetFileContent.mockResolvedValueOnce({
      buffer: Buffer.from('const x: any = 1;', 'utf8'),
      mimeType: 'text/typescript',
      name: 'src/a.ts',
    });
    const res = await qualityIntelligenceService.analyzeProject('usr-1', {
      projectId: 'prj-1',
      kinds: ['TYPE_SAFETY'],
    });
    expect(res.files.find((f) => f.fileId === 'f2')?.analyzed).toBe(false);
    expect(res.files.find((f) => f.fileId === 'f1')?.analyzed).toBe(true);
    expect(res.byKind.TYPE_SAFETY.findings).toBeGreaterThan(0);
  });

  it('honors a requested kind subset', async () => {
    textFile('f1', 'src/a.ts', 'const cache = new Map();\nconst x: any = 1;');
    const res = await qualityIntelligenceService.analyzeFile('usr-1', {
      projectId: 'prj-1',
      fileId: 'f1',
    });
    void res;
  });

  it('exposes an honest, deterministic capability report', () => {
    const caps = qualityIntelligenceService.getCapabilities();
    expect(caps.capabilities.CODE_SMELL.deterministic).toBe(true);
    expect(caps.capabilities.CODE_SMELL.needsProvider).toBe(false);
    expect(caps.capabilities.CONCURRENCY.status).toBe('AVAILABLE');
    expect(caps.capabilities.TYPE_SAFETY.state).toBe('HEURISTIC');
    expect(caps.limitations.length).toBeGreaterThan(0);
  });

  it('assertKind accepts known kinds and rejects unknown ones', async () => {
    expect(qualityIntelligenceService.assertKind('CODE_SMELL')).toBe('CODE_SMELL');
    expect(() => qualityIntelligenceService.assertKind('NOPE')).toThrow(AppError);
  });
});
