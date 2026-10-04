/**
 * Regression: SQLSTATE 42703 in the coworker VERIFYING stage.
 *
 * `plan_entries` has no `task_id` column. A task reaches its plan entries
 * through `plans` (plans.task_id is UNIQUE; plan_entries references plans(id)).
 * The old statement `SELECT acceptance_criteria FROM plan_entries
 * WHERE task_id = $1 ...` therefore raised 42703 on every run, aborting
 * VERIFYING, so no agent task could ever reach COMPLETED with artifacts.
 *
 * These tests drive the REAL runCoworker against a mock pool that rejects
 * exactly that mistake the way Postgres does, and assert the full lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A pool mock that records SQL and enforces the plan_entries schema the way
// Postgres does: referencing task_id on plan_entries is SQLSTATE 42703.
const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  type Resolver = (text: string, params: unknown[]) => unknown[];
  let resolver: Resolver | null = null;

  const assertSchema = (text: string) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    const touchesPlanEntries = /\bFROM\s+plan_entries\b/i.test(sql) || /\bJOIN\s+plan_entries\b/i.test(sql);
    if (!touchesPlanEntries) return;
    // The join must go through plans; otherwise `task_id` is not a column of
    // plan_entries and Postgres aborts the statement.
    const joinsViaPlans = /\bJOIN\s+plans\b/i.test(sql);
    if (!joinsViaPlans && /\btask_id\b/i.test(sql)) {
      const err = new Error('column "task_id" does not exist') as Error & { code?: string };
      err.code = '42703';
      throw err;
    }
  };

  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    assertSchema(text);
    const rows = resolver ? resolver(text, params) : [];
    return { rows };
  };

  return {
    calls,
    setResolver: (fn: Resolver | null) => { resolver = fn; },
    reset: () => { calls.length = 0; resolver = null; },
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

// Coworker output text and the verifier verdict both come from the gateway.
// The verifier answers PASS so the happy path is observable end to end.
const completeWithFallback = vi.hoisted(() =>
  vi.fn(async (arg: { messages?: { content?: string }[] }) => {
    const isVerifier = JSON.stringify(arg?.messages ?? []).includes('verification engine');
    return { text: isVerifier ? 'PASS' : 'coworker output', model: 'mock' };
  }),
);
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'memory') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import { runCoworker } from '../modules/execution/coworkers.js';

const RUN = {
  id: 'crw_1',
  task_id: 'tsk_1',
  coworker_type: 'CODER',
  order_index: 1,
  state: 'QUEUED',
  input: {},
  output: null,
  verification_result: null,
  error_code: null,
  timeout_ms: 1800000,
  started_at: null,
  completed_at: null,
  parallel_group: null,
};
const CTX = { userId: 'usr_1', title: 'Task', description: null, plan: null, projectId: null };

/**
 * Route the mock pool the way the real schema demands:
 *  - users            -> the caller's plan_id
 *  - plan_entries pe  -> acceptance criteria for this pipeline entry (via plans)
 *  - coworker_runs    -> the persisted run, with output so the verifier can judge it
 */
const resolver = (criteria: string | null) => (text: string) => {
  const sql = text.replace(/\s+/g, ' ');
  if (/FROM users/i.test(sql)) return [{ id: 'usr_1', plan_id: 'free' }];
  if (/FROM coworker_runs/i.test(sql)) {
    return [{ ...RUN, output: { text: 'coworker output' }, state: 'VERIFYING' }];
  }
  if (/FROM plan_entries pe/i.test(sql)) {
    return criteria ? [{ acceptance_criteria: criteria }] : [];
  }
  return [];
};

beforeEach(() => {
  db.reset();
  completeWithFallback.mockClear();
});

describe('coworker VERIFYING stage — plan_entries lookup (SQLSTATE 42703 regression)', () => {
  it('reproduces the old failure: a plan_entries query without the plans join throws 42703', async () => {
    // This is the exact shape the code used to emit.
    await expect(
      db.withSystem((q) =>
        q.query('SELECT acceptance_criteria FROM plan_entries WHERE task_id = $1 AND order_index = $2', ['tsk_1', 1]),
      ),
    ).rejects.toThrowError(/column "task_id" does not exist/);
  });

  it('completes the lifecycle and records artifacts when criteria exist', async () => {
    db.setResolver(resolver('All unit tests pass and the API contract is unchanged.'));

    await runCoworker({ ...RUN }, CTX);

    const sql = db.calls.map((c) => c.text.replace(/\s+/g, ' '));
    const criteria = sql.find((t) => /FROM plan_entries pe/i.test(t));
    expect(criteria, 'the plan_entries lookup must go through plans').toBeDefined();
    expect(criteria).toMatch(/JOIN plans p ON p\.id = pe\.plan_id/i);
    expect(criteria).toMatch(/p\.task_id = \$1/);
    expect(criteria).toMatch(/pe\.order_index = \$2/);

    // VERIFYING -> a real verifier judges the declared criteria.
    const stateWrites = db.calls.filter((c) => /UPDATE coworker_runs SET state/i.test(c.text)).map((c) => c.params[1]);
    expect(stateWrites).toContain('RUNNING');
    expect(stateWrites).toContain('VERIFYING');

    const verifierCall = completeWithFallback.mock.calls.find((c) =>
      JSON.stringify(c[0]?.messages ?? []).includes('verification engine'),
    );
    expect(verifierCall, 'a verifier must judge the declared criteria').toBeDefined();

    // The verdict is persisted, and the run reaches its successful terminal state.
    const outParams = db.calls.find((c) => /UPDATE coworker_runs SET output/i.test(c.text))?.params ?? [];
    expect(outParams[2], 'verification_result must be PASS').toBe('PASS');
    expect(stateWrites.at(-1), 'terminal state must be COMPLETED').toBe('COMPLETED');

    // No statement ever referenced task_id on plan_entries.
    expect(db.calls.map((c) => c.text.replace(/\s+/g, ' '))
      .filter((t) => /\bFROM\s+plan_entries\b/i.test(t))
      .every((t) => /\bJOIN\s+plans\b/i.test(t))).toBe(true);
  });

  it('skips verification honestly when the plan entry declares no criteria', async () => {
    db.setResolver(resolver(null));

    await runCoworker({ ...RUN }, CTX);

    const verifierCall = completeWithFallback.mock.calls.find((c) =>
      JSON.stringify(c[0]?.messages ?? []).includes('verification engine'),
    );
    expect(verifierCall, 'no criteria means no verifier').toBeUndefined();
    expect(completeWithFallback).toHaveBeenCalledTimes(1); // only the coworker output

    const outParams = db.calls.find((c) => /UPDATE coworker_runs SET output/i.test(c.text))?.params ?? [];
    expect(outParams[2], 'verification_result must be SKIPPED').toBe('SKIPPED');
  });

  it('guards the schema relationship: no query may reference task_id on plan_entries', async () => {
    db.setResolver(resolver('criteria'));
    await runCoworker({ ...RUN }, CTX);

    for (const { text } of db.calls) {
      const sql = text.replace(/\s+/g, ' ');
      if (/\bFROM\s+plan_entries\b/i.test(sql)) {
        expect(sql, `plan_entries must be reached via plans: ${sql}`).toMatch(/\bJOIN\s+plans\b/i);
      }
    }
  });
});
