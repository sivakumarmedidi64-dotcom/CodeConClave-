/**
 * CodeConClave — Stage 82 SUPERPOWERS Tranche D: intelligence & org-health.
 *
 *   COWORK REPLAY        (#163) — sessions pin a task's event seq; fork copies
 *                              the real event log into a new task.
 *   ORACLE               (#14)  — deterministic risk score
 *                              (0.40*complexity + 0.35*churn + 0.25*failures)
 *                              persisted one-per (owner, target).
 *   ANOMALY HUNTER       (#46)  — determinism: reader-named mutator, hollow
 *                              test claims, claimed-but-missing guards.
 *   STANDUP FROM REALITY (#136) — daily digest built from actual artifacts.
 *   ENGINEERING SIXTH SENSE (#155) — GREEN/YELLOW/RED computed from live rows.
 *
 * DB/audit/ids are mocked; analysis + scoring logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
const store = vi.hoisted(() => {
  const tables = {
    agent_events: [] as Array<Record<string, unknown>>,
    fix_tickets: [] as Array<Record<string, unknown>>,
    anomaly_scans: [] as Array<Record<string, unknown>>,
    risk_scores: [] as Array<Record<string, unknown>>,
    replay_sessions: [] as Array<Record<string, unknown>>,
    standup_reports: [] as Array<Record<string, unknown>>,
    health_signals: [] as Array<Record<string, unknown>>,
  };
  return { tables, now: () => new Date().toISOString() };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  const mark = { next: () => `id-${++n}` };
  return { recordAuditMock, mark };
});

const dbMock = vi.hoisted(() => {
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '').replace(/[`"']/g, '');
  }
  function parseVal(col: string, val: unknown): unknown {
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { return JSON.parse(val); } catch { return val; }
    }
    if (col === 'payload' || col === 'summary' || col === 'components' || col === 'evidence' || col === 'findings' || col === 'reasons' || col === 'generated') {
      if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
    }
    return val;
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const q = text;
    const lq = q.toLowerCase().trim();
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\)]+)\)\s*values\s*\((.*)\)/is.exec(q);
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
        } else if (tok.toUpperCase().startsWith("NOW()")) {
          row[col] = store.now();
        } else if (tok.startsWith("' ") || tok.startsWith("'" )) {
          row[col] = tok.slice(1, tok.endsWith("'") ? -1 : undefined);
        }
      });
      storeRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^update \w+/.test(lq)) {
      const table = /^update (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(q);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1])! - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1])! - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(q);
      if (setMatch && target) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
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
      return { rows: target ? [target] : [], rowCount: 1 };
    }

    if (/^delete from \w+/.test(lq)) {
      const table = /^delete from (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(q);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const idx = rows.findIndex((r) => r.id === String(params[Number(idRef?.[1] ?? 0) - 1]));
      if (idx < 0) return { rows: [], rowCount: 0 };
      if (ownerRef && String(rows[idx]!.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const [removed] = rows.splice(idx, 1);
      return { rows: removed ? [removed] : [], rowCount: 1 };
    }

    if (/select \*/.test(lq)) {
      const tableMatch = /from (\w+)/i.exec(q);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+?)$/is.exec(q);
      let filtered = [...rows];
      if (whereMatch) {
        for (const clause of whereMatch[1]!.split(/\s+and\s+/i)) {
          const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
          if (!m) continue;
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
    queryMany: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows),
    queryOne: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    AGENT_EVENT: 'aev',
    TASK: 'tsk',
    REPLAY_SESSION: 'rpl',
    RISK_SCORE: 'rsk',
    ANOMALY_SCAN: 'axm',
    STANDUP_REPORT: 'std',
    HEALTH_SIGNAL: 'hrs',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

// ---------------------------------------------------------------------------
import { computeRiskBand, upsertRiskScore, listRiskScores, getRiskScore, removeRiskScore } from '../modules/superpowers/oracle.js';
import { createReplaySession, listReplaySessions, getReplaySession, archiveReplaySession, forkReplaySession } from '../modules/superpowers/replay.js';
import {
  runAnomalyScan, getAnomalyScan, listAnomalyScans, closeAnomalyScan,
  detectReaderThatMutates, detectHollowTestClaims, detectMissingGuard,
} from '../modules/superpowers/anomalyHunter.js';
import { generateStandup, getStandupReport, listStandupReports, publishStandupReport, type StandupReportRow } from '../modules/superpowers/standup.js';
import { computeHealthSignal, getHealthSignal } from '../modules/superpowers/healthSignal.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';
const DAY = '2026-09-13';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

function seedEvent(owner: string, taskId: string, seq: number, kind: string, createdAt?: string, path?: string, patch?: string, payload: Record<string, unknown> = {}) {
  store.tables.agent_events.push({
    id: `aev_seed_${seq}`, owner_id: owner, project_id: null, task_id: taskId, run_id: null,
    seq, kind, path: path ?? null, patch: patch ?? null, payload,
    source_uid: null, created_at: createdAt ?? `${DAY}T09:00:00.000Z`,
  });
}

function seedFix(owner: string, status: string, title = 'fix') {
  store.tables.fix_tickets.push({
    id: `fxt_${status}_${title}`, owner_id: owner, project_id: null, source: 'ci_failure', issue: title,
    ref: null, status, title, error_snippet: null, pr_url: null, proof_claim_id: null,
    created_at: `${DAY}T08:00:00.000Z`, updated_at: `${DAY}T08:00:00.000Z`,
  });
}

function seedAnomaly(owner: string, verdict: string, status = 'OPEN', rule = 'RULE') {
  store.tables.anomaly_scans.push({
    id: `axm_${verdict}_${rule}`, owner_id: owner, project_id: null, target_type: 'CODE',
    target_path: 'src/x.ts', verdict, findings: [{ rule, evidence: 'e', why: 'w', suggestion: 's' }],
    status, created_at: `${DAY}T08:00:00.000Z`, updated_at: `${DAY}T08:00:00.000Z`,
  });
}

function seedRisk(owner: string, band: string, score: number, path = 'src/rates.ts') {
  store.tables.risk_scores.push({
    id: `rsk_${band}_${path}`, owner_id: owner, project_id: null, target_type: 'FILE', target_path: path,
    complexity_score: 0.5, churn_score: 0.5, failure_links: 1, risk_score: score, risk_band: band,
    reasons: [], created_at: `${DAY}T08:00:00.000Z`, updated_at: `${DAY}T08:00:00.000Z`,
  });
}

describe('ORACLE — risk ranking (#14)', () => {
  beforeEach(cleartables);

  it('scores with the documented formula: complexity + churn + failures', () => {
    const low = computeRiskBand(0.1, 0.1, 0);
    expect(low.score).toBeCloseTo(0.08, 2);
    expect(low.band).toBe('LOW');
    expect(computeRiskBand(1, 1, 1).score).toBe(1);
    expect(computeRiskBand(1, 1, 1).band).toBe('CRITICAL');
    expect(computeRiskBand(0.8, 0.6, 0.4).band).toBe('HIGH');
    expect(computeRiskBand(0.6, 0.5, 0.2).band).toBe('MEDIUM');
  });

  it('clamps inputs out of range and floors negative failure counts', async () => {
    const r = await upsertRiskScore(USER, { targetType: 'FUNCTION', targetPath: 'auth/login', complexityScore: 5, churnScore: -3, failureLinks: 7 });
    expect(r.complexity_score).toBe(1);
    expect(r.churn_score).toBe(0);
    expect(r.failure_links).toBe(7);
    expect(r.risk_score).toBe(0.65);
    expect(r.risk_band).toBe('HIGH');
  });

  it('upserts one entry per (owner, target) — recompute updates, never duplicates', async () => {
    const a = await upsertRiskScore(USER, { targetType: 'FILE', targetPath: 'src/rates.ts', complexityScore: 0.4, churnScore: 0.3, failureLinks: 0 });
    const b = await upsertRiskScore(USER, { targetType: 'FILE', targetPath: 'src/rates.ts', complexityScore: 1, churnScore: 1, failureLinks: 12 });
    expect(b.id).toBe(a.id);
    expect(b.risk_score).toBe(1);
    const all = await listRiskScores(USER);
    expect(all.length).toBe(1);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'risk_score.computed' }));
  });

  it('lists sorted by risk descending and filters by band', async () => {
    await upsertRiskScore(USER, { targetType: 'FILE', targetPath: 'a.ts', complexityScore: 0.1, churnScore: 0.1, failureLinks: 0 });
    await upsertRiskScore(USER, { targetType: 'FILE', targetPath: 'b.ts', complexityScore: 0.9, churnScore: 0.9, failureLinks: 4 });
    await upsertRiskScore(USER, { targetType: 'FILE', targetPath: 'c.ts', complexityScore: 0.55, churnScore: 0.55, failureLinks: 1 });
    const all = await listRiskScores(USER);
    expect(all.map((r) => r.target_path)).toEqual(['b.ts', 'c.ts', 'a.ts']);
    const high = await listRiskScores(USER, { band: 'HIGH' });
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((r) => r.risk_band === 'HIGH')).toBe(true);
  });

  it('removes a risk score and refuses cross-owner access', async () => {
    const r = await upsertRiskScore(USER, { targetType: 'FILE', targetPath: 'gone.ts', complexityScore: 0.6, churnScore: 0.6, failureLinks: 2 });
    await expect(getRiskScore(OTHER, r.id)).rejects.toThrow(AppError);
    await removeRiskScore(USER, r.id);
    await expect(getRiskScore(USER, r.id)).rejects.toThrow(AppError);
    await expect(removeRiskScore(OTHER, r.id)).rejects.toThrow(AppError);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'risk_score.removed' }));
  });

  it('rejects invalid input', async () => {
    await expect(upsertRiskScore(USER, { targetType: 'WIDGET' as never, targetPath: 'x.ts', complexityScore: 0.1, churnScore: 0.1, failureLinks: 0 })).rejects.toThrow(AppError);
    await expect(upsertRiskScore(USER, { targetType: 'FILE', targetPath: '   ', complexityScore: 0.1, churnScore: 0.1, failureLinks: 0 })).rejects.toThrow(AppError);
  });
});

describe('COWORK REPLAY — replayable forkable timeline (#163)', () => {
  beforeEach(cleartables);

  it('pins a task at its latest event seq', async () => {
    seedEvent(USER, 't1', 1, 'task_created');
    seedEvent(USER, 't1', 2, 'file_changed', DAY + 'T10:00:00.000Z');
    const s = await createReplaySession(USER, { taskId: 't1', note: 'first pass' });
    expect(s.base_seq).toBe(2);
    expect(s.status).toBe('ACTIVE');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay_session.created' }));
  });

  it('pins base_seq 0 when the task has no events yet', async () => {
    const s = await createReplaySession(USER, { taskId: 't-empty' });
    expect(s.base_seq).toBe(0);
  });

  it('lists newest-first and archives close the session (idempotent)', async () => {
    const a = await createReplaySession(USER, { taskId: 'ta' });
    const b = await createReplaySession(USER, { taskId: 'tb' });
    const list = await listReplaySessions(USER);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    await archiveReplaySession(USER, a.id, 'done reviewing');
    expect((await getReplaySession(USER, a.id)).status).toBe('ARCHIVED');
    expect((await getReplaySession(USER, a.id)).note).toBe('done reviewing');
    const again = await archiveReplaySession(USER, a.id);
    expect(again.status).toBe('ARCHIVED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay_session.archived' }));
  });

  it('forks by copying the exact event log into a brand-new task', async () => {
    seedEvent(USER, 'T-src', 1, 'task_created', DAY + 'T09:00:00.000Z', 'a.ts', '@@ -1 +1 @@');
    seedEvent(USER, 'T-src', 2, 'file_changed', DAY + 'T09:05:00.000Z', 'b.ts', 'patch-b', { mode: 'write' });
    seedEvent(USER, 'T-src', 3, 'checkpoint_created', DAY + 'T09:10:00.000Z', null, null);
    const src = await createReplaySession(USER, { taskId: 'T-src' });
    const fork = await forkReplaySession(USER, src.id);

    expect(fork.forked_from_task).toBe('T-src');
    expect(fork.task_id).not.toBe('T-src');
    expect(fork.base_seq).toBe(3);
    const copied = store.tables.agent_events.filter((e) => e.task_id === fork.task_id);
    expect(copied.length).toBe(3);
    expect(copied.map((e) => e.kind)).toEqual(['task_created', 'file_changed', 'checkpoint_created']);
    expect(copied.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(copied[1]!.patch).toBe('patch-b');
    expect(copied[1]!.payload).toEqual({ mode: 'write' });
    // Original event log untouched
    expect(store.tables.agent_events.filter((e) => e.task_id === 'T-src').length).toBe(3);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'replay_session.forked' }));
  });

  it('refuses to fork an archived session and enforces owner scope', async () => {
    seedEvent(USER, 'T-x', 1, 'file_changed');
    const s = await createReplaySession(USER, { taskId: 'T-x' });
    await archiveReplaySession(USER, s.id);
    await expect(forkReplaySession(USER, s.id)).rejects.toThrow(AppError);
    const other = await createReplaySession(USER, { taskId: 'T-y' });
    await expect(getReplaySession(OTHER, other.id)).rejects.toThrow(AppError);
  });
});

describe('ANOMALY HUNTER — code truth vs code claims (#46)', () => {
  beforeEach(cleartables);

  it('flags a getter-named function that deletes rows', () => {
    const code = 'function getUser(id) {\n  await db.users.delete(id);\n  return {};\n}';
    const hits = detectReaderThatMutates(code);
    expect(hits[0]!.rule).toBe('READER_THAT_MUTATES');
    expect(hits[0]!.evidence).toContain('getUser');
    expect(detectReaderThatMutates('function getUser(id) { return users.find(id); }')).toEqual([]);
  });

  it('flags tests that claim a behavior but assert nothing', () => {
    const hollow = "it('returns the full total', () => { sum(1, 2); });";
    expect(detectHollowTestClaims(hollow).length).toBe(1);
    const honest = "it('returns the full total', () => { expect(sum(1, 2)).toBe(3); });";
    expect(detectHollowTestClaims(honest)).toEqual([]);
  });

  it('flags a comment claiming a guard the body never implements', () => {
    const code = "// validates that the payload is signed\nexport function accept(data) { store.push(data); }";
    expect(detectMissingGuard(code).length).toBe(1);
    const guarded = "// validates that the payload is signed\nexport function accept(data) { if (!data.sig) return null; store.push(data); }";
    expect(detectMissingGuard(guarded)).toEqual([]);
  });

  it('runs a scan, stores findings and audits it', async () => {
    const scan = await runAnomalyScan(USER, {
      targetType: 'CODE',
      code: 'function getToken(t) { delete cache[t]; return null; }',
    });
    expect(scan.verdict).toBe('FLAGGED');
    expect(scan.findings[0]!.rule).toBe('READER_THAT_MUTATES');
    expect(scan.status).toBe('OPEN');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'anomaly_scan.completed' }));
  });

  it('grades clean code CLEAN and rejects empty input', async () => {
    const scan = await runAnomalyScan(USER, { targetType: 'TEST', code: 'it(\'passes\', () => { expect(true).toBe(true); });' });
    expect(scan.verdict).toBe('CLEAN');
    await expect(runAnomalyScan(USER, { targetType: 'CODE', code: '  ' })).rejects.toThrow(AppError);
  });

  it('lists with filters and closes opens scans once', async () => {
    await runAnomalyScan(USER, { targetType: 'CODE', code: 'function getX() { delete this.x; }' });
    await runAnomalyScan(USER, { targetType: 'TEST', code: 'it(\'ok\', () => {});' });
    const flagged = await listAnomalyScans(USER, { verdict: 'FLAGGED' });
    expect(flagged.length).toBe(1);
    const closed = await closeAnomalyScan(USER, flagged[0]!.id, 'RESOLVED');
    expect(closed.status).toBe('RESOLVED');
    const again = await closeAnomalyScan(USER, flagged[0]!.id, 'DISMISSED');
    expect(again.status).toBe('RESOLVED');
    await expect(getAnomalyScan(OTHER, flagged[0]!.id)).rejects.toThrow(AppError);
  });
});

describe('STANDUP FROM REALITY — the daily digest (#136)', () => {
  beforeEach(cleartables);

  it('builds the digest from real artifacts partitioned by day', async () => {
    seedEvent(USER, 't1', 1, 'task_created');
    seedEvent(USER, 't1', 2, 'file_changed', DAY + 'T10:11:00.000Z');
    seedEvent(USER, 't1', 3, 'file_changed', '2026-09-09T10:00:00.000Z'); // other day — excluded
    seedFix(USER, 'OPEN', 'Fix login drift');
    seedFix(USER, 'RESOLVED', 'Fix billing idempotency');
    seedAnomaly(USER, 'FLAGGED');
    seedRisk(USER, 'HIGH', 0.62);

    const report = await generateStandup(USER, { date: DAY });
    const s = report.summary;
    expect(s.date).toBe(DAY);
    expect(s.events.total).toBe(2);
    expect(s.events.file_changed).toBe(1);
    expect(s.fix_tickets.OPEN).toBe(1);
    expect(s.fix_tickets.RESOLVED).toBe(1);
    expect(s.anomalies.FLAGGED).toBe(1);
    expect(s.risks.HIGH).toBe(1);
    expect(s.top_fix_titles).toContain('Fix login drift');
    expect(report.status).toBe('DRAFT');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'standup_report.generated' }));
  });

  it('regenerate for the same day UPDATES (no duplicates), new days create new reports', async () => {
    const a = await generateStandup(USER, { date: DAY });
    seedEvent(USER, 't2', 1, 'checkpoint_created', DAY + 'T12:00:00.000Z');
    const b = await generateStandup(USER, { date: DAY });
    expect(b.id).toBe(a.id);
    expect(b.summary.events.total).toBe(1);
    const next = await generateStandup(USER, { date: '2026-09-14' });
    expect(next.id).not.toBe(a.id);
    expect((await listStandupReports(USER)).length).toBe(2);
  });

  it('publishes a report once and preserves owner scope', async () => {
    const report = await generateStandup(USER, { date: DAY });
    const published = await publishStandupReport(USER, report.id);
    expect(published.status).toBe('PUBLISHED');
    expect((await publishStandupReport(USER, report.id)).status).toBe('PUBLISHED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'standup_report.published' }));
    await expect(getStandupReport(OTHER, report.id)).rejects.toThrow(AppError);
    await expect(generateStandup(OTHER, { date: DAY })).resolves.toBeTruthy();
  });

  it('lists by status and date', async () => {
    await generateStandup(USER, { date: DAY });
    await generateStandup(USER, { date: '2026-09-14' });
    const drafts = await listStandupReports(USER, { status: 'DRAFT' });
    expect(drafts.length).toBe(2);
    const one = await listStandupReports(USER, { date: '2026-09-14' });
    expect(one.length).toBe(1);
    expect(one[0]!.report_date).toBe('2026-09-14');
  });
});

describe('ENGINEERING SIXTH SENSE — single truthful signal (#155)', () => {
  beforeEach(cleartables);

  it('is GREEN when nothing is at risk', async () => {
    const sig = await computeHealthSignal(USER, { scope: 'PROJECT' });
    expect(sig.verdict).toBe('GREEN');
    expect(sig.evidence.length).toBeGreaterThan(0);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'health_signal.refreshed' }));
  });

  it('turns YELLOW on a HIGH risk and RED on a CRITICAL risk', async () => {
    seedRisk(USER, 'HIGH', 0.62);
    expect((await computeHealthSignal(USER)).verdict).toBe('YELLOW');
    seedRisk(USER, 'CRITICAL', 0.9, 'src/auth/tokens.ts');
    expect((await computeHealthSignal(USER)).verdict).toBe('RED');
    const sig = await getHealthSignal(USER);
    expect(sig!.components).toMatchObject({ risks: { HIGH: 1, CRITICAL: 1 } });
  });

  it('turns RED on >= 3 open fix tickets and YELLOW on open flagged anomalies', async () => {
    ['a', 'b', 'c'].forEach((t) => seedFix(USER, 'OPEN', `fix ${t}`));
    expect((await computeHealthSignal(USER)).verdict).toBe('RED');
    cleartables();
    seedFix(USER, 'OPEN', 'one open fix');
    seedAnomaly(USER, 'FLAGGED');
    expect((await computeHealthSignal(USER)).verdict).toBe('YELLOW');
  });

  it('resolved work returns the signal to GREEN and stays owner-scoped', async () => {
    seedRisk(USER, 'CRITICAL', 0.95);
    expect((await computeHealthSignal(USER)).verdict).toBe('RED');
    cleartables();
    seedRisk(USER, 'LOW', 0.1);
    expect((await computeHealthSignal(USER)).verdict).toBe('GREEN');
    const other = await computeHealthSignal(OTHER, { scope: 'PROJECT' });
    expect(other.verdict).toBe('GREEN');
    expect(other.components.open_fix_tickets).toBe(0);
  });
});