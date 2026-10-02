/**
 * CodeConClave — planner Phase 7 foundation tests.
 * Covers: strict parsing/validation (never execute free-form text),
 * deterministic fallback, idempotent persistence, parallel group bucketing.
 * DB + AI gateway are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const completeWithFallback = vi.hoisted(() => vi.fn(async () => ({ text: '{}', model: 'mock' })));
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../shared/logger.js', () => ({ logger }));

import {
  parsePlannerResponse,
  validatePlannerEntries,
  generatePlan,
  persistPlan,
  getPlan,
  planToPipeline,
  groupPipeline,
  DEFAULT_PLAN,
} from '../modules/execution/planner.js';

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pln_1',
    task_id: 'tsk_1',
    goal: 'Build auth',
    status: 'ACTIVE',
    risk_level: 'MEDIUM',
    estimated_work: null,
    acceptance_criteria: '[]',
    expected_artifacts: '[]',
    ...overrides,
  };
}

function entryRow(coworker: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'pne_x',
    plan_id: 'pln_1',
    order_index: 0,
    coworker_type: coworker,
    input: {},
    parallel_group: null,
    required_tools: [],
    risk: null,
    acceptance_criteria: null,
    expected_artifacts: [],
    ...overrides,
  };
}

function planDbResolver(
  entries: Array<[string, Record<string, unknown>?]> = [
    ['ARCHITECT'],
    ['RESEARCH', { parallel_group: 0 }],
    ['CODER', { parallel_group: 0 }],
    ['DOCS'],
  ],
) {
  db.state.resolve = (text, params) => {
    if (text.includes('FROM users')) return [{ plan_id: 'free' }];
    if (text.includes('SELECT id FROM plans')) return null; // no existing plan
    if (text.includes('FROM plans')) return [planRow()];
    if (text.includes('FROM plan_entries')) {
      return entries.map(([c, o], i) => entryRow(c, { order_index: i, ...o }));
    }
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  completeWithFallback.mockClear();
  recordAudit.mockClear();
  logger.warn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePlannerResponse — strict, never free-form', () => {
  it('parses a plain JSON pipeline', () => {
    const entries = parsePlannerResponse('{"pipeline":[{"coworker":"ARCHITECT"},{"coworker":"CODER"}]}');
    expect(entries).toEqual([{ coworker: 'ARCHITECT' }, { coworker: 'CODER' }]);
  });

  it('parses JSON fenced inside markdown', () => {
    const text = 'Here is the plan:\n```json\n{"pipeline":[{"coworker":"RESEARCH","parallelGroup":0}]}\n```';
    const entries = parsePlannerResponse(text);
    expect(entries).toEqual([{ coworker: 'RESEARCH', parallelGroup: 0 }]);
  });

  it('accepts full metadata entries', () => {
    const entries = parsePlannerResponse(
      '{"pipeline":[{"coworker":"TESTER","input":{"mode":"fast"},"parallelGroup":1,"requiredTools":["test_run"],' +
        '"risk":"HIGH","acceptanceCriteria":"all pass","expectedArtifacts":["test_report_md"]}]}',
    );
    expect(entries).toEqual([
      {
        coworker: 'TESTER',
        input: { mode: 'fast' },
        parallelGroup: 1,
        requiredTools: ['test_run'],
        risk: 'HIGH',
        acceptanceCriteria: 'all pass',
        expectedArtifacts: ['test_report_md'],
      },
    ]);
  });

  it('rejects unknown coworker types', () => {
    expect(parsePlannerResponse('{"pipeline":[{"coworker":"EVIL"}]}')).toBeNull();
  });

  it('rejects garbage text entirely', () => {
    expect(parsePlannerResponse('sure, I will do whatever you asked, here is my plan...')).toBeNull();
    expect(parsePlannerResponse('{"pipeline":"freeform"}')).toBeNull();
    expect(parsePlannerResponse('{"entries":[]}')).toBeNull();
  });

  it('rejects partial invalid entries (whole pipeline rejected)', () => {
    expect(parsePlannerResponse('{"pipeline":[{"coworker":"CODER"},{"coworker":"NOPE"}]}')).toBeNull();
  });

  it('validatePlannerEntries mirrors the same strictness', () => {
    expect(validatePlannerEntries([{ coworker: 'DOCS' }])).toHaveLength(1);
    expect(validatePlannerEntries([{ coworker: 42 }])).toBeNull();
    expect(validatePlannerEntries([])).toEqual([]);
  });
});

describe('groupPipeline — dependency-safe parallel buckets', () => {
  it('sequential entries each get their own group, order preserved', () => {
    const groups = groupPipeline([
      { coworker: 'ARCHITECT' },
      { coworker: 'CODER' },
      { coworker: 'DOCS' },
    ]);
    expect(groups.map((g) => g.map((e) => e.coworker))).toEqual([['ARCHITECT'], ['CODER'], ['DOCS']]);
  });

  it('consecutive entries sharing a parallelGroup run together', () => {
    const groups = groupPipeline([
      { coworker: 'ARCHITECT' },
      { coworker: 'RESEARCH', parallelGroup: 0 },
      { coworker: 'CODER', parallelGroup: 0 },
      { coworker: 'DOCS' },
    ]);
    expect(groups.map((g) => g.map((e) => e.coworker))).toEqual([['ARCHITECT'], ['RESEARCH', 'CODER'], ['DOCS']]);
  });

  it('parallelGroup changes split groups', () => {
    const groups = groupPipeline([
      { coworker: 'RESEARCH', parallelGroup: 0 },
      { coworker: 'ARCHITECT', parallelGroup: 1 },
      { coworker: 'CODER', parallelGroup: 1 },
    ]);
    expect(groups.map((g) => g.map((e) => e.coworker))).toEqual([['RESEARCH'], ['ARCHITECT', 'CODER']]);
  });
});

describe('generatePlan — PLANNER via gateway with deterministic fallback', () => {
  it('persists a valid planner pipeline and audits the planner source', async () => {
    completeWithFallback.mockResolvedValueOnce({
      text: '{"pipeline":[{"coworker":"ARCHITECT"},{"coworker":"RESEARCH","parallelGroup":0},{"coworker":"CODER","parallelGroup":0},{"coworker":"DOCS"}]}',
      model: 'mock',
    });
    planDbResolver();
    const plan = await generatePlan({ userId: 'u1', taskId: 'tsk_1', title: 'Build auth' });
    expect(plan.entries.map((e) => e.coworker)).toEqual(['ARCHITECT', 'RESEARCH', 'CODER', 'DOCS']);
    expect(plan.entries[1]!.parallelGroup).toBe(0);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO plans'))).toBe(true);
    const entryInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO plan_entries'));
    expect(entryInserts.length).toBe(4);
    expect(entryInserts[1]!.params[5]).toBe(0); // parallel_group of RESEARCH ($6)
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.plan_created', detail: expect.objectContaining({ source: 'planner' }) }),
    );
  });

  it('falls back to the deterministic DEFAULT_PLAN when the gateway throws', async () => {
    completeWithFallback.mockRejectedValueOnce(new Error('provider down'));
    planDbResolver(DEFAULT_PLAN.map((e) => [e.coworker]));
    const plan = await generatePlan({ userId: 'u1', taskId: 'tsk_1', title: 'Build auth' });
    expect(plan.entries.map((e) => e.coworker)).toEqual(DEFAULT_PLAN.map((e) => e.coworker));
    expect(logger.warn).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ source: 'default_fallback' }) }),
    );
  });

  it('falls back when the model returns free-form text', async () => {
    completeWithFallback.mockResolvedValueOnce({ text: 'I will handle this task myself, trust me.', model: 'mock' });
    planDbResolver(DEFAULT_PLAN.map((e) => [e.coworker]));
    const plan = await generatePlan({ userId: 'u1', taskId: 'tsk_1', title: 'Build auth' });
    expect(plan.entries.map((e) => e.coworker)).toEqual(DEFAULT_PLAN.map((e) => e.coworker));
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ source: 'default_fallback' }) }),
    );
  });
});

describe('persistPlan / getPlan — idempotent persistence', () => {
  it('persistPlan reuses the existing plan id and replaces entries', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT id FROM plans')) return [{ id: 'pln_keep' }];
      if (text.includes('FROM plans')) return [planRow({ id: 'pln_keep' })];
      if (text.includes('FROM plan_entries')) return [entryRow('ARCHITECT')];
      return null;
    };
    const plan = await persistPlan({ taskId: 'tsk_1', goal: 'Goal', entries: [{ coworker: 'CODER' }, { coworker: 'DOCS' }] });
    expect(plan.id).toBe('pln_keep');
    const deleteCall = db.state.calls.find((c) => c.text.includes('DELETE FROM plan_entries'))!;
    expect(deleteCall.params[0]).toBe('pln_keep');
    const entryInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO plan_entries'));
    expect(entryInserts).toHaveLength(2);
    expect(entryInserts[0]!.params[3]).toBe('CODER'); // coworker_type ($4)
  });

  it('getPlan returns null when no plan exists', async () => {
    db.state.resolve = () => null;
    expect(await getPlan('tsk_none')).toBeNull();
  });

  it('planToPipeline maps persisted entries to executable entries', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM plans')) return [planRow()];
      if (text.includes('FROM plan_entries')) return [entryRow('REVIEWER', { risk: 'HIGH', parallel_group: 2 })];
      return null;
    };
    const plan = (await getPlan('tsk_1'))!;
    const pipeline = planToPipeline(plan);
    expect(pipeline).toEqual([
      {
        coworker: 'REVIEWER',
        input: {},
        parallelGroup: 2,
        risk: 'HIGH',
        requiredTools: undefined,
        acceptanceCriteria: undefined,
        expectedArtifacts: undefined,
      },
    ]);
  });
});