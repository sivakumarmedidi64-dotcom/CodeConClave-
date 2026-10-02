/**
 * CodeConClave — Stage 92 SUPERPOWERS Tranche N: Auto-Divergence, Mirror World,
 * Tribunal.
 *
 *   AUTO-DIVERGENCE (#12) — every keystroke you hand-fix is a pattern; the
 *                           coworker spots repeats, suggests finishing the rest,
 *                           and tunes itself on your yes/no answers.
 *   MIRROR WORLD (#15)    — "what if 10x traffic?" answered with real numbers
 *                           from a sandboxed clone (latency, error %, CPU, RAM).
 *   TRIBUNAL (#18)        — high-stakes changes go before several models; the
 *                           test suite is the judge, losers become lessons.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    divergence_sessions: [] as Array<Record<string, unknown>>,
    divergence_preferences: [] as Array<Record<string, unknown>>,
    mirror_world_runs: [] as Array<Record<string, unknown>>,
    tribunal_hearings: [] as Array<Record<string, unknown>>,
    tribunal_lessons: [] as Array<Record<string, unknown>>,
  };
  return { tables, now: () => new Date().toISOString() };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '');
  }
  function parseVal(col: string, val: unknown): unknown {
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { return JSON.parse(val); } catch { /* keep */ }
    }
    return val;
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\)]+)\)\s*values\s*\((.*)\)/is.exec(text);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const row: Record<string, unknown> = { created_at: store.now(), updated_at: store.now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1]!) - 1];
          row[col] = parseVal(col, val);
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.toUpperCase().startsWith('NOW()')) {
          row[col] = store.now();
        } else if (tok.startsWith("'")) {
          row[col] = tok.slice(1, tok.endsWith("'") ? -1 : undefined);
        }
      });
      storeRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^update \w+/.test(text.toLowerCase().trim())) {
      const table = /^update (\w+)/.exec(text.toLowerCase())![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(text);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1]!) - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(text);
      if (setMatch && target) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const col = cleanCol(pair.slice(0, eq));
          const ref = pair.slice(eq + 1).trim();
          const dollar = /\$(\d+)/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (dollar) {
            const val = params[Number(dollar[1]!) - 1];
            target[col] = parseVal(col, val);
          } else if (/^now\(\)/i.test(ref)) {
            target[col] = store.now();
          } else if (ref.startsWith("'") && ref.endsWith("'")) {
            target[col] = ref.slice(1, -1);
          }
        }
      }
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }

    if (/select \*/.test(text.toLowerCase())) {
      const tableMatch = /from (\w+)/i.exec(text);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereTail = (/where\s+(.+)$/is.exec(text)?.[1] ?? '').replace(/\s+limit\s+\d+$/i, '');
      let filtered = [...rows];
      for (const clause of whereTail.split(/\s+and\s+/i)) {
        const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
        if (m) {
          const val = params[Number(m[2]!) - 1];
          filtered = filtered.filter((r) => String(r[cleanCol(m[1]!)] ?? '') === String(val ?? ''));
        }
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    pool: { query: queryImpl },
    queryMany: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows),
    queryOne: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    DIVERGENCE_SESSION: 'dvg',
    DIVERGENCE_PREFERENCE: 'dvp',
    MIRROR_WORLD_RUN: 'mwr',
    TRIBUNAL_HEARING: 'trb',
    TRIBUNAL_LESSON: 'tbl',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { recordManualAction, acceptSuggestion, dismissSuggestion, listSuggestions, listManualActions, getDivergenceSession, learnedPatterns, divergenceReport } from '../modules/superpowers/autoDivergence.js';
import { runWhatIf, getMirrorRun, listMirrorRuns, mirrorWorldReport, parseFactor, simulateMirror } from '../modules/superpowers/mirrorWorld.js';
import { conveneTribunal, getHearing, listHearings, listLessons, tribunalReport } from '../modules/superpowers/tribunal.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── AUTO-DIVERGENCE (#12) ──────────────────────────────────────────────────

describe('AUTO-DIVERGENCE — spot the hand-fix, offer to finish it, learn (#12)', () => {
  beforeEach(cleartables);

  it('raises a suggestion once repeated manual actions cross the threshold', async () => {
    const first = await recordManualAction(USER, { verb: 'rename-import', target: 'src/auth' });
    expect(first.observed_count).toBe(1);
    expect(first.remaining_count).toBe(0);
    const second = await recordManualAction(USER, { verb: 'rename-import', target: 'src/auth' });
    expect(second.id).toBe(first.id);
    expect(second.observed_count).toBe(2);
    expect(second.remaining_count).toBe(6);
    expect(AUDIT_ACTIONS()).toContain('autonomy.divergence_hint_raised');
    expect(await listSuggestions(USER)).toHaveLength(1);
  });

  it('learns from your yes: acceptance raises verb affinity on every hit', async () => {
    await recordManualAction(USER, { verb: 'rename-import', target: 'src/auth' });
    await recordManualAction(USER, { verb: 'rename-import', target: 'src/auth' });
    const a = await acceptSuggestion(USER, (await listManualActions(USER))[0]!.id);
    expect(a.status).toBe('APPLIED');
    expect(a.accepted).toBe(true);
    expect(AUDIT_ACTIONS()).toContain('autonomy.divergence_hint_accepted');

    await recordManualAction(USER, { verb: 'rename-import', target: 'src/payments' });
    await recordManualAction(USER, { verb: 'rename-import', target: 'src/payments' });
    const payments = (await listManualActions(USER)).find((s) => s.target === 'src/payments')!;
    await acceptSuggestion(USER, payments.id);

    const patterns = await learnedPatterns(USER);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.verb).toBe('rename-import');
    expect(patterns[0]!.affinity).toBeCloseTo(0.7, 5);
    expect(patterns[0]!.record_count).toBe(2);
  });

  it('learns from your no: dismissal lowers affinity and lets a clean path reopen', async () => {
    await recordManualAction(USER, { verb: 'rename-param', target: 'cart' });
    await recordManualAction(USER, { verb: 'rename-param', target: 'cart' });
    const d = await dismissSuggestion(USER, (await listManualActions(USER))[0]!.id);
    expect(d.status).toBe('DISMISSED');
    expect(d.accepted).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('autonomy.divergence_hint_dismissed');

    await recordManualAction(USER, { verb: 'rename-param', target: 'checkout' });
    await recordManualAction(USER, { verb: 'rename-param', target: 'checkout' });
    const checkout = (await listManualActions(USER)).find((s) => s.target === 'checkout')!;
    await dismissSuggestion(USER, checkout.id);

    expect((await learnedPatterns(USER))[0]!.affinity).toBeCloseTo(0.3, 5);
  });

  it('persists, reports the favorite verb, and stays owner-scoped', async () => {
    await recordManualAction(USER, { verb: 'rename-import', target: 'src/auth' });
    await recordManualAction(USER, { verb: 'rename-import', target: 'src/auth' });
    await recordManualAction(USER, { verb: 'fix-typo', target: 'docs' });
    const sessions = await listManualActions(USER);
    const renameSession = sessions.find((s) => s.verb === 'rename-import');
    const typoSession = sessions.find((s) => s.verb === 'fix-typo');
    expect(renameSession).toBeDefined();
    expect(typoSession).toBeDefined();
    await acceptSuggestion(USER, renameSession!.id);
    expect(sessions).toHaveLength(2);
    const report = await divergenceReport(USER);
    expect(report.applied).toBe(1);
    expect(report.dismissed).toBe(0);
    expect(report.favorite_verb).toBe('rename-import');
    await expect(getDivergenceSession(OTHER, sessions[0]!.id)).rejects.toThrow(/divergence_session_not_found/);
    await expect(recordManualAction(USER, { verb: '', target: 'x' })).rejects.toThrow(AppError);
    await expect(acceptSuggestion(USER, typoSession!.id)).rejects.toThrow(/is not open/);
  });
});

// ── MIRROR WORLD (#15) ─────────────────────────────────────────────────────

describe('MIRROR WORLD — what-ifs answered with real numbers (#15)', () => {
  beforeEach(cleartables);

  it('parses multipliers like "10x" and rejects nonsense', () => {
    expect(parseFactor('10x')).toBe(10);
    expect(parseFactor('1.5x')).toBe(1.5);
    expect(parseFactor('12')).toBe(12);
    expect(parseFactor(3)).toBe(3);
    expect(() => parseFactor('everything')).toThrow(/multiplier/);
    expect(() => parseFactor('0x')).toThrow(/multiplier/);
  });

  it('simulates load so a 10x traffic question is no longer a vibe', () => {
    const m = simulateMirror('traffic', 10);
    expect(m.latency_ms).toBe(240);
    expect(m.error_rate).toBeCloseTo(0.4, 5);
    expect(m.cpu_pct).toBe(90);
    expect(m.memory_mb).toBe(1792);
    expect(m.verdict).toBe('at-risk');
    const f = simulateMirror('dependency', 1);
    expect(f.latency_ms).toBe(1200);
    expect(f.error_rate).toBe(72);
    expect(f.verdict).toBe('critical');
  });

  it('spins the clone and reports the run with an audit trail', async () => {
    const run = await runWhatIf(USER, { question: 'What if we 10x traffic?', scenario: 'traffic', parameter: '10x' });
    expect(run.id).toMatch(/^mwr-/);
    expect(run.latency_ms).toBe(240);
    expect(run.notes).toContain('240ms');
    expect(run.status).toBe('COMPLETED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.mirror_world_run');
  });

  it('persists, reports averages, and stays owner-scoped', async () => {
    await runWhatIf(USER, { question: 'What if we 10x traffic?', scenario: 'traffic', parameter: '10x' });
    const dep = await runWhatIf(USER, { question: 'What if the auth service goes down?', scenario: 'dependency', parameter: 1 });
    expect(await listMirrorRuns(USER)).toHaveLength(2);
    const report = await mirrorWorldReport(USER);
    expect(report.avg_latency).toBe(720);
    expect(report.critical_share).toBe(50);
    expect(report.traffic_runs).toBe(1);
    expect(report.failure_runs).toBe(1);
    await expect(getMirrorRun(OTHER, dep.id)).rejects.toThrow(/mirror_world_run_not_found/);
    await expect(runWhatIf(USER, { question: '', scenario: 'traffic', parameter: 1 })).rejects.toThrow(AppError);
    await expect(runWhatIf(USER, { question: 'What if we 10x traffic?', scenario: 'shuffle', parameter: 1 })).rejects.toThrow(/mirror world supports/);
  });
});

// ── TRIBUNAL (#18) ─────────────────────────────────────────────────────────

describe('TRIBUNAL — the test suite is the judge (#18)', () => {
  beforeEach(cleartables);

  it('routes a high-stakes change to several models and lets tests pick the winner', async () => {
    const hearing = await conveneTribunal(USER, {
      change: 'atomic refactor of the payments state machine',
      models: ['alpha', 'beta', 'gamma'],
      candidates: [
        { model: 'alpha', solution: 'A-safe', passed: true, score: 90 },
        { model: 'beta', solution: 'B-strategy', passed: true, score: 95 },
        { model: 'gamma', solution: 'G-revery', passed: false, score: 20 },
      ],
    });
    expect(hearing.id).toMatch(/^trb-/);
    expect(hearing.status).toBe('RESOLVED');
    expect(hearing.verdict).toContain('signed off by beta');
    expect(hearing.models).toHaveLength(3);
    expect(hearing.candidates).toHaveLength(3);
    expect(AUDIT_ACTIONS()).toContain('autonomy.tribunal_convened');
    expect(AUDIT_ACTIONS()).toContain('autonomy.tribunal_resolved');
  });

  it('logs losing attempts as lessons, never discards them', async () => {
    await conveneTribunal(USER, {
      change: 'auth boundary hardening',
      models: ['alpha', 'beta', 'gamma'],
      candidates: [
        { model: 'alpha', solution: 'A-safe', passed: true, score: 90 },
        { model: 'beta', solution: 'B-strategy', passed: true, score: 95 },
        { model: 'gamma', solution: 'G-revery', passed: false, score: 20 },
      ],
    });
    const lessons = await listLessons(USER);
    expect(lessons).toHaveLength(2);
    expect(lessons.map((l) => l.losing_models[0])).toEqual(expect.arrayContaining(['alpha', 'gamma']));
    expect(lessons.some((l) => l.lesson.includes('did not pass'))).toBe(true);
    expect(AUDIT_ACTIONS().filter((a) => a === 'autonomy.tribunal_lesson_logged')).toHaveLength(2);
  });

  it('reports no winner honestly when nothing passes', async () => {
    const hearing = await conveneTribunal(USER, {
      change: 'replacing the queue core',
      models: ['alpha', 'beta'],
      candidates: [
        { model: 'alpha', solution: 'A', passed: false, score: 40 },
        { model: 'beta', solution: 'B', passed: false, score: 30 },
      ],
    });
    expect(hearing.verdict).toBe('no_candidate_passed');
    expect(await listLessons(USER)).toHaveLength(2);
  });

  it('persists, reports, validates, and stays owner-scoped', async () => {
    const h1 = await conveneTribunal(USER, {
      change: 'atomic refactor of the payments state machine',
      models: ['alpha', 'beta'],
      candidates: [
        { model: 'alpha', solution: 'A-safe', passed: true, score: 90 },
        { model: 'beta', solution: 'B-strategy', passed: true, score: 95 },
      ],
    });
    await conveneTribunal(USER, {
      change: 'auth boundary hardening',
      models: ['gamma', 'delta'],
      candidates: [
        { model: 'gamma', solution: 'G-revery', passed: false, score: 20 },
        { model: 'delta', solution: 'D-scan', passed: true, score: 80 },
      ],
    });
    expect(await listHearings(USER)).toHaveLength(2);
    const report = await tribunalReport(USER);
    expect(report.resolved).toBe(2);
    expect(report.lessons).toBe(2);
    expect(report.winners).toEqual({ beta: 1, delta: 1 });
    await expect(getHearing(OTHER, h1.id)).rejects.toThrow(/tribunal_hearing_not_found/);
    await expect(conveneTribunal(USER, { change: '', models: ['alpha', 'beta'], candidates: [] })).rejects.toThrow(AppError);
    await expect(conveneTribunal(USER, { change: 'x', models: ['alpha'], candidates: [] })).rejects.toThrow(/at least 2 models/);
    await expect(
      conveneTribunal(USER, {
        change: 'x',
        models: ['alpha', 'beta'],
        candidates: [
          { model: 'alpha', solution: 'A', passed: true, score: 90 },
          { model: 'zeta', solution: 'Z', passed: true, score: 80 },
        ],
      }),
    ).rejects.toThrow(/did not get a seat/);
  });
});