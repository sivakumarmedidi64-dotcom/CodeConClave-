/**
 * CodeConClave — Stage 101 SUPERPOWERS Tranche W: Infra Architect (#92),
 * Regression Radar (#96). Shadow Deploy (#93), Release Commander (#94),
 * Regression Timeline (#95) already covered by prior tranche tests.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    infra_architect_plans: [] as Array<Record<string, unknown>>,
    regression_radar_entries: [] as Array<Record<string, unknown>>,
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
    INFRA_ARCHITECT_PLAN: 'iap',
    REGRESSION_RADAR_ENTRY: 'rre',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createInfraPlan, validatePlan, applyPlan, getInfraPlan, listInfraPlans, infraArchitectReport } from '../modules/superpowers/infraArchitect.js';
import { logRegression, markFixWorked, getRegressionEntry, getRegressionsForModule, listRegressionEntries, regressionRadarReport } from '../modules/superpowers/regressionRadar.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('INFRA ARCHITECT (#92)', () => {
  beforeEach(() => { cleartables(); });

  it('turns a plain-English infra request into a validated Terraform diff', async () => {
    const plan = await createInfraPlan(USER, { request: 'Add a Redis cache in front of this endpoint, autoscale 2 to 10 pods' });
    expect(plan.id).toMatch(/^iap-/);
    expect(plan.resource_type).toBe('redis');
    expect(plan.estimated_changes.length).toBeGreaterThan(0);
    expect(plan.estimated_changes).toContain('autoscaling policy');
    expect(plan.estimated_changes).toContain('cache instance');
    expect(plan.iac_diff).toContain('# CodeConClave Infra Architect');
    expect(plan.iac_diff).toContain('resource "redis" "main"');
    expect(plan.iac_diff).toContain('num_cache_nodes');
    expect(plan.status).toBe('DRAFT');
    expect(AUDIT_ACTIONS()).toContain('autonomy.infra_plan_created');
  });

  it('validates then applies a plan only in order', async () => {
    const plan = await createInfraPlan(USER, { request: 'Add a Redis cache in front of this endpoint' });
    const validated = await validatePlan(USER, plan.id);
    expect(validated.status).toBe('VALIDATED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.infra_plan_validated');
    await expect(applyPlan(USER, plan.id)).resolves.toMatchObject({ status: 'APPLIED' });
    expect(AUDIT_ACTIONS()).toContain('autonomy.infra_plan_applied');
    await expect(validatePlan(USER, plan.id)).rejects.toThrow(/DRAFT/);
    await expect(applyPlan(USER, plan.id)).rejects.toThrow(/VALIDATED/);
  });

  it('detects common resource types from natural language', async () => {
    const redis = await createInfraPlan(USER, { request: 'put a redis cache between the api and store' });
    expect(redis.resource_type).toBe('redis');
    const compute = await createInfraPlan(USER, { request: 'scale compute pods from 2 to 10 autoscaling' });
    expect(compute.resource_type).toBe('compute');
    expect(compute.estimated_changes).toContain('autoscaling policy');
    const q = await createInfraPlan(USER, { request: 'add a queue to decouple billing' });
    expect(q.resource_type).toBe('queue');
    const report = await infraArchitectReport(USER);
    expect(report.plans).toBe(3);
  });

  it('validates and stays owner-scoped', async () => {
    const plan = await createInfraPlan(USER, { request: 'Add a Redis cache in front of this endpoint' });
    await expect(getInfraPlan(OTHER, plan.id)).rejects.toThrow(/infra_plan_not_found/);
    await expect(listInfraPlans(OTHER)).resolves.toHaveLength(0);
    await expect(createInfraPlan(USER, { request: '' })).rejects.toThrow(/at least 5 characters/);
    await expect(createInfraPlan(USER, { request: 'x' })).rejects.toThrow(/at least 5 characters/);
  });
});

describe('REGRESSION RADAR (#96)', () => {
  beforeEach(() => { cleartables(); });

  it('logs a regression and shows every fix that worked for a module', async () => {
    const entry = await logRegression(USER, {
      module: 'billing',
      issue_description: 'double charge on checkout retry',
      root_cause: 'idempotency key dropped on retry',
      severity: 'HIGH',
    });
    expect(entry.id).toMatch(/^rre-/);
    expect(entry.module).toBe('billing');
    expect(entry.severity).toBe('HIGH');
    expect(entry.fix_worked).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('autonomy.regression_radar_logged');
    await markFixWorked(USER, entry.id, 'reuse idempotency key on retry');
    const [view] = await getRegressionsForModule(USER, 'billing');
    expect(view.fix_worked).toBe(true);
    expect(view.fix_description).toBe('reuse idempotency key on retry');
    expect(view.fixed_at).not.toBeNull();
    expect(AUDIT_ACTIONS()).toContain('autonomy.regression_fix_confirmed');
  });

  it('defaults severity and reports totals per severity', async () => {
    await logRegression(USER, { module: 'auth', issue_description: 'session leak' });
    await logRegression(USER, { module: 'auth', issue_description: 'token rotation gap', severity: 'CRITICAL' });
    await logRegression(USER, { module: 'payments', issue_description: 'refund race', severity: 'CRITICAL' });
    const report = await regressionRadarReport(USER);
    expect(report.entries).toBe(3);
    expect(report.modules).toBe(2);
    expect(report.fixes_pending).toBe(3);
    expect(report.by_severity.CRITICAL).toBe(2);
    expect(report.by_severity.MEDIUM).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const entry = await logRegression(USER, { module: 'billing', issue_description: 'double charge on checkout retry' });
    await expect(getRegressionEntry(OTHER, entry.id)).rejects.toThrow(/regression_entry_not_found/);
    await expect(listRegressionEntries(OTHER)).resolves.toHaveLength(0);
    await expect(getRegressionsForModule(OTHER, 'billing')).resolves.toHaveLength(0);
    await expect(logRegression(USER, { module: '', issue_description: 'x' })).rejects.toThrow(/module name is required/);
    await expect(logRegression(USER, { module: 'billing', issue_description: '' })).rejects.toThrow(/issue description is required/);
    const e2 = await logRegression(USER, { module: 'auth', issue_description: 'token rotation gap' });
    await markFixWorked(USER, entry.id, 'retry idempotency fix');
    await expect(markFixWorked(USER, entry.id, 'second fix')).rejects.toThrow(/already marked/);
    await expect(markFixWorked(OTHER, e2.id, 'x')).rejects.toThrow(/regression_entry_not_found/);
  });
});