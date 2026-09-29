/**
 * CodeConClave — Stage 90 SUPERPOWERS Tranche L: autonomous execution.
 *
 *   AUTOPILOT PRIME   (#1) — one plain-English goal -> deterministic task DAG
 *                            -> self-repair on failure -> diff + summary +
 *                            test results. No approval spam.
 *   PHOENIX PROTOCOL  (#3) — CI fails -> reproduce at the exact commit with the
 *                            exact env -> fix -> suite green -> PR only then.
 *   LAUNCH CAPTAIN    (#4) — change classification, semver bump, release notes,
 *                            deploy, and rollback when metrics tank.
 *   AUTOPSY           (#5) — incident -> correlate with recent deploys ->
 *                            timeline -> postmortem -> fix PR at >=80%
 *                            confidence.
 *   SELF-HEALING CI   (#8) — predicts CI failure from historical signatures
 *                            and pre-empts it with the likely fix.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    autopilot_runs: [] as Array<Record<string, unknown>>,
    phoenix_cycles: [] as Array<Record<string, unknown>>,
    launch_releases: [] as Array<Record<string, unknown>>,
    autopsy_incidents: [] as Array<Record<string, unknown>>,
    self_heal_scans: [] as Array<Record<string, unknown>>,
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
    autopilot_runs: {},
    phoenix_cycles: { env: {} },
    launch_releases: { deployed_at: null },
    autopsy_incidents: { proposed_fix: null, window_seconds: 900 },
    self_heal_scans: { matched_signature: null, likely_fix: null, score: 0 },
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
    AUTOPILOT_RUN: 'apr',
    PHOENIX_CYCLE: 'phx',
    LAUNCH_RELEASE: 'lcr',
    AUTOPSY_INCIDENT: 'aps',
    SELF_HEAL_SCAN: 'shs',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import {
  planAutopilot,
  executeAutopilot,
  getAutopilotRun,
  listAutopilotRuns,
  autopilotReport,
} from '../modules/superpowers/autopilotPrime.js';
import {
  startPhoenixCycle,
  applyPhoenixFix,
  confirmPhoenixSuite,
  openPhoenixPr,
  getPhoenixCycle,
  listPhoenixCycles,
  phoenixReport,
} from '../modules/superpowers/phoenixProtocol.js';
import {
  matchFailureSignatures,
  scanCiForHealing,
  getCiHealScan,
  listCiHealScans,
  cishealReport,
} from '../modules/superpowers/selfHealingCi.js';
import {
  classifyChange,
  computeBump,
  bumpVersion,
  planLaunchRelease,
  deployLaunchRelease,
  flagMetricsTank,
  getLaunchRelease,
  listLaunchReleases,
  launchReport,
} from '../modules/superpowers/launchCaptain.js';
import {
  analyzeSuspects,
  runAutopsy,
  resolveAutopsy,
  getAutopsyIncident,
  listAutopsyIncidents,
  autopsyReport,
} from '../modules/superpowers/autopsy.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── AUTOPILOT PRIME (#1) ────────────────────────────────────────────────────

describe('AUTOPILOT PRIME — one goal to a completed, reviewed run (#1)', () => {
  beforeEach(cleartables);

  it('decomposes a plain-English goal into an ordered task DAG', () => {
    const nodes = planAutopilot('refactor payments module and add tests for it');
    expect(nodes.map((n) => n.action)).toEqual(['refactor', 'test']);
    expect(nodes[1]!.deps).toEqual(['n1']);
  });

  it('appends a test gate to goals that mention no tests', () => {
    const nodes = planAutopilot('install the app');
    expect(nodes.map((n) => n.action)).toEqual(['install', 'test']);
  });

  it('executes end-to-end and returns diff, summary and test results', async () => {
    const run = await executeAutopilot(USER, { goal: 'refactor payments module and add tests for it' });
    expect(run.status).toBe('COMPLETE');
    expect(run.node_count).toBe(2);
    expect(run.executed).toBe(2);
    expect(run.retries).toBe(0);
    expect(run.id).toMatch(/^apr-/);
    expect(run.diff).toContain('+ refactor');
    expect(run.diff).toContain('+ test');
    expect(run.summary).toContain('AUTOPILOT: COMPLETE');
    expect(run.test_results).toHaveLength(1);
    expect(run.test_results[0]!.ok).toBe(true);
    expect(AUDIT_ACTIONS()).toContain('autonomy.autopilot_run_executed');
  });

  it('self-repairs a failing node within the retry budget', async () => {
    const run = await executeAutopilot(USER, {
      goal: 'refactor payments module and add tests for it',
      outcomes: { n1: { ok: false, recovers: true, note: 'recovered after budget' } },
    });
    expect(run.status).toBe('COMPLETE');
    expect(run.retries).toBe(4);
    expect(run.executed).toBe(2);
    expect(run.summary).toContain('recovered after budget');
  });

  it('fails honestly once a node exhausts its retry budget', async () => {
    const run = await executeAutopilot(USER, {
      goal: 'deploy the service',
      outcomes: { n1: { ok: false, note: 'executor crashed' } },
    });
    expect(run.status).toBe('FAILED');
    expect(run.retries).toBe(4);
    expect(run.executed).toBe(0);
    expect(run.summary).toContain('executor crashed');
  });

  it('persists, lists and reports; stays owner-scoped', async () => {
    await executeAutopilot(USER, { goal: 'add tests' });
    await executeAutopilot(USER, { goal: 'deploy the service', outcomes: { n1: { ok: false, note: 'boom' } } });
    const run = await executeAutopilot(USER, { goal: 'refactor the store' });
    expect(await listAutopilotRuns(USER)).toHaveLength(3);
    const report = await autopilotReport(USER);
    expect(report.runs).toBe(3);
    expect(report.complete).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.total_retries).toBe(4);
    await expect(getAutopilotRun(OTHER, run.id)).rejects.toThrow(/autopilot_run_not_found/);
    await expect(executeAutopilot(USER, { goal: '' })).rejects.toThrow(AppError);
  });
});

// ── PHOENIX PROTOCOL (#3) ───────────────────────────────────────────────────

describe('PHOENIX PROTOCOL — nothing reaches you as a PR until the suite is green (#3)', () => {
  beforeEach(cleartables);

  it('reproduces the failure at the exact commit with the exact env', async () => {
    const cycle = await startPhoenixCycle(USER, {
      pipeline: 'ci',
      commit: 'abc123',
      failure: 'build broke on type error',
      env: { NODE_ENV: 'test' },
    });
    expect(cycle.status).toBe('REPRODUCED');
    expect(cycle.commit).toBe('abc123');
    expect(cycle.env).toEqual({ NODE_ENV: 'test' });
    expect(cycle.id).toMatch(/^phx-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.phoenix_recovery_step');
  });

  it('walks REPRODUCED -> FIX_READY -> SUITE_GREEN -> PR_OPENED', async () => {
    const cycle = await startPhoenixCycle(USER, { pipeline: 'ci', commit: 'abc123', failure: 'type error' });
    const fixed = await applyPhoenixFix(USER, cycle.id, 'patch: add null guard');
    expect(fixed.status).toBe('FIX_READY');
    const green = await confirmPhoenixSuite(USER, cycle.id, '120 tests passed');
    expect(green.status).toBe('SUITE_GREEN');
    const pr = await openPhoenixPr(USER, cycle.id, 'PR-42');
    expect(pr.status).toBe('PR_OPENED');
    expect(pr.pr_number).toBe('PR-42');
  });

  it('refuses to open a PR when the suite is not green', async () => {
    const cycle = await startPhoenixCycle(USER, { pipeline: 'ci', commit: 'abc123', failure: 'type error' });
    await applyPhoenixFix(USER, cycle.id, 'patch');
    await expect(openPhoenixPr(USER, cycle.id, 'PR-1')).rejects.toThrow(AppError);
    const still = await confirmPhoenixSuite(USER, cycle.id, '90 passed, 2 failed');
    expect(still.status).toBe('FIX_READY');
    await expect(openPhoenixPr(USER, cycle.id, 'PR-1')).rejects.toThrow(/until the suite is green/);
  });

  it('persists, filters by pipeline and reports; stays owner-scoped', async () => {
    const c1 = await startPhoenixCycle(USER, { pipeline: 'ci', commit: 'a1', failure: 'x' });
    const c2 = await startPhoenixCycle(USER, { pipeline: 'build', commit: 'b2', failure: 'y' });
    expect(await listPhoenixCycles(USER, { pipeline: 'ci' })).toHaveLength(1);
    const report = await phoenixReport(USER);
    expect(report.cycles).toBe(2);
    expect(report.reproduced).toBe(2);
    await expect(getPhoenixCycle(OTHER, c1.id)).rejects.toThrow(/phoenix_cycle_not_found/);
    await expect(applyPhoenixFix(USER, c2.id, 'patch')).toBeDefined();
    await expect(applyPhoenixFix(USER, c1.id, 'patch')).resolves.toBeTruthy();
  });
});

// ── SELF-HEALING CI (#8) ────────────────────────────────────────────────────

describe('SELF-HEALING CI — predict CI failure before the pipeline runs (#8)', () => {
  beforeEach(cleartables);

  it('pre-empts a diff that matches a historical failure signature', async () => {
    const outcome = await scanCiForHealing(USER, {
      diff: 'remove the deprecated api call',
      signatures: [{ name: 'deprecated-api', pattern: 'deprecated api', count: 4, fix: 'replace with the new client' }],
    });
    expect(outcome.preempted).toBe(true);
    expect(outcome.scan.action).toBe('PREEMPTED');
    expect(outcome.scan.matched_signature).toBe('deprecated-api');
    expect(outcome.scan.score).toBe(4);
    expect(outcome.scan.likely_fix).toBe('replace with the new client');
    expect(outcome.scan.id).toMatch(/^shs-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.ci_heal_preempted');
  });

  it('ranks signatures by incidence x history count', () => {
    const match = matchFailureSignatures('the old deprecated api with the old deprecated api', [
      { name: 'seldom', pattern: 'deprecated api', count: 1, fix: 'a' },
      { name: 'frequent', pattern: 'old ', count: 9, fix: 'b' },
    ]);
    expect(match!.name).toBe('frequent');
  });

  it('returns CLEAN when no signature matches', async () => {
    const outcome = await scanCiForHealing(USER, {
      diff: 'change the button color',
      signatures: [{ name: 'deprecated-api', pattern: 'deprecated api', count: 4, fix: 'x' }],
    });
    expect(outcome.preempted).toBe(false);
    expect(outcome.scan.action).toBe('CLEAN');
    expect(outcome.scan.matched_signature).toBeUndefined();
    expect(AUDIT_ACTIONS()).not.toContain('autonomy.ci_heal_preempted');
  });

  it('persists, lists and reports; stays owner-scoped', async () => {
    const clean = await scanCiForHealing(USER, { diff: 'style tweak', signatures: [] });
    const hit = await scanCiForHealing(USER, {
      diff: 'deprecated api removal',
      signatures: [{ name: 'dep', pattern: 'deprecated api', count: 3, fix: 'new api' }],
    });
    expect(await listCiHealScans(USER)).toHaveLength(2);
    const report = await cishealReport(USER);
    expect(report.scans).toBe(2);
    expect(report.preempted).toBe(1);
    expect(report.clean).toBe(1);
    await expect(getCiHealScan(OTHER, hit.scan.id)).rejects.toThrow(/self_heal_scan_not_found/);
    await expect(scanCiForHealing(USER, { diff: '' })).rejects.toThrow(AppError);
    expect(clean.scan.action).toBe('CLEAN');
  });
});

// ── LAUNCH CAPTAIN (#4) ─────────────────────────────────────────────────────

describe('LAUNCH CAPTAIN — classification, semver, notes, deploy, rollback (#4)', () => {
  beforeEach(cleartables);

  it('classifies changes from their actual text', () => {
    expect(classifyChange('feat: add billing widget')).toBe('feature');
    expect(classifyChange('fix: resolve null crash')).toBe('fix');
    expect(classifyChange('BREAKING CHANGE: rename public API')).toBe('breaking');
    expect(classifyChange('refactor: extract helper')).toBe('refactor');
    expect(classifyChange('chore: update deps')).toBe('chore');
  });

  it('bumps semver by the highest-impact classification', () => {
    expect(computeBump(['feature', 'fix'])).toBe('minor');
    expect(computeBump(['breaking', 'fix'])).toBe('major');
    expect(computeBump(['fix'])).toBe('patch');
    expect(computeBump(['chore', 'refactor'])).toBe('none');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpVersion('1.2.3', 'none')).toBe('1.2.3');
  });

  it('plans a release with classified changes and real notes', async () => {
    const release = await planLaunchRelease(USER, {
      currentVersion: '1.2.3',
      changes: [
        { commit: 'aaa1111', description: 'feat: add billing widget' },
        { commit: 'bbb2222', description: 'fix: resolve null crash' },
      ],
    });
    expect(release.version).toBe('1.3.0');
    expect(release.bump).toBe('minor');
    expect(release.status).toBe('PLANNED');
    expect(release.notes).toContain('RELEASE 1.3.0');
    expect(release.notes).toContain('[feature] aaa1111');
    expect(release.notes).toContain('[fix] bbb2222');
    expect(release.id).toMatch(/^lcr-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_planned');
  });

  it('deploys only a PLANNED release and rolls back when metrics tank', async () => {
    const release = await planLaunchRelease(USER, {
      currentVersion: '0.9.0',
      changes: [{ commit: 'ccc3333', description: 'BREAKING CHANGE: v2 API' }],
    });
    expect(release.version).toBe('1.0.0');
    const deployed = await deployLaunchRelease(USER, release.id);
    expect(deployed.status).toBe('DEPLOYED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_deployed');
    const rolled = await flagMetricsTank(USER, release.id, 'p95 latency tripled');
    expect(rolled.status).toBe('ROLLED_BACK');
    expect(AUDIT_ACTIONS()).toContain('autonomy.release_rolled_back');
  });

  it('rejects invalid transitions and stays owner-scoped', async () => {
    const release = await planLaunchRelease(USER, {
      currentVersion: '1.0.0',
      changes: [{ commit: 'dddd4444', description: 'chore: bump deps' }],
    });
    expect(release.bump).toBe('none');
    await expect(deployLaunchRelease(USER, release.id)).resolves.toMatchObject({ status: 'DEPLOYED' });
    await expect(deployLaunchRelease(USER, release.id)).rejects.toThrow(AppError);
    const r2 = await planLaunchRelease(USER, {
      currentVersion: '1.0.0',
      changes: [{ commit: 'eeee5555', description: 'fix: drain leak' }],
    });
    await expect(flagMetricsTank(USER, r2.id, 'x')).rejects.toThrow(/cannot roll back/);
    await expect(getLaunchRelease(OTHER, release.id)).rejects.toThrow(/launch_release_not_found/);
    await expect(planLaunchRelease(USER, { currentVersion: '', changes: [{ commit: 'a', description: 'x' }] })).rejects.toThrow(AppError);
    await expect(listLaunchReleases(USER)).resolves.toHaveLength(2);
    expect((await launchReport(USER)).deployed).toBe(1);
  });
});

// ── AUTOPSY (#5) ────────────────────────────────────────────────────────────

describe('AUTOPSY — incident to postmortem before you wake up (#5)', () => {
  beforeEach(cleartables);

  it('correlates the incident with recent deploys and proposes a fix at high confidence', async () => {
    const incident = await runAutopsy(USER, {
      incident: 'payments gateway timeout',
      windowSeconds: 900,
      suspects: [
        { commit: 'c111', commit_time: '2026-01-01T00:00:00Z', change: 'payments gateway retry logic', blast_radius: 0.9 },
        { commit: 'c222', commit_time: '2026-01-01T00:05:00Z', change: 'web build tooling', blast_radius: 0.1 },
      ],
    });
    expect(incident.status).toBe('PROPOSED');
    expect(incident.confidence).toBe(0.52);
    expect(incident.proposed_fix!.commit).toBe('c111');
    expect(incident.timeline[0]!.label).toContain('incident reported');
    expect(incident.postmortem).toContain('POSTMORTEM: payments gateway timeout');
    expect(incident.postmortem).toContain('confidence 52%');
    expect(incident.id).toMatch(/^aps-/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.incident_autopsy_drafted');
  });

  it('scores suspects deterministically with the analyzer', () => {
    const analysis = analyzeSuspects('payments gateway timeout', [
      { commit: 'c111', commit_time: 't', change: 'payments gateway retry logic', blast_radius: 0.9 },
      { commit: 'c222', commit_time: 't', change: 'web build tooling', blast_radius: 0.1 },
    ], 900);
    expect(analysis.ranked[0]!.commit).toBe('c111');
    expect(analysis.proposed_fix!.commit).toBe('c111');
  });

  it('drafts without a fix when confidence stays below 80%', async () => {
    const incident = await runAutopsy(USER, {
      incident: 'cron disk full',
      suspects: [{ commit: 'c333', commit_time: 't', change: 'web build tooling', blast_radius: 0.1 }],
    });
    expect(incident.status).toBe('DRAFTED');
    expect(incident.proposed_fix).toBeUndefined();
    expect(incident.postmortem).toContain('No fix proposed yet');
  });

  it('resolves incidents, persists, lists and reports; stays owner-scoped', async () => {
    const a = await runAutopsy(USER, { incident: 'gateway timeout', suspects: [{ commit: 'c1', commit_time: 't', change: 'payments gateway', blast_radius: 0.9 }] });
    const b = await runAutopsy(USER, { incident: 'disk full', suspects: [{ commit: 'c2', commit_time: 't', change: 'web build', blast_radius: 0.1 }] });
    const resolved = await resolveAutopsy(USER, a.id);
    expect(resolved.status).toBe('RESOLVED');
    expect(await listAutopsyIncidents(USER)).toHaveLength(2);
    const report = await autopsyReport(USER);
    expect(report.incidents).toBe(2);
    expect(report.avg_confidence).toBeGreaterThan(0);
    await expect(getAutopsyIncident(OTHER, b.id)).rejects.toThrow(/autopsy_incident_not_found/);
    await expect(runAutopsy(USER, { incident: '', suspects: [] })).rejects.toThrow(AppError);
    await expect(runAutopsy(USER, { incident: 'x', suspects: [{ commit: '', change: 'y', blast_radius: 0 }] })).rejects.toThrow(AppError);
  });
});