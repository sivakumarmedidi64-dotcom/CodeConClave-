/**
 * CodeConClave — Stage 93 SUPERPOWERS Tranche O: Root Cause Oracle, Ghost
 * Writer, Time Traveler, Code Court, Silence Breaker.
 *
 *   ROOT CAUSE ORACLE (#19) — symptom -> causal chain -> true origin, with
 *                             confidence at every hop and alternatives ruled out.
 *   GHOST WRITER (#20)      — a shadow implementation A/B tests architectural
 *                             approaches with benchmark numbers, not opinion.
 *   TIME TRAVELER (#21)     — reconstructs historical context and diffs it
 *                             against today to show exactly what changed.
 *   CODE COURT (#22)        — prosecutor and defense argue with evidence; the
 *                             judge counts evidence and the verdict is a record.
 *   SILENCE BREAKER (#23)   — zombie tickets get diagnosed and unblocked;
 *                             precise question or reassignment before escalation.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    causal_chains: [] as Array<Record<string, unknown>>,
    ghost_writes: [] as Array<Record<string, unknown>>,
    time_travel_snapshots: [] as Array<Record<string, unknown>>,
    code_court_cases: [] as Array<Record<string, unknown>>,
    stall_breakouts: [] as Array<Record<string, unknown>>,
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
    CAUSAL_CHAIN: 'cac',
    GHOST_WRITE: 'gst',
    TIME_TRAVEL_SNAPSHOT: 'tts',
    CODE_COURT_CASE: 'cct',
    STALL_BREAKOUT: 'stl',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { analyzeSymptom, buildChain, resolveTrace, getCausalChain, listCausalChains, rootCauseReport } from '../modules/superpowers/rootCauseOracle.js';
import { writeGhost, benchmarkGhost, shipGhost, getGhostWrite, listGhostWrites, ghostWriterReport, benchmarkVerdict, structuralDeltas } from '../modules/superpowers/ghostWriter.js';
import { reconstructHistory, computeHistoryDiff, getSnapshot, listSnapshots, timeTravelReport } from '../modules/superpowers/timeTraveler.js';
import { holdCourt, judgeDebate, getCourtCase, listCourtCases, codeCourtReport } from '../modules/superpowers/codeCourt.js';
import { diagnoseStall, diagnoseStallBehavior, resolveStall, getStallBreakout, listStallBreakouts, silenceBreakerReport } from '../modules/superpowers/silenceBreaker.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── ROOT CAUSE ORACLE (#19) ────────────────────────────────────────────────

describe('ROOT CAUSE ORACLE — the chain is the answer (#19)', () => {
  beforeEach(cleartables);

  it('orders causal hops and computes chain confidence', () => {
    const built = buildChain([
      { hop: 'decision', label: 'deferred-validation', note: 'validation moved to the job', confidence: 0.9 },
      { hop: 'service', label: 'payments-service', note: 'accepts the write', confidence: 0.9 },
      { hop: 'human', label: 'aaron', note: 'made the call six months ago', confidence: 0.9 },
      { hop: 'function', label: 'authorize', note: 'assumes the job ran', confidence: 0.9 },
      { hop: 'commit', label: 'abc123', note: 'turned validation off at the edge', confidence: 0.9 },
    ]);
    expect(built.chain.map((c) => c.hop)).toEqual(['service', 'function', 'commit', 'decision', 'human']);
    expect(built.confidence).toBeCloseTo(0.59, 2);
    expect(built.origin).toBe('human:aaron');
  });

  it('walks a symptom to its true origin and files the trace', async () => {
    const trace = await analyzeSymptom(USER, {
      symptom: 'checkout timeouts after 5pm',
      clues: [
        { hop: 'service', label: 'payments-service', note: 'slow under load', confidence: 0.9 },
        { hop: 'function', label: 'authorize', note: 'retries twice', confidence: 0.9 },
        { hop: 'commit', label: 'abc123', note: 'turned validation off at the edge', confidence: 0.9 },
        { hop: 'decision', label: 'deferred-validation', note: 'validation moved to the job', confidence: 0.9 },
        { hop: 'human', label: 'aaron', note: 'made the call six months ago', confidence: 0.9 },
      ],
      ruledOut: ['redis saturation', 'db replica lag'],
    });
    expect(trace.id).toMatch(/^cac-/);
    expect(trace.status).toBe('OPEN');
    expect(trace.verdict).toContain('human:aaron');
    expect(trace.ruled_out).toEqual(['redis saturation', 'db replica lag']);
    expect(AUDIT_ACTIONS()).toContain('autonomy.causal_trace_completed');
  });

  it('persists, resolves, and stays owner-scoped', async () => {
    await analyzeSymptom(USER, {
      symptom: 'checkout timeouts',
      clues: [
        { hop: 'function', label: 'authorize', note: 'assumes the job ran', confidence: 0.9 },
        { hop: 'decision', label: 'deferred-validation', note: 'validation moved', confidence: 0.9 },
      ],
    });
    const second = await analyzeSymptom(USER, {
      symptom: 'empty exports',
      clues: [
        { hop: 'service', label: 'search-service', note: 'serves empty', confidence: 0.8 },
        { hop: 'commit', label: 'd34db33f', note: 'dropped the join', confidence: 0.8 },
      ],
    });
    const resolved = await resolveTrace(USER, second.id, 'restored the join and re-enabled validation');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolution).toContain('restored the join');
    expect(AUDIT_ACTIONS()).toContain('autonomy.causal_trace_resolved');
    await expect(resolveTrace(USER, second.id, 'again')).rejects.toThrow(/already resolved/);
    const report = await rootCauseReport(USER);
    expect(report.open).toBe(1);
    expect(report.resolved).toBe(1);
    expect(report.traces).toBe(2);
    await expect(getCausalChain(OTHER, second.id)).rejects.toThrow(/causal_chain_not_found/);
    await expect(analyzeSymptom(USER, { symptom: '', clues: [] })).rejects.toThrow(AppError);
    await expect(
      analyzeSymptom(USER, {
        symptom: 'x',
        clues: [
          { hop: 'not-a-hop' as never, label: 'y', note: 'z', confidence: 0.5 },
          { hop: 'function', label: 'f', note: 'ff', confidence: 0.8 },
        ],
      }),
    ).rejects.toThrow(/not a valid causal hop/);
  });
});

// ── GHOST WRITER (#20) ─────────────────────────────────────────────────────

describe('GHOST WRITER — A/B testing for architecture (#20)', () => {
  beforeEach(cleartables);

  it('drafts a shadow implementation on its own branch', async () => {
    const write = await writeGhost(USER, { module: 'billing engine', alternative: 'event-sourced billing engine' });
    expect(write.id).toMatch(/^gst-/);
    expect(write.branch).toBe('shadow/billing-engine');
    expect(write.status).toBe('DRAFTED');
    expect(write.verdict).toBeNull();
    expect(structuralDeltas('billing engine', 'event-sourced billing engine')).toEqual({ complexity_delta: 1, maintenance_delta: 1 });
    expect(AUDIT_ACTIONS()).toContain('autonomy.ghost_written');
  });

  it('benchmarks both sides and lets evidence decide the verdict', async () => {
    expect(benchmarkVerdict({ latencyBefore: 200, latencyAfter: 120, throughputBefore: 1000, throughputAfter: 1500 })).toMatch(/shadow wins/);
    expect(benchmarkVerdict({ latencyBefore: 100, latencyAfter: 220, throughputBefore: 1000, throughputAfter: 800 })).toMatch(/tradeoff/);
    const write = await writeGhost(USER, { module: 'billing engine', alternative: 'event-sourced billing engine' });
    const done = await benchmarkGhost(USER, write.id, { latencyBefore: 200, latencyAfter: 120, throughputBefore: 1000, throughputAfter: 1500 });
    expect(done.status).toBe('BENCHMARKED');
    expect(done.verdict).toMatch(/shadow wins/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.ghost_benchmarked');
    await expect(benchmarkGhost(USER, write.id, { latencyBefore: 1, latencyAfter: 2, throughputBefore: 3, throughputAfter: 4 })).rejects.toThrow(/already been benchmarked/);
  });

  it('ships only after benchmark and stays owner-scoped', async () => {
    const fresh = await writeGhost(USER, { module: 'billing engine', alternative: 'event-sourced billing engine' });
    await expect(shipGhost(USER, fresh.id)).rejects.toThrow(/benchmark the shadow/);
    await benchmarkGhost(USER, fresh.id, { latencyBefore: 200, latencyAfter: 180, throughputBefore: 1000, throughputAfter: 900 });
    const second = await writeGhost(USER, { module: 'cart', alternative: 'cart-as-pipeline' });
    const shipped = await shipGhost(USER, fresh.id);
    expect(shipped.status).toBe('SHIPPED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.ghost_shipped');
    await expect(shipGhost(USER, fresh.id)).rejects.toThrow(/already shipped/);
    await expect(getGhostWrite(OTHER, fresh.id)).rejects.toThrow(/ghost_write_not_found/);
    await expect(listGhostWrites(USER)).resolves.toHaveLength(2);
    const report = await ghostWriterReport(USER);
    expect(report.writes).toBe(2);
    expect(report.shipped).toBe(1);
    expect(report.wins).toBe(0);
    await expect(writeGhost(USER, { module: '', alternative: 'x' })).rejects.toThrow(AppError);
  });
});

// ── TIME TRAVELER (#21) ────────────────────────────────────────────────────

describe('TIME TRAVELER — what changed, and why (#21)', () => {
  beforeEach(cleartables);

  it('diffs historical context against today', () => {
    expect(computeHistoryDiff('a\nb\nc', 'a\nb')).toEqual({ added: 1, removed: 0 });
    expect(computeHistoryDiff('a\nb', 'a\nb\nc')).toEqual({ added: 0, removed: 1 });
    expect(computeHistoryDiff('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });

  it('reconstructs a point in time with tests, deps, reasoning, and drift', async () => {
    const snapshot = await reconstructHistory(USER, {
      ref: 'commit-abc',
      file: 'src/payments.ts',
      code: 'def authorize():\n  pass',
      currentCode: 'def authorize():\n  return 1',
      tests: ['test_authorize'],
      dependencies: ['pg'],
      reasoning: 'validation was deferred to the background job',
    });
    expect(snapshot.id).toMatch(/^tts-/);
    expect(snapshot.diff).toEqual({ added: 1, removed: 1 });
    expect(snapshot.tests).toEqual(['test_authorize']);
    expect(snapshot.dependencies).toEqual(['pg']);
    expect(snapshot.reasoning).toContain('deferred to the background job');
    expect(snapshot.summary).toContain('drifts by 2 changed lines');
    expect(snapshot.summary).toContain('commit-abc');
    expect(AUDIT_ACTIONS()).toContain('autonomy.time_travel_reconstructed');
  });

  it('persists, reports total drift, and stays owner-scoped', async () => {
    await reconstructHistory(USER, { ref: 'r1', file: 'a.ts', code: 'x', currentCode: 'y' });
    const s2 = await reconstructHistory(USER, { ref: 'r2', file: 'b.ts', code: 'x\nz', currentCode: 'x' });
    expect(await listSnapshots(USER)).toHaveLength(2);
    const report = await timeTravelReport(USER);
    expect(report.total_drift).toBe(3);
    await expect(getSnapshot(OTHER, s2.id)).rejects.toThrow(/time_travel_snapshot_not_found/);
    await expect(reconstructHistory(USER, { ref: '', file: 'a.ts', code: 'x', currentCode: 'y' })).rejects.toThrow(AppError);
    await expect(reconstructHistory(USER, { ref: 'r3', file: 'a.ts', code: '', currentCode: 'y' })).rejects.toThrow(AppError);
  });
});

// ── CODE COURT (#22) ───────────────────────────────────────────────────────

describe('CODE COURT — disputes become data, not politics (#22)', () => {
  beforeEach(cleartables);

  it('counts evidence, not volume, to rule', () => {
    expect(judgeDebate([
      { side: 'prosecution', argument: 'it breaks retries', evidence: ['outage report', 'trace 1', 'trace 2'] },
      { side: 'defense', argument: 'it handles them', evidence: ['local repro'] },
    ]).verdict).toBe('rejected');
    expect(judgeDebate([
      { side: 'prosecution', argument: 'it breaks retries', evidence: ['trace 1'] },
      { side: 'defense', argument: 'it handles them', evidence: ['local repro', 'load test', 'prod dashboards'] },
    ]).verdict).toBe('admitted');
    expect(judgeDebate([
      { side: 'prosecution', argument: 'a', evidence: ['x'] },
      { side: 'defense', argument: 'b', evidence: ['y'] },
    ]).verdict).toBe('remanded');
  });

  it('holds court and files the verdict as a decision record', async () => {
    const court = await holdCourt(USER, {
      proposal: 'drop the payments queue for an in-process lock',
      arguments: [
        { side: 'prosecution', argument: 'the queue hides retries', evidence: ['trace-1', 'trace-2'] },
        { side: 'defense', argument: 'the lock serializes dangerously', evidence: ['bench'] },
      ],
    });
    expect(court.id).toMatch(/^cct-/);
    expect(court.status).toBe('RULED');
    expect(court.verdict).toBe('rejected');
    expect(court.reasoning).toContain('prosecution carried 2 pieces of evidence');
    expect(AUDIT_ACTIONS()).toContain('autonomy.court_held');
    expect(AUDIT_ACTIONS()).toContain('autonomy.court_ruled');
  });

  it('persists, reports a tie as remanded, and stays owner-scoped', async () => {
    await holdCourt(USER, {
      proposal: 'introduce read replicas',
      arguments: [
        { side: 'prosecution', argument: 'cost', evidence: ['budget'] },
        { side: 'defense', argument: 'scales reads', evidence: ['load-test'] },
      ],
    });
    const win = await holdCourt(USER, {
      proposal: 'add the feature flag',
      arguments: [
        { side: 'prosecution', argument: 'more branches', evidence: ['pr-12'] },
        { side: 'defense', argument: 'safe rollout', evidence: ['incident history', 'team convention'] },
      ],
    });
    expect(win.verdict).toBe('admitted');
    const report = await codeCourtReport(USER);
    expect(report.admitted).toBe(1);
    expect(report.remanded).toBe(1);
    await expect(getCourtCase(OTHER, win.id)).rejects.toThrow(/code_court_case_not_found/);
    await expect(holdCourt(USER, { proposal: '', arguments: [] })).rejects.toThrow(AppError);
    await expect(
      holdCourt(USER, {
        proposal: 'x',
        arguments: [
          { side: 'bystander' as never, argument: 'a', evidence: [] },
          { side: 'defense', argument: 'b', evidence: [] },
        ],
      }),
    ).rejects.toThrow(/not a recognized side/);
  });
});

// ── SILENCE BREAKER (#23) ──────────────────────────────────────────────────

describe('SILENCE BREAKER — zombie tickets die (#23)', () => {
  beforeEach(cleartables);

  it('only reacts after 3+ days of silence, then names the real stall', () => {
    expect(diagnoseStallBehavior(1, [{ kind: 'review', detail: 'waiting on reviewer' }]).status).toBe('MONITORED');
    expect(diagnoseStallBehavior(4, [{ kind: 'review', detail: 'waiting on reviewer' }])).toEqual({ diagnosis: 'waiting on review', action: 'nudge the reviewer', status: 'UNBLOCKED' });
    expect(diagnoseStallBehavior(4, [{ kind: 'requirement', detail: 'unclear scope' }]).action).toBe('escalate one precise question');
    expect(diagnoseStallBehavior(4, [{ kind: 'dependency', detail: 'blocks on kafka' }]).status).toBe('UNBLOCKED');
    expect(diagnoseStallBehavior(4, []).action).toBe('reassign ownership');
  });

  it('diagnoses and unblocks a real zombie task', async () => {
    const stall = await diagnoseStall(USER, {
      task: 'refactor auth middleware',
      stalledDays: 5,
      signals: [{ kind: 'review', detail: 'PR is waiting for a second reviewer' }],
    });
    expect(stall.id).toMatch(/^stl-/);
    expect(stall.status).toBe('UNBLOCKED');
    expect(stall.diagnosis).toBe('waiting on review');
    expect(stall.action).toBe('nudge the reviewer');
    expect(AUDIT_ACTIONS()).toContain('autonomy.silence_break_diagnosed');
  });

  it('resolves, reports, and stays owner-scoped', async () => {
    await diagnoseStall(USER, { task: 'migrate tls certs', stalledDays: 6, signals: [{ kind: 'requirement', detail: 'which env?' }] });
    const second = await diagnoseStall(USER, { task: 'refactor auth middleware', stalledDays: 4, signals: [{ kind: 'review', detail: 'needs reviewer' }] });
    const resolved = await resolveStall(USER, second.id, 'second reviewer assigned; merged');
    expect(resolved.status).toBe('RESOLVED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.silence_break_resolved');
    await expect(resolveStall(USER, second.id, 'again')).rejects.toThrow(/already resolved/);
    const report = await silenceBreakerReport(USER);
    expect(report.stalls).toBe(2);
    expect(report.resolved).toBe(1);
    expect(report.escalated).toBe(1);
    await expect(getStallBreakout(OTHER, second.id)).rejects.toThrow(/stall_breakout_not_found/);
    await expect(diagnoseStall(USER, { task: '', stalledDays: 1, signals: [] })).rejects.toThrow(AppError);
    await expect(diagnoseStall(USER, { task: 'x', stalledDays: -1, signals: [] })).rejects.toThrow(/non-negative/);
  });
});