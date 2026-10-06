/**
 * CodeConClave — workbench lib tests.
 * Diff/highlight/layout/normalizer are pure; the stream is exercised against a
 * controllable EventSource double so reconnect + transport state are proven.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  lineDiff,
  parseUnifiedDiff,
  highlightRange,
  highlightLanguage,
  statusMeta,
  isActiveTaskStatus,
  loadWorkbenchLayout,
  saveWorkbenchLayout,
  normalizeCoworkerRun,
  normalizeCoworkerRuns,
  artifactValue,
  workbenchStream,
  type WorkbenchEvent,
} from './workbench';

describe('lineDiff', () => {
  it('returns all additions when the before side is empty', () => {
    expect(lineDiff([], ['a', 'b'])).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('returns all deletions when the after side is empty', () => {
    expect(lineDiff(['a'], [])).toEqual([{ type: 'del', text: 'a' }]);
  });

  it('aligns equal lines and isolates a single change', () => {
    const ops = lineDiff(['a', 'b', 'c'], ['a', 'B', 'c']);
    expect(ops.filter((o) => o.type === 'equal').map((o) => o.text)).toEqual(['a', 'c']);
    expect(ops.find((o) => o.type === 'del')?.text).toBe('b');
    expect(ops.find((o) => o.type === 'add')?.text).toBe('B');
  });

  it('degrades to whole-file markers past the size guard', () => {
    const a = Array.from({ length: 5 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 5 }, (_, i) => `b${i}`);
    const ops = lineDiff(a, b, 3);
    expect(ops.slice(0, 5).every((o) => o.type === 'del')).toBe(true);
    expect(ops.slice(5).every((o) => o.type === 'add')).toBe(true);
  });
});

describe('parseUnifiedDiff', () => {
  const raw = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    ' const x = 1;',
    '-const y = 2;',
    '+const y = 3;',
    ' export {};',
  ].join('\n');

  it('extracts file path, additions/deletions and hunk lines', () => {
    const parsed = parseUnifiedDiff(raw);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.path).toBe('src/app.ts');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks[0]!.header).toContain('@@ -1,3 +1,3 @@');
    const types = file.hunks[0]!.lines.map((l) => l.type);
    expect(types).toContain('add');
    expect(types).toContain('del');
    expect(types).toContain('equal');
  });

  it('returns no files for empty input', () => {
    expect(parseUnifiedDiff('').files).toEqual([]);
  });

  it('handles multiple files', () => {
    const two = `${raw}\n${raw.replace(/app\.ts/g, 'other.ts')}`;
    expect(parseUnifiedDiff(two).files.map((f) => f.path)).toEqual(['src/app.ts', 'src/other.ts']);
  });
});

describe('highlighting', () => {
  it('maps extensions to languages', () => {
    expect(highlightLanguage('a.ts')).toBe('ts');
    expect(highlightLanguage('a.tsx')).toBe('ts');
    expect(highlightLanguage('a.unknown')).toBe('plain');
  });

  it('tokenizes keywords, strings and numbers', () => {
    const tokens = highlightRange('const x = "hi"; // note', 'ts');
    const byType = (t: string) => tokens.filter((k) => k.type === t).map((k) => k.text);
    expect(byType('keyword')).toContain('const');
    expect(byType('string')).toContain('"hi"');
    expect(byType('comment').join('')).toContain('// note');
  });
});

describe('status helpers', () => {
  it('labels known statuses and falls back for unknown', () => {
    expect(statusMeta('RUNNING').label).toBe('Running');
    expect(statusMeta('NOPE').label).toBe('NOPE');
  });

  it('detects active vs terminal statuses', () => {
    expect(isActiveTaskStatus('RUNNING')).toBe(true);
    expect(isActiveTaskStatus('COMPLETED')).toBe(false);
    expect(isActiveTaskStatus(null)).toBe(false);
  });
});

describe('layout persistence', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults for an unknown project', () => {
    expect(loadWorkbenchLayout('missing')).toEqual({ leftPx: 260, rightPx: 320, bottomPx: 220 });
  });

  it('round-trips a saved layout per project', () => {
    saveWorkbenchLayout('p1', { leftPx: 300, rightPx: 400, bottomPx: 150 });
    expect(loadWorkbenchLayout('p1')).toEqual({ leftPx: 300, rightPx: 400, bottomPx: 150 });
    expect(loadWorkbenchLayout('p2')).toEqual({ leftPx: 260, rightPx: 320, bottomPx: 220 });
  });

  it('ignores corrupt stored values', () => {
    localStorage.setItem('cc.workbench.layout.v1.p1', '{not json');
    expect(loadWorkbenchLayout('p1').leftPx).toBe(260);
  });
});

describe('coworker normalizers', () => {
  it('maps snake_case run rows to camelCase', () => {
    const run = normalizeCoworkerRun({
      id: 'r1',
      coworker_type: 'CODER',
      state: 'COMPLETED',
      verification_result: 'PASS',
      error_code: 'E_NONE',
      output: { summary: 'done' },
    });
    expect(run.coworkerType).toBe('CODER');
    expect(run.state).toBe('COMPLETED');
    expect(run.verification).toBe('PASS');
    expect(run.error).toBe('E_NONE');
    expect(run.output).toContain('done');
  });

  it('reads either key style', () => {
    expect(normalizeCoworkerRuns([{ coworkerType: 'ARCHITECT', verification: 'SKIPPED' }]).map((r) => r.coworkerType)).toEqual(['ARCHITECT']);
  });

  it('artifactValue resolves the first present key', () => {
    expect(artifactValue({ sizeBytes: 9 }, ['size_bytes', 'sizeBytes'], 0)).toBe(9);
    expect(artifactValue({}, ['size_bytes', 'sizeBytes'], 42)).toBe(42);
  });
});

class ControlledES {
  static last: ControlledES | null = null;
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) {
    ControlledES.last = this;
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emit(type: string, ev: unknown) {
    (this.listeners[type] ?? []).forEach((cb) => cb(ev));
  }
}

describe('workbenchStream', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', ControlledES);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports connected and forwards well-formed frames', () => {
    const events: WorkbenchEvent[] = [];
    const states: boolean[] = [];
    const stream = workbenchStream('p1', { onEvent: (e) => events.push(e), onState: (s) => states.push(s) });
    const es = ControlledES.last!;
    es.emit('open', {});
    es.emit('message', { data: JSON.stringify({ type: 'task', id: 't1', projectId: 'p1', status: 'RUNNING', ts: 'now' }) });
    expect(states.at(-1)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('task');
    stream.close();
  });

  it('ignores malformed frames but keeps the stream', () => {
    const events: WorkbenchEvent[] = [];
    workbenchStream('p1', { onEvent: (e) => events.push(e), onState: () => {} });
    ControlledES.last!.emit('message', { data: 'not-json' });
    expect(events).toHaveLength(0);
  });

  it('reports disconnected without an EventSource (SSR / unsupported)', () => {
    const states: boolean[] = [];
    const fake = globalThis as { EventSource?: unknown };
    const original = fake.EventSource;
    delete fake.EventSource;
    const stream = workbenchStream('p1', { onEvent: () => {}, onState: (s) => states.push(s) });
    expect(states).toEqual([false]);
    stream.close();
    fake.EventSource = original;
  });
});