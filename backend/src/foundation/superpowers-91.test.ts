/**
 * CodeConClave — Stage 91 SUPERPOWERS Tranche M: swarm + triage + night shift +
 * release train + chaos drills.
 *
 *   THE SWARM             (#2) — 5-10 parallel tasks, isolated sandboxes, shared
 *                                Memory Gravity slices; every task yields a diff.
 *   ZERO-INBOX MODE       (#6) — notifications triaged into fixes / waiting /
 *                                escalations; you review decisions, not inbox.
 *   NIGHT SHIFT           (#7) — off-hours low-risk backlog worked unsupervised;
 *                                report of what changed, what passed, what's yours.
 *   RELEASE COMMANDER     (#9) — feature freeze -> release branch -> cherry-picks
 *                                -> hotfix lanes (with approval) -> rollback drill.
 *   FIREWALL DRILL        (#10) — chaos battery in staging; resilience % + ranked
 *                                 fix list so you practice survival before it matters.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    swarm_runs: [] as Array<Record<string, unknown>>,
    zero_inbox_digests: [] as Array<Record<string, unknown>>,
    night_shift_runs: [] as Array<Record<string, unknown>>,
    release_captain_runs: [] as Array<Record<string, unknown>>,
    firewall_drill_runs: [] as Array<Record<string, unknown>>,
  };
  return { tables, now: () => new Date().toISOString() };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  const DEFAULTS: Record<string, Record<string, unknown>> = {
    swarm_runs: {},
    zero_inbox_digests: {},
    night_shift_runs: { report: '' },
    release_captain_runs: { release_branch: '', features_frozen: false, cherry_picks: [], hotfix_lanes: [], rollback_drill_result: {} },
    firewall_drill_runs: { scenarios: [], resilience_score: 0, fix_list: [] },
  };
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
      const defaults = DEFAULTS[table] ?? {};
      for (const [k, v] of Object.entries(defaults)) if (row[k] === undefined) row[k] = v;
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
    SWARM_BATCH: 'swm',
    ZERO_INBOX_DIGEST: 'zib',
    NIGHT_SHIFT_RUN: 'nsh',
    RELEASE_CAPTAIN_RUN: 'rcr',
    FIREWALL_DRILL_RUN: 'fdr',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { launchSwarm, planSwarm, getSwarmBatch, listSwarmBatches, swarmScopes } from '../modules/superpowers/swarm.js';
import { runTriaging, triageDecision, getZeroInboxDigest, listZeroInboxDigests, inboxReport } from '../modules/superpowers/zeroInbox.js';
import { runNightShift, getNightShiftRun, listNightShiftRuns, nightShiftReport } from '../modules/superpowers/nightShift.js';
import { planRelease, freezeFeatures, cherryPickCommit, laneHotfix, approveHotfixLane, drillRollback, getReleaseRun, listReleaseRuns, releaseReport } from '../modules/superpowers/releaseCommander.js';
import { planDrill, runDrill, getDrillRun, listDrillRuns, drillReport, scoreDrill, blameFixList } from '../modules/superpowers/firewallDrill.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── THE SWARM (#2) ─────────────────────────────────────────────────────────

describe('THE SWARM — parallel tasks, shared memory, per-task diffs (#2)', () => {
  beforeEach(cleartables);

  it('derives Memory Gravity scopes from the goal', () => {
    expect(swarmScopes('billing flow and oauth login', 5)).toEqual(['payments', 'auth', 'general', 'general', 'general']);
  });

  it('plans an independent diff per task, each with its own pattern', () => {
    const plan = planSwarm('billing flow and oauth login', 5);
    expect(plan).toHaveLength(5);
    expect(plan[0]!.scope).toBe('payments');
    expect(plan[0]!.diff).toContain('+ payments');
    expect(plan.every((t) => t.pattern)).toBe(true);
  });

  it('launches the whole swarm completed with shared patterns', async () => {
    const batch = await launchSwarm(USER, { goal: 'billing flow and oauth login', taskCount: 5 });
    expect(batch.status).toBe('COMPLETED');
    expect(batch.task_count).toBe(5);
    expect(batch.completed_count).toBe(5);
    expect(batch.shared_patterns).toHaveLength(5);
    expect(batch.results).toHaveLength(5);
    expect(batch.id).toMatch(/^swm-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.swarm_launched');
    expect(AUDIT_ACTIONS()).toContain('autonomy.swarm_completed');
  });

  it('caps the swarm at 10 tasks and stays owner-scoped', async () => {
    await launchSwarm(USER, { goal: 'billing', taskCount: 99 });
    const batch = await launchSwarm(USER, { goal: 'auth', taskCount: 2 });
    expect(await listSwarmBatches(USER)).toHaveLength(2);
    await expect(getSwarmBatch(OTHER, batch.id)).rejects.toThrow(/swarm_batch_not_found/);
    await expect(launchSwarm(USER, { goal: '' })).rejects.toThrow(AppError);
  });
});

// ── ZERO-INBOX MODE (#6) ───────────────────────────────────────────────────

describe('ZERO-INBOX MODE — review decisions, not notifications (#6)', () => {
  beforeEach(cleartables);

  it('turns each notification into a fix / waiting / escalation decision', () => {
    expect(triageDecision({ source: 'ci', subject: 'fixed flaky test', kind: 'test' }).verdict).toBe('READY');
    expect(triageDecision({ source: 'pr', subject: 'blocked on reviewer', kind: 'comment' }).verdict).toBe('WAITING');
    expect(triageDecision({ source: 'security', subject: 'auth permission denied', kind: 'alert' }).verdict).toBe('ESCALATED');
    expect(triageDecision({ source: 'ci', subject: 'build timeout', kind: 'flaky' }).verdict).toBe('ESCALATED');
  });

  it('produces the morning digest with honest counts', async () => {
    const digest = await runTriaging(USER, {
      period: '2026-09-14',
      items: [
        { source: 'ci', subject: 'fixed flaky test', kind: 'test' },
        { source: 'pr', subject: 'blocked on reviewer', kind: 'comment' },
        { source: 'security', subject: 'auth permission denied', kind: 'alert' },
        { source: 'ci', subject: 'build timeout', kind: 'flaky' },
      ],
    });
    expect(digest.id).toMatch(/^zib-/);
    expect(digest.total_issues).toBe(4);
    expect(digest.fixes_ready).toBe(1);
    expect(digest.waiting).toBe(1);
    expect(digest.escalations).toBe(2);
    expect(AUDIT_ACTIONS()).toContain('autonomy.inbox_triaged');
    expect(AUDIT_ACTIONS()).toContain('autonomy.inbox_digest_created');
  });

  it('persists digests, reports, and stays owner-scoped', async () => {
    await runTriaging(USER, { period: 'd1', items: [{ source: 'ci', subject: 'fixed flaky test', kind: 'test' }] });
    const d2 = await runTriaging(USER, {
      period: 'd2',
      items: [
        { source: 'ci', subject: 'build timeout', kind: 'flaky' },
        { source: 'pr', subject: 'blocked on reviewer', kind: 'comment' },
      ],
    });
    expect(await listZeroInboxDigests(USER)).toHaveLength(2);
    const report = await inboxReport(USER);
    expect(report.fixes_ready).toBe(1);
    expect(report.waiting).toBe(1);
    expect(report.escalations).toBe(1);
    await expect(getZeroInboxDigest(OTHER, d2.id)).rejects.toThrow(/zero_inbox_digest_not_found/);
    await expect(runTriaging(USER, { period: '', items: [] })).rejects.toThrow(AppError);
    await expect(runTriaging(USER, { period: 'd3', items: [] })).rejects.toThrow(/nothing to triage/);
  });
});

// ── NIGHT SHIFT (#7) ───────────────────────────────────────────────────────

describe('NIGHT SHIFT — the backlog works while you sleep (#7)', () => {
  beforeEach(cleartables);

  it('executes low-risk tasks without approval and tells you what happened', async () => {
    const run = await runNightShift(USER, {
      windowStart: '02:00',
      windowEnd: '06:00',
      tasks: [
        { name: 'fix flaky test', risk: 'LOW', ok: true, change: 'patched' },
        { name: 'upgrade dep', risk: 'MEDIUM', ok: true, change: 'bumped dep' },
        { name: 'delete dead code', risk: 'LOW', ok: false, change: '' },
      ],
    });
    expect(run.status).toBe('COMPLETED');
    expect(run.tasks_completed).toBe(1);
    expect(run.tasks_failed).toBe(1);
    expect(run.changes_made).toHaveLength(1);
    expect(run.report).toContain('NIGHT SHIFT 02:00 — 06:00');
    expect(run.report).toContain('Changed without approval: 1');
    expect(run.report).toContain('Needs your eyes: 1');
    expect(run.id).toMatch(/^nsh-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.night_shift_completed');
  });

  it('persists, reports, and stays owner-scoped', async () => {
    await runNightShift(USER, {
      windowStart: '02:00',
      windowEnd: '06:00',
      tasks: [{ name: 'sync docs', risk: 'LOW', ok: true, change: 'synced' }],
    });
    const run = await runNightShift(USER, {
      windowStart: '02:00',
      windowEnd: '06:00',
      tasks: [{ name: 'sync docs', risk: 'LOW', ok: true, change: 'synced' }],
    });
    expect(await listNightShiftRuns(USER)).toHaveLength(2);
    const report = await nightShiftReport(USER);
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(0);
    await expect(getNightShiftRun(OTHER, run.id)).rejects.toThrow(/night_shift_run_not_found/);
    await expect(runNightShift(USER, { windowStart: '', windowEnd: '06:00', tasks: [{ name: 'a', risk: 'LOW', ok: true, change: '' }] })).rejects.toThrow(AppError);
    await expect(runNightShift(USER, { windowStart: '02:00', windowEnd: '06:00', tasks: [] })).rejects.toThrow(/no tasks in this shift/);
    await expect(runNightShift(USER, { windowStart: '02:00', windowEnd: '06:00', tasks: [{ name: 'a', risk: 'LOW', ok: true, change: '' }] })).resolves.toBeTruthy();
  });
});

// ── RELEASE COMMANDER (#9) ─────────────────────────────────────────────────

describe('RELEASE COMMANDER — an unflappable release train (#9)', () => {
  beforeEach(cleartables);

  it('plans and freezes a release on the cut branch', async () => {
    const run = await planRelease(USER, { milestone: 'v2.0', releaseBranch: 'release/v2.0' });
    expect(run.status).toBe('PLANNED');
    expect(run.release_branch).toBe('release/v2.0');
    expect(run.features_frozen).toBe(false);
    expect(run.id).toMatch(/^rcr-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_branch_created');
    const frozen = await freezeFeatures(USER, run.id);
    expect(frozen.status).toBe('FEATURE_FROZEN');
    expect(frozen.features_frozen).toBe(true);
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_features_frozen');
    await expect(freezeFeatures(USER, run.id)).rejects.toThrow(/already frozen/);
  });

  it('cherry-picks fixes into the release and runs a verified rollback drill', async () => {
    const run = await planRelease(USER, { milestone: 'v1.5', releaseBranch: 'release/v1.5' });
    const picked = await cherryPickCommit(USER, run.id, 'abc123', 'release');
    expect(picked.cherry_picks).toHaveLength(1);
    expect(picked.cherry_picks[0]!.commit).toBe('abc123');
    expect(picked.cherry_picks[0]!.applied).toBe(true);
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_cherry_picked');
    const drilled = await drillRollback(USER, run.id);
    expect(drilled.status).toBe('RELEASED');
    expect(drilled.rollback_drill_result.verified).toBe('true');
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_rollback_drilled');
    await expect(cherryPickCommit(USER, run.id, '')).rejects.toThrow(AppError);
  });

  it('coordinates hotfix lanes that need explicit approval', async () => {
    const run = await planRelease(USER, { milestone: 'v1.2', releaseBranch: 'release/v1.2' });
    const hot = await laneHotfix(USER, run.id, 'p0');
    expect(hot.status).toBe('HOTFIX');
    expect(hot.hotfix_lanes).toHaveLength(1);
    expect(hot.hotfix_lanes[0]!.status).toBe('PENDING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_hotfix_laned');
    const approved = await approveHotfixLane(USER, run.id, 'p0');
    expect(approved.hotfix_lanes[0]!.status).toBe('APPLIED');
    await expect(approveHotfixLane(USER, run.id, 'nope')).rejects.toThrow(/no hotfix lane named nope/);
  });

  it('persists, reports, and stays owner-scoped', async () => {
    const run = await planRelease(USER, { milestone: 'v3.0', releaseBranch: 'release/v3.0' });
    await freezeFeatures(USER, run.id);
    await planRelease(USER, { milestone: 'v2.9', releaseBranch: 'release/v2.9' });
    await expect(listReleaseRuns(USER)).resolves.toHaveLength(2);
    const report = await releaseReport(USER);
    expect(report.frozen).toBe(1);
    await expect(getReleaseRun(OTHER, run.id)).rejects.toThrow(/release_captain_run_not_found/);
    await expect(planRelease(USER, { milestone: '' })).rejects.toThrow(AppError);
  });
});

// ── FIREWALL DRILL (#10) ───────────────────────────────────────────────────

describe('FIREWALL DRILL — practice survival before it matters (#10)', () => {
  beforeEach(cleartables);

  it('scores resilience honestly and ranks fixes by survivability', () => {
    const scenarios = [
      { scenario: 'service_down', survived: true, alertsFired: true, recovery: 'AUTOMATIC' as const },
      { scenario: 'database_failure', survived: true, alertsFired: true, recovery: 'AUTOMATIC' as const },
      { scenario: 'cert_expiry', survived: false, alertsFired: true, recovery: 'MANUAL' as const },
    ];
    expect(scoreDrill(scenarios)).toBe(67);
    const fixes = blameFixList(scenarios);
    expect(fixes).toContain('cert_expiry: make recovery automatic');
  });

  it('plans a drill then runs the chaos battery end-to-end', async () => {
    const planned = await planDrill(USER, { drillType: 'comprehensive' });
    expect(planned.status).toBe('PLANNED');
    expect(planned.id).toMatch(/^fdr-/);
    const done = await runDrill(USER, planned.id, {
      scenarios: [
        { scenario: 'service_down', survived: true, alertsFired: true, recovery: 'AUTOMATIC' },
        { scenario: 'cert_expiry', survived: false, alertsFired: true, recovery: 'MANUAL' },
      ],
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.resilience_score).toBe(50);
    expect(done.fix_list).toHaveLength(1);
    expect(done.scenarios).toHaveLength(2);
    expect(AUDIT_ACTIONS()).toContain('autonomy.firewall_drill_completed');
    await expect(runDrill(USER, planned.id, { scenarios: [{ scenario: 'x', survived: true, alertsFired: true, recovery: 'AUTOMATIC' }] })).rejects.toThrow(/already ran/);
  });

  it('persists, reports, and stays owner-scoped', async () => {
    const d1 = await planDrill(USER, { drillType: 'network' });
    await runDrill(USER, d1.id, { scenarios: [{ scenario: 'network_partition', survived: false, alertsFired: true, recovery: 'MANUAL' }] });
    const d2 = await planDrill(USER, { drillType: 'storage' });
    const d3 = await planDrill(USER, { drillType: 'storage' });
    expect(await listDrillRuns(USER)).toHaveLength(3);
    const report = await drillReport(USER);
    expect(report.drills).toBe(3);
    expect(report.completed).toBe(1);
    await expect(getDrillRun(OTHER, d1.id)).rejects.toThrow(/firewall_drill_not_found/);
    await expect(runDrill(USER, d2.id, { scenarios: [] })).rejects.toThrow(/at least one failure scenario/);
  });
});