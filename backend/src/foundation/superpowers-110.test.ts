/**
 * CodeConClave — Stage 110 SUPERPOWERS Tranche AF: Speculative Engineering,
 * Self-Evolving Toolchain, Org Simulator, Codebase Physics Engine,
 * Autonomous Tech Debt Market.
 *
 *   SPECULATIVE ENGINEERING (#148) — explore 3-5 architectural futures in parallel.
 *   SELF-EVOLVING TOOLCHAIN (#149) — analyze failures, adopt lessons.
 *   ORG SIMULATOR (#150)          — simulate org changes against historical data.
 *   CODEBASE PHYSICS ENGINE (#151)— living digital twin, simulate changes.
 *   TECH DEBT MARKET (#152)       — continuously price tech debt.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    speculative_engineering_lanes: [] as Array<Record<string, unknown>>,
    self_evolving_lessons: [] as Array<Record<string, unknown>>,
    org_simulator_runs: [] as Array<Record<string, unknown>>,
    codebase_physics_runs: [] as Array<Record<string, unknown>>,
    tech_debt_pricing_items: [] as Array<Record<string, unknown>>,
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
    SPECULATIVE_ENGINEERING: 'spl',
    SELF_EVOLVING: 'sev',
    ORG_SIMULATOR: 'osm',
    CODEBASE_PHYSICS: 'phz',
    TECH_DEBT_PRICE: 'tdp',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { openLane, measureLane, getLane, listLanes, speculativeEngineeringReport } from '../modules/superpowers/speculativeEngineering.js';
import { recordLesson, adoptLesson, getLesson, listLessons, selfEvolvingReport } from '../modules/superpowers/selfEvolvingToolchain.js';
import { createSimulation, runSimulation, getRun as getOrgRun, listRuns as listOrgRuns, orgSimulatorReport } from '../modules/superpowers/orgSimulator.js';
import { createPhysicsRun, simulatePhysics, getRun as getPhysicsRun, listRuns as listPhysicsRuns, codebasePhysicsReport } from '../modules/superpowers/codebasePhysics.js';
import { createDebtItem, scheduleFix, getItem, listItems, techDebtPricingReport } from '../modules/superpowers/techDebtPricing.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('SPECULATIVE ENGINEERING (#148)', () => {
  beforeEach(() => { cleartables(); });

  it('opens a lane and measures it', async () => {
    const lane = await openLane(USER, { hypothesis: 'event-driven architecture', alternatives: ['drop Redis', 'microservices', 'monolith vertical scale'] });
    expect(lane.id).toMatch(/^spl-/);
    expect(lane.hypothesis).toBe('event-driven architecture');
    expect(lane.alternatives).toEqual(['drop Redis', 'microservices', 'monolith vertical scale']);
    expect(lane.status).toBe('OPEN');
    expect(AUDIT_ACTIONS()).toContain('autonomy.speculation_lane_opened');

    const measured = await measureLane(USER, lane.id, { measured_result: 'microservices reduced latency by 23%' });
    expect(measured.status).toBe('MEASURED');
    expect(measured.measured_result).toContain('latency by 23%');
    expect(AUDIT_ACTIONS()).toContain('autonomy.speculation_lane_measured');
  });

  it('reports speculative engineering totals', async () => {
    await openLane(USER, { hypothesis: 'h1', alternatives: ['a1'] });
    const l2 = await openLane(USER, { hypothesis: 'h2', alternatives: ['a2'] });
    await measureLane(USER, l2.id, { measured_result: 'result' });

    const report = await speculativeEngineeringReport(USER);
    expect(report.lanes).toBe(2);
    expect(report.open).toBe(1);
    expect(report.measured).toBe(1);
    expect(report.discarded).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const lane = await openLane(USER, { hypothesis: 'h', alternatives: ['a'] });
    await expect(getLane(OTHER, lane.id)).rejects.toThrow(/speculative_engineering_lane_not_found/);
    await expect(listLanes(OTHER)).resolves.toHaveLength(0);
    await expect(openLane(USER, { hypothesis: '', alternatives: ['a'] })).rejects.toThrow(/hypothesis is required/);
    await expect(openLane(USER, { hypothesis: 'h', alternatives: [] })).rejects.toThrow(/at least one alternative/);
  });
});

describe('SELF-EVOLVING TOOLCHAIN (#149)', () => {
  beforeEach(() => { cleartables(); });

  it('records a lesson and adopts it', async () => {
    const lesson = await recordLesson(USER, { failure_description: 'agent hallucinated a non-existent API', lesson: 'always verify API existence before calling', source: 'code-review-agent' });
    expect(lesson.id).toMatch(/^sev-/);
    expect(lesson.failure_description).toBe('agent hallucinated a non-existent API');
    expect(lesson.status).toBe('PENDING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.toolchain_lesson_adopted');

    const adopted = await adoptLesson(USER, lesson.id);
    expect(adopted.status).toBe('ADOPTED');
    expect(adopted.adopted).toBe(true);
  });

  it('reports self-evolving totals', async () => {
    await recordLesson(USER, { failure_description: 'f1', lesson: 'l1', source: 's1' });
    const l2 = await recordLesson(USER, { failure_description: 'f2', lesson: 'l2', source: 's2' });
    await adoptLesson(USER, l2.id);

    const report = await selfEvolvingReport(USER);
    expect(report.lessons).toBe(2);
    expect(report.pending).toBe(1);
    expect(report.adopted).toBe(1);
    expect(report.discarded).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const lesson = await recordLesson(USER, { failure_description: 'f', lesson: 'l', source: 's' });
    await expect(getLesson(OTHER, lesson.id)).rejects.toThrow(/self_evolving_lesson_not_found/);
    await expect(listLessons(OTHER)).resolves.toHaveLength(0);
    await expect(recordLesson(USER, { failure_description: '', lesson: 'l', source: 's' })).rejects.toThrow(/failure description is required/);
    await expect(recordLesson(USER, { failure_description: 'f', lesson: '', source: 's' })).rejects.toThrow(/lesson is required/);
    await expect(recordLesson(USER, { failure_description: 'f', lesson: 'l', source: '' })).rejects.toThrow(/source is required/);
  });
});

describe('ORG SIMULATOR (#150)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a simulation and runs it', async () => {
    const run = await createSimulation(USER, { scenario: 'split platform team into 2 squads', baseline_metrics: { velocity: 42, satisfaction: 7 } });
    expect(run.id).toMatch(/^osm-/);
    expect(run.scenario).toBe('split platform team into 2 squads');
    expect(run.status).toBe('CREATED');

    const completed = await runSimulation(USER, run.id, { simulation_result: 'velocity increases to 50 within 2 quarters' });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.simulation_result).toContain('velocity increases');
    expect(AUDIT_ACTIONS()).toContain('autonomy.org_simulation_run');
  });

  it('reports org simulator totals', async () => {
    await createSimulation(USER, { scenario: 's1', baseline_metrics: { v: 1 } });
    const r2 = await createSimulation(USER, { scenario: 's2', baseline_metrics: { v: 2 } });
    await runSimulation(USER, r2.id, { simulation_result: 'good' });

    const report = await orgSimulatorReport(USER);
    expect(report.runs).toBe(2);
    expect(report.created).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.running).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const run = await createSimulation(USER, { scenario: 's', baseline_metrics: { v: 1 } });
    await expect(getOrgRun(OTHER, run.id)).rejects.toThrow(/org_simulator_run_not_found/);
    await expect(listOrgRuns(OTHER)).resolves.toHaveLength(0);
    await expect(createSimulation(USER, { scenario: '', baseline_metrics: { v: 1 } })).rejects.toThrow(/scenario is required/);
    await expect(createSimulation(USER, { scenario: 's', baseline_metrics: undefined as unknown as Record<string, unknown> })).rejects.toThrow(/baseline metrics are required/);
  });
});

describe('CODEBASE PHYSICS ENGINE (#151)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a physics run and simulates it', async () => {
    const run = await createPhysicsRun(USER, { change_description: 'switch from REST to gRPC', impact_metrics: { latency_ms: 120, cost_usd: 500 } });
    expect(run.id).toMatch(/^phz-/);
    expect(run.change_description).toBe('switch from REST to gRPC');
    expect(run.status).toBe('CREATED');

    const completed = await simulatePhysics(USER, run.id, { simulation_result: 'latency drops to 40ms, cost increases 15%' });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.simulation_result).toContain('latency drops');
    expect(AUDIT_ACTIONS()).toContain('autonomy.physics_simulation_run');
  });

  it('reports codebase physics totals', async () => {
    await createPhysicsRun(USER, { change_description: 'c1', impact_metrics: { v: 1 } });
    const r2 = await createPhysicsRun(USER, { change_description: 'c2', impact_metrics: { v: 2 } });
    await simulatePhysics(USER, r2.id, { simulation_result: 'ok' });

    const report = await codebasePhysicsReport(USER);
    expect(report.runs).toBe(2);
    expect(report.created).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.running).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const run = await createPhysicsRun(USER, { change_description: 'c', impact_metrics: { v: 1 } });
    await expect(getPhysicsRun(OTHER, run.id)).rejects.toThrow(/codebase_physics_run_not_found/);
    await expect(listPhysicsRuns(OTHER)).resolves.toHaveLength(0);
    await expect(createPhysicsRun(USER, { change_description: '', impact_metrics: { v: 1 } })).rejects.toThrow(/change description is required/);
    await expect(createPhysicsRun(USER, { change_description: 'c', impact_metrics: undefined as unknown as Record<string, unknown> })).rejects.toThrow(/impact metrics are required/);
  });
});

describe('AUTONOMOUS TECH DEBT MARKET (#152)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a debt item and schedules a fix', async () => {
    const item = await createDebtItem(USER, { debt_description: 'outdated auth middleware', fix_cost_days: 3, ignore_cost_days: 40, urgency_score: 8 });
    expect(item.id).toMatch(/^tdp-/);
    expect(item.debt_description).toBe('outdated auth middleware');
    expect(item.fix_cost_days).toBe(3);
    expect(item.ignore_cost_days).toBe(40);
    expect(item.urgency_score).toBe(8);
    expect(item.status).toBe('PRICED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.debt_priced');

    const scheduled = await scheduleFix(USER, item.id);
    expect(scheduled.status).toBe('FIX_SCHEDULED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.debt_fix_scheduled');
  });

  it('reports tech debt pricing totals', async () => {
    await createDebtItem(USER, { debt_description: 'd1', fix_cost_days: 1, ignore_cost_days: 5, urgency_score: 3 });
    const i2 = await createDebtItem(USER, { debt_description: 'd2', fix_cost_days: 2, ignore_cost_days: 10, urgency_score: 5 });
    await scheduleFix(USER, i2.id);

    const report = await techDebtPricingReport(USER);
    expect(report.items).toBe(2);
    expect(report.priced).toBe(1);
    expect(report.fix_scheduled).toBe(1);
    expect(report.fixed).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const item = await createDebtItem(USER, { debt_description: 'd', fix_cost_days: 1, ignore_cost_days: 2, urgency_score: 5 });
    await expect(getItem(OTHER, item.id)).rejects.toThrow(/tech_debt_pricing_item_not_found/);
    await expect(listItems(OTHER)).resolves.toHaveLength(0);
    await expect(createDebtItem(USER, { debt_description: '', fix_cost_days: 1, ignore_cost_days: 2, urgency_score: 5 })).rejects.toThrow(/debt description is required/);
    await expect(createDebtItem(USER, { debt_description: 'd', fix_cost_days: -1, ignore_cost_days: 2, urgency_score: 5 })).rejects.toThrow(/fix cost days must be a non-negative/);
  });
});
