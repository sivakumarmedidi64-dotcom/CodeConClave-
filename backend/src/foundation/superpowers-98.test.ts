/**
 * CodeConClave — Stage 98 SUPERPOWERS Tranche T: Impact Radar, Churn
 * Detective, Onboarding Simulator, Zero-to-Prod Mode, Policy Copilot.
 *
 *   IMPACT RADAR (#77)          — releases correlated with product metrics.
 *   CHURN DETECTIVE (#78)       — where users give up, fix drafted with evidence.
 *   ONBOARDING SIMULATOR (#79)  — a confused new hire, role-played to tickets.
 *   ZERO-TO-PROD MODE (#80)     — one idea → approved pipeline to production.
 *   POLICY COPILOT (#81)        — plain English policy → enforced permissions.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    impact_radar: [] as Array<Record<string, unknown>>,
    churn_events: [] as Array<Record<string, unknown>>,
    onboarding_sims: [] as Array<Record<string, unknown>>,
    zero_to_prod: [] as Array<Record<string, unknown>>,
    policy_copilots: [] as Array<Record<string, unknown>>,
  };
  const now = () => {
    tick += 1;
    return new Date(tick).toISOString();
  };
  return { tables, now };
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
    IMPACT_READING: 'imr',
    CHURN_EVENT: 'chn',
    ONBOARDING_SIM: 'obs',
    PROD_RUN: 'z2p',
    POLICY: 'pcy',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { reportImpact, impactConclude, getImpactReading, listImpactReadings, radarReport } from '../modules/superpowers/impactRadar.js';
import { reportChurnEvent, draftChurnFix, churnRemedy, getChurnEvent, listChurnEvents, churnReport } from '../modules/superpowers/churnDetective.js';
import { startOnboardingSim, completeSim, simulateSteps, getOnboardingSim, listOnboardingSims, onboardingSimReport } from '../modules/superpowers/onboardingSimulator.js';
import { startProdRun, advanceProdStage, PROD_STAGES, getProdRun, listProdRuns, prodRunReport } from '../modules/superpowers/zeroToProd.js';
import { writePolicy, activatePolicy, suspendPolicy, compilePolicy, getPolicy, listPolicies, policyCopilotReport } from '../modules/superpowers/policyCopilot.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('IMPACT RADAR (#77)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('correlates a release with a product metric', async () => {
    const r = await reportImpact(USER, { area: 'onboarding flow', metric: 'signup completion', delta: 4 });
    expect(r.id).toMatch(/^imr-/);
    expect(r.area).toBe('onboarding flow');
    expect(r.delta).toBe(4);
    expect(AUDIT_ACTIONS()).toContain('autonomy.impact_reported');
    expect(impactConclude(4)).toBe('this change helped the metric — ship more like this');
    expect(impactConclude(-2)).toContain('roll back');
    expect(impactConclude(0)).toContain('neutral');
  });

  it('finds the strongest signal in the report', async () => {
    const a = await reportImpact(USER, { area: 'onboarding flow', metric: 'signup', delta: 4 });
    await reportImpact(USER, { area: 'checkout', metric: 'conversion', delta: -7 });

    const report = await radarReport(USER);
    expect(report.readings).toBe(2);
    expect(report.positive).toBe(1);
    expect(report.negative).toBe(1);
    expect(report.strongest!.area).toBe('checkout');
    expect(report.strongest!.delta).toBe(-7);

    await expect(getImpactReading(OTHER, a.id)).rejects.toThrow(/impact_reading_not_found/);
    await expect(listImpactReadings(OTHER)).resolves.toHaveLength(0);
    await expect(reportImpact(USER, { area: '', metric: 'x', delta: 1 })).rejects.toThrow(/a change area is required/);
    await expect(reportImpact(USER, { area: 'a', metric: 'x', delta: NaN })).rejects.toThrow(/must be a number/);
  });
});

describe('CHURN DETECTIVE (#78)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('records where users give up and drafts the fix with evidence', async () => {
    const e = await reportChurnEvent(USER, { locale: 'checkout page', action: 'applying the payment form', signal: 'form_abandoned', occurrences: 14 });
    expect(e.id).toMatch(/^chn-/);
    expect(e.status).toBe('WATCHED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.churn_event_recorded');

    const drafted = await draftChurnFix(USER, e.id);
    expect(drafted.status).toBe('DRAFTED');
    expect(drafted.fix_draft).toContain('inline validation');
    expect(drafted.fix_draft).toContain('14');
    expect(AUDIT_ACTIONS()).toContain('autonomy.churn_fix_drafted');
    await expect(draftChurnFix(USER, e.id)).rejects.toThrow(/already drafted/);
  });

  it('offers signal-specific remedies', () => {
    expect(churnRemedy('rage_click')).toBe('decelerating feedback + an undo path');
    expect(churnRemedy('error_loop')).toBe('guard-rails on the failing path + retry limits');
  });

  it('reports, validates, and stays owner-scoped', async () => {
    const a = await reportChurnEvent(USER, { locale: 'checkout', action: 'form', signal: 'form_abandoned' });
    await reportChurnEvent(USER, { locale: 'nav', action: 'menu', signal: 'rage_click' });
    await reportChurnEvent(USER, { locale: 'payments', action: 'retry', signal: 'error_loop' });

    const report = await churnReport(USER);
    expect(report.events).toBe(3);
    expect(report.rage_clicks).toBe(1);
    expect(report.error_loops).toBe(1);
    expect(report.abandoned).toBe(1);
    expect(report.drafted).toBe(0);

    await expect(getChurnEvent(OTHER, a.id)).rejects.toThrow(/churn_event_not_found/);
    await expect(listChurnEvents(OTHER)).resolves.toHaveLength(0);
    await expect(reportChurnEvent(USER, { locale: 'x', action: 'y', signal: 'furious_click' as never })).rejects.toThrow(/rage_click, error_loop, or form_abandoned/);
  });
});

describe('ONBOARDING SIMULATOR (#79)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('role-plays a confused new hire and turns friction into tickets', async () => {
    expect(simulateSteps()).toHaveLength(4);
    const sim = await startOnboardingSim(USER, { profile: 'frontend dev', difficulty: 8 });
    expect(sim.id).toMatch(/^obs-/);
    expect(sim.status).toBe('PLAYING');
    expect(sim.steps.length).toBe(4);
    expect(AUDIT_ACTIONS()).toContain('autonomy.onboarding_sim_started');

    const done = await completeSim(USER, sim.id);
    expect(done.status).toBe('COMPLETE');
    expect(done.tickets).toHaveLength(2);
    expect(done.tickets[0]).toContain('configure environment variables');
    expect(AUDIT_ACTIONS()).toContain('autonomy.onboarding_sim_completed');
    await expect(completeSim(USER, sim.id)).rejects.toThrow(/already wrapped up/);
  });

  it('reports and stays owner-scoped', async () => {
    const a = await startOnboardingSim(USER, { profile: 'backend dev' });
    await completeSim(USER, a.id);

    const report = await onboardingSimReport(USER);
    expect(report.sims).toBe(1);
    expect(report.complete).toBe(1);
    expect(report.tickets).toBe(2);

    await expect(getOnboardingSim(OTHER, a.id)).rejects.toThrow(/onboarding_sim_not_found/);
    await expect(listOnboardingSims(OTHER)).resolves.toHaveLength(0);
    await expect(startOnboardingSim(USER, { profile: '' })).rejects.toThrow(/new-hire profile is required/);
    const light = await startOnboardingSim(USER, { profile: 'ops', difficulty: 99 });
    expect(light.difficulty).toBe(5);
  });
});

describe('ZERO-TO-PROD MODE (#80)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('walks one idea through an approved pipeline to production', async () => {
    expect(PROD_STAGES).toHaveLength(8);
    const run = await startProdRun(USER, { idea: 'a tiny markdown editor' });
    expect(run.id).toMatch(/^z2p-/);
    expect(run.stages).toHaveLength(8);
    expect(run.stages[0]!.status).toBe('READY');
    expect(run.status).toBe('RUNNING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.zero_to_prod_started');

    await expect(advanceProdStage(USER, run.id, { stage: 'schema' })).rejects.toThrow(/one at a time/);

    for (const stage of PROD_STAGES) {
      const next = await advanceProdStage(USER, run.id, { stage });
      const done = next.stages.filter((s) => s.status === 'APPROVED').length;
      expect(done).toBe(PROD_STAGES.indexOf(stage) + 1);
    }
    const shipped = await getProdRun(USER, run.id);
    expect(shipped.status).toBe('COMPLETE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.prod_stage_approved');
    expect(AUDIT_ACTIONS()).toContain('autonomy.zero_to_prod_shipped');
    await expect(advanceProdStage(USER, run.id, { stage: 'monitoring' })).rejects.toThrow(/already shipped/);
  });

  it('reports and stays owner-scoped', async () => {
    const run = await startProdRun(USER, { idea: 'a tiny markdown editor' });
    await advanceProdStage(USER, run.id, { stage: 'requirements' });
    await startProdRun(USER, { idea: 'a comment widget' });

    const report = await prodRunReport(USER);
    expect(report.runs).toBe(2);
    expect(report.shipped).toBe(0);
    expect(report.stages_done).toBe(1);

    await expect(getProdRun(OTHER, run.id)).rejects.toThrow(/zero_to_prod_not_found/);
    await expect(listProdRuns(OTHER)).resolves.toHaveLength(0);
    await expect(startProdRun(USER, { idea: '' })).rejects.toThrow(/a product idea is required/);
  });
});

describe('POLICY COPILOT (#81)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('compiles plain English into enforced constraints', async () => {
    const p = await writePolicy(USER, { policy: 'No data leaves the EU' });
    expect(p.id).toMatch(/^pcy-/);
    expect(p.status).toBe('PENDING');
    expect(p.constraints).toContain('egress_blocked: eu_region');
    expect(p.constraints).toContain('permission_set: least_privilege');
    expect(AUDIT_ACTIONS()).toContain('autonomy.policy_written');
  });

  it('activates and suspends a compiled policy', async () => {
    const p = await writePolicy(USER, { policy: 'No SSH or shell execution by default' });
    expect(compilePolicy('No SSH or shell execution by default')).toContain('no_shell_access');

    const active = await activatePolicy(USER, p.id);
    expect(active.status).toBe('ACTIVE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.policy_activated');
    await expect(activatePolicy(USER, p.id)).rejects.toThrow(/already enforced/);

    const suspended = await suspendPolicy(USER, p.id);
    expect(suspended.status).toBe('SUSPENDED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.policy_suspended');
    await expect(suspendPolicy(USER, p.id)).rejects.toThrow(/only an enforced policy/);

    const reactivated = await activatePolicy(USER, p.id);
    expect(reactivated.status).toBe('ACTIVE');
  });

  it('reports, validates, and stays owner-scoped', async () => {
    const a = await writePolicy(USER, { policy: 'No data leaves the EU' });
    await writePolicy(USER, { policy: 'Production must not deploy without a review' });
    await activatePolicy(USER, a.id);

    const report = await policyCopilotReport(USER);
    expect(report.policies).toBe(2);
    expect(report.active).toBe(1);
    expect(report.suspended).toBe(0);
    expect(report.constraints).toBeGreaterThanOrEqual(4);

    await expect(getPolicy(OTHER, a.id)).rejects.toThrow(/policy_copilot_not_found/);
    await expect(listPolicies(OTHER)).resolves.toHaveLength(0);
    await expect(writePolicy(USER, { policy: '' })).rejects.toThrow(/plain English/);
  });
});