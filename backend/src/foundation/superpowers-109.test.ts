/**
 * CodeConClave — Stage 109 SUPERPOWERS Tranche AE: Query Optimizer (#132),
 * Cross-Team Contract Mesh (#138), Org Health Dashboard (#143),
 * Retention Predictor (#145), Hiring Assistant (#146).
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    query_optimizer_plans: [] as Array<Record<string, unknown>>,
    cross_team_contracts: [] as Array<Record<string, unknown>>,
    org_health_reports: [] as Array<Record<string, unknown>>,
    retention_predictors: [] as Array<Record<string, unknown>>,
    hiring_assistants: [] as Array<Record<string, unknown>>,
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
          const dollar = /^\$(\d+)$/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (/^(\w+)\s*\+\s*\$(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*\$(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(params[Number(m[2]!) - 1]);
          } else if (/^(\w+)\s*\+\s*(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(m[2]!);
          } else if (dollar) {
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
    QUERY_OPTIMIZER: 'qop',
    CROSS_TEAM_CONTRACT: 'xtc',
    ORG_HEALTH: 'ohd',
    RETENTION_PREDICTOR: 'rtp',
    HIRING_ASSISTANT: 'hga',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createQueryPlan, optimizeQuery, proveEquivalence, getQueryPlan, listQueryPlans, queryOptimizerReport } from '../modules/superpowers/queryOptimizer.js';
import { createContract, flagBreach, getContract, listContracts, crossTeamContractReport } from '../modules/superpowers/crossTeamContract.js';
import { createOrgHealthReport, computeOrgHealth, getOrgHealthReport, listOrgHealthReports, orgHealthReport } from '../modules/superpowers/orgHealth.js';
import { createRetentionSignal, flagRetentionSignal, getRetentionSignal, listRetentionSignals, retentionPredictorReport } from '../modules/superpowers/retentionPredictor.js';
import { createHiringEvaluation, scoreHiringEvaluation, getHiringEvaluation, listHiringEvaluations, hiringAssistantReport } from '../modules/superpowers/hiringAssistant.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('QUERY OPTIMIZER (#132)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a plan, optimizes query, and proves equivalence', async () => {
    const plan = await createQueryPlan(USER, { query_text: 'SELECT * FROM orders JOIN users ON orders.user_id = users.id', original_latency_ms: 350 });
    expect(plan.id).toMatch(/^qop-/);
    expect(plan.query_text).toContain('SELECT * FROM orders');
    expect(plan.status).toBe('DRAFT');
    expect(plan.equivalence_proven).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('autonomy.query_optimized');

    const optimized = await optimizeQuery(USER, plan.id, { optimized_query: 'SELECT o.* FROM orders o JOIN users u ON o.user_id = u.id', optimized_latency_ms: 80 });
    expect(optimized.optimized_query).toContain('SELECT o.*');
    expect(optimized.status).toBe('OPTIMIZED');
    expect(optimized.optimized_latency_ms).toBe(80);
    expect(AUDIT_ACTIONS()).toContain('autonomy.query_optimized');

    const proven = await proveEquivalence(USER, plan.id);
    expect(proven.status).toBe('EQUIVALENCE_PROVEN');
    expect(proven.equivalence_proven).toBe(true);
    expect(AUDIT_ACTIONS()).toContain('autonomy.query_equivalence_proven');
    await expect(proveEquivalence(USER, plan.id)).rejects.toThrow(/already proven/);
  });

  it('reports query optimizer totals', async () => {
    await createQueryPlan(USER, { query_text: 'SELECT * FROM t1', original_latency_ms: 100 });
    const p2 = await createQueryPlan(USER, { query_text: 'SELECT * FROM t2', original_latency_ms: 200 });
    await optimizeQuery(USER, p2.id, { optimized_query: 'SELECT * FROM t2 idx', optimized_latency_ms: 50 });

    const report = await queryOptimizerReport(USER);
    expect(report.plans).toBe(2);
    expect(report.optimized).toBe(1);
    expect(report.equivalence_proven).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const plan = await createQueryPlan(USER, { query_text: 'SELECT 1', original_latency_ms: 10 });
    await expect(getQueryPlan(OTHER, plan.id)).rejects.toThrow(/query_optimizer_plan_not_found/);
    await expect(listQueryPlans(OTHER)).resolves.toHaveLength(0);
    await expect(createQueryPlan(USER, { query_text: '', original_latency_ms: 10 })).rejects.toThrow(/query text is required/);
    await expect(createQueryPlan(USER, { query_text: 'SELECT 1', original_latency_ms: -1 })).rejects.toThrow(/original latency must be a positive number/);
  });
});

describe('CROSS-TEAM CONTRACT MESH (#138)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a contract and flags a breach', async () => {
    const contract = await createContract(USER, { team_a: 'platform', team_b: 'payments', api_contract: '/v2/checkout', shared_library: '@acme/shared-types', version: '3.1.0' });
    expect(contract.id).toMatch(/^xtc-/);
    expect(contract.team_a).toBe('platform');
    expect(contract.team_b).toBe('payments');
    expect(contract.status).toBe('ACTIVE');
    expect(contract.breach_reason).toBeNull();
    expect(AUDIT_ACTIONS()).toContain('autonomy.contract_breach_flagged');

    const breached = await flagBreach(USER, contract.id, { breach_reason: 'Breaking change in CheckoutRequest type' });
    expect(breached.status).toBe('BREACH_FLAGGED');
    expect(breached.breach_reason).toContain('Breaking change');
    expect(AUDIT_ACTIONS()).toContain('autonomy.contract_breach_flagged');
    await expect(flagBreach(USER, contract.id, { breach_reason: 'x' })).rejects.toThrow(/already flagged/);
  });

  it('reports contract totals', async () => {
    await createContract(USER, { team_a: 'a', team_b: 'b', api_contract: '/api/v1', shared_library: 'lib', version: '1.0' });
    const c2 = await createContract(USER, { team_a: 'c', team_b: 'd', api_contract: '/api/v2', shared_library: 'lib2', version: '2.0' });
    await flagBreach(USER, c2.id, { breach_reason: 'incompatible' });

    const report = await crossTeamContractReport(USER);
    expect(report.contracts).toBe(2);
    expect(report.active).toBe(1);
    expect(report.breach_flagged).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const c = await createContract(USER, { team_a: 'x', team_b: 'y', api_contract: '/a', shared_library: 'l', version: '1' });
    await expect(getContract(OTHER, c.id)).rejects.toThrow(/cross_team_contract_not_found/);
    await expect(listContracts(OTHER)).resolves.toHaveLength(0);
    await expect(createContract(USER, { team_a: '', team_b: 'y', api_contract: '/a', shared_library: 'l', version: '1' })).rejects.toThrow(/team A name is required/);
  });
});

describe('ORG HEALTH DASHBOARD (#143)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a report and computes org health', async () => {
    const report = await createOrgHealthReport(USER, { bus_factor_score: 3, review_bottleneck_score: 7, coverage_score: 82, incident_count: 2, debt_score: 15, velocity_trend: 'IMPROVING' });
    expect(report.id).toMatch(/^ohd-/);
    expect(report.bus_factor_score).toBe(3);
    expect(report.review_bottleneck_score).toBe(7);
    expect(report.coverage_score).toBe(82);
    expect(report.incident_count).toBe(2);
    expect(report.debt_score).toBe(15);
    expect(report.velocity_trend).toBe('IMPROVING');
    expect(report.status).toBe('DRAFT');
    expect(AUDIT_ACTIONS()).toContain('autonomy.org_health_computed');

    const computed = await computeOrgHealth(USER, report.id);
    expect(computed.status).toBe('COMPUTED');
    expect(computed.computed_metrics).toBeTruthy();
    expect(AUDIT_ACTIONS()).toContain('autonomy.org_health_computed');
    await expect(computeOrgHealth(USER, report.id)).rejects.toThrow(/already computed/);
  });

  it('reports org health totals', async () => {
    await createOrgHealthReport(USER, { bus_factor_score: 1, review_bottleneck_score: 5, coverage_score: 60, incident_count: 5, debt_score: 40, velocity_trend: 'DECLINING' });
    const r2 = await createOrgHealthReport(USER, { bus_factor_score: 5, review_bottleneck_score: 2, coverage_score: 95, incident_count: 0, debt_score: 5, velocity_trend: 'STABLE' });
    await computeOrgHealth(USER, r2.id);

    const report = await orgHealthReport(USER);
    expect(report.reports).toBe(2);
    expect(report.computed).toBe(1);
    expect(report.draft).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const r = await createOrgHealthReport(USER, { bus_factor_score: 2, review_bottleneck_score: 3, coverage_score: 70, incident_count: 1, debt_score: 10, velocity_trend: 'STABLE' });
    await expect(getOrgHealthReport(OTHER, r.id)).rejects.toThrow(/org_health_report_not_found/);
    await expect(listOrgHealthReports(OTHER)).resolves.toHaveLength(0);
    await expect(createOrgHealthReport(USER, { bus_factor_score: 0, review_bottleneck_score: 3, coverage_score: 70, incident_count: 1, debt_score: 10, velocity_trend: '' })).rejects.toThrow(/velocity trend is required/);
  });
});

describe('RETENTION PREDICTOR (#145)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a retention signal and flags with intervention plan', async () => {
    const signal = await createRetentionSignal(USER, { employee_name: 'Alice Chen', signal_type: 'burnout', risk_score: 8 });
    expect(signal.id).toMatch(/^rtp-/);
    expect(signal.employee_name).toBe('Alice Chen');
    expect(signal.signal_type).toBe('burnout');
    expect(signal.risk_score).toBe(8);
    expect(signal.status).toBe('DETECTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.retention_signal_flagged');

    const flagged = await flagRetentionSignal(USER, signal.id, { intervention_plan: '1:1 weekly, reduce sprint load, mentoring sessions' });
    expect(flagged.status).toBe('FLAGGED');
    expect(flagged.intervention_plan).toContain('1:1 weekly');
    expect(AUDIT_ACTIONS()).toContain('autonomy.retention_signal_flagged');
    await expect(flagRetentionSignal(USER, signal.id, { intervention_plan: 'x' })).rejects.toThrow(/already flagged/);
  });

  it('reports retention predictor totals', async () => {
    await createRetentionSignal(USER, { employee_name: 'Bob', signal_type: 'no_growth', risk_score: 5 });
    const s2 = await createRetentionSignal(USER, { employee_name: 'Carol', signal_type: 'stalled', risk_score: 9 });
    await flagRetentionSignal(USER, s2.id, { intervention_plan: 'new project assignment' });

    const report = await retentionPredictorReport(USER);
    expect(report.signals).toBe(2);
    expect(report.detected).toBe(1);
    expect(report.flagged).toBe(1);
    expect(report.high_risk).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await createRetentionSignal(USER, { employee_name: 'Dave', signal_type: 'burnout', risk_score: 6 });
    await expect(getRetentionSignal(OTHER, s.id)).rejects.toThrow(/retention_predictor_not_found/);
    await expect(listRetentionSignals(OTHER)).resolves.toHaveLength(0);
    await expect(createRetentionSignal(USER, { employee_name: '', signal_type: 'burnout', risk_score: 6 })).rejects.toThrow(/employee name is required/);
    await expect(createRetentionSignal(USER, { employee_name: 'Dave', signal_type: '', risk_score: 6 })).rejects.toThrow(/signal type is required/);
  });
});

describe('HIRING ASSISTANT (#146)', () => {
  beforeEach(() => { cleartables(); });

  it('creates an evaluation and scores with recommendation', async () => {
    const evalRow = await createHiringEvaluation(USER, { candidate_name: 'Jane Smith' });
    expect(evalRow.id).toMatch(/^hga-/);
    expect(evalRow.candidate_name).toBe('Jane Smith');
    expect(evalRow.status).toBe('PENDING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.hiring_evaluation_scored');

    const scored = await scoreHiringEvaluation(USER, evalRow.id, { interview_score: 8, take_home_score: 7, team_average: 7 });
    expect(scored.status).toBe('SCORED');
    expect(scored.calibrated_score).toBe(7.5);
    expect(scored.recommendation).toBe('HIRE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.hiring_evaluation_scored');
    await expect(scoreHiringEvaluation(USER, evalRow.id, { interview_score: 5, take_home_score: 5, team_average: 7 })).rejects.toThrow(/already scored/);
  });

  it('reports hiring assistant totals', async () => {
    await createHiringEvaluation(USER, { candidate_name: 'A' });
    const e2 = await createHiringEvaluation(USER, { candidate_name: 'B' });
    await scoreHiringEvaluation(USER, e2.id, { interview_score: 9, take_home_score: 9, team_average: 7 });

    const report = await hiringAssistantReport(USER);
    expect(report.evaluations).toBe(2);
    expect(report.scored).toBe(1);
    expect(report.hired).toBe(1);
    expect(report.pending).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const e = await createHiringEvaluation(USER, { candidate_name: 'Eve' });
    await expect(getHiringEvaluation(OTHER, e.id)).rejects.toThrow(/hiring_assistant_not_found/);
    await expect(listHiringEvaluations(OTHER)).resolves.toHaveLength(0);
    await expect(createHiringEvaluation(USER, { candidate_name: '' })).rejects.toThrow(/candidate name is required/);
  });
});
