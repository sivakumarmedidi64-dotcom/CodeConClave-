/**
 * Regression: the verifier never actually executed.
 *
 * runCoworker() used to call verifyCoworkerRun() BEFORE setRunOutput(), and
 * verifyCoworkerRun() re-reads the run row and returns 'SKIPPED' when
 * `output` is absent (`if (!run || !run.output) return 'SKIPPED'`). Because the
 * output only reached coworker_runs.output afterwards, the verifier model was
 * never invoked and every run in production was recorded verification_result =
 * 'SKIPPED' — even with non-null acceptance_criteria.
 *
 * The mock pool here models reality: the run row starts with output: null and
 * is only filled by the code's own UPDATE, so verifying before the write is
 * observable instead of hidden by an over-helpful fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  events: [] as string[],
  reset: () => { store.row = null; store.events.length = 0; },
}));

const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push({ text: sql, params });

    // The row is filled ONLY by the code under test.
    if (/UPDATE coworker_runs SET output/i.test(sql)) {
      store.events.push('write-output');
      if (store.row) {
        store.row.output = params[1];
        store.row.verification_result = params[2] ?? null;
      }
      return { rows: [] };
    }
    if (/UPDATE coworker_runs SET state/i.test(sql)) {
      store.events.push(`state:${String(params[1])}`);
      if (store.row) store.row.state = params[1];
      return { rows: [] };
    }
    if (/FROM coworker_runs/i.test(sql)) {
      store.events.push('read-run');
      return { rows: store.row ? [{ ...store.row }] : [] };
    }
    if (/FROM users/i.test(sql)) return { rows: [{ id: 'usr_1', plan_id: 'free' }] };
    if (/FROM plan_entries pe/i.test(sql)) {
      store.events.push('read-criteria');
      const c = store.row?.criteria as string | undefined;
      return { rows: c ? [{ acceptance_criteria: c }] : [] };
    }
    return { rows: [] };
  };
  return {
    calls,
    reset: () => { calls.length = 0; },
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

// Captures what the run row held at the instant the verifier model was called.
const seen = vi.hoisted(() => ({ outputAtVerifyTime: undefined as unknown, verdict: 'PASS' }));
const completeWithFallback = vi.hoisted(() =>
  vi.fn(async (arg: { messages?: { content?: string }[] }) => {
    const isVerifier = JSON.stringify(arg?.messages ?? []).includes('verification engine');
    if (isVerifier) {
      seen.outputAtVerifyTime = store.row ? JSON.parse(JSON.stringify(store.row.output ?? null)) : null;
      store.events.push('verify-model');
      return { text: seen.verdict, model: 'mock' };
    }
    return { text: 'the coworker output', model: 'mock' };
  }),
);
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'memory') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import { runCoworker } from '../modules/execution/coworkers.js';

const RUN = {
  id: 'crw_1', task_id: 'tsk_1', coworker_type: 'CODER', order_index: 1,
  state: 'QUEUED', input: {}, output: null, verification_result: null,
  error_code: null, timeout_ms: 1800000, started_at: null, completed_at: null,
  parallel_group: null,
};
const CTX = { userId: 'usr_1', title: 'Task', description: null, plan: null, projectId: null };

function freshRun(criteria: string | null) {
  store.reset();
  // Production shape: output is null until the code persists it.
  store.row = { ...RUN, output: null, verification_result: null, criteria };
  seen.outputAtVerifyTime = undefined;
  seen.verdict = 'PASS';
  db.reset();
  completeWithFallback.mockClear();
}

const verifierCalled = () => store.events.includes('verify-model');

beforeEach(() => { seen.verdict = 'PASS'; });

describe('B/C. the verifier actually executes against the declared criteria', () => {
  it('runs the verifier against criteria and persists PASS', async () => {
    freshRun('The output must contain concrete onboarding steps.');
    await runCoworker({ ...RUN }, CTX);

    expect(verifierCalled(), 'the verifier model must actually execute').toBe(true);
    expect(store.row!.verification_result).toBe('PASS');
    expect(store.row!.state).toBe('COMPLETED');
  });

  it('has the real output persisted BEFORE the verifier judges it', async () => {
    freshRun('The output must contain concrete onboarding steps.');
    await runCoworker({ ...RUN }, CTX);

    // The ordering bug: with output still null at verify time the verifier
    // returned SKIPPED and never called the model.
    expect(seen.outputAtVerifyTime).not.toBeNull();
    expect(JSON.parse(String(seen.outputAtVerifyTime))).toEqual({ text: 'the coworker output' });
    expect(store.events.indexOf('write-output')).toBeLessThan(store.events.indexOf('verify-model'));
    expect(store.events.indexOf('write-output')).toBeLessThan(store.events.indexOf('read-criteria'));
  });
});

describe('F. a failing verdict still fails', () => {
  it('persists FAIL — never PASS or SKIPPED — when the verifier rejects the output', async () => {
    freshRun('The output must contain concrete onboarding steps.');
    seen.verdict = 'FAIL';
    await runCoworker({ ...RUN }, CTX);

    expect(verifierCalled()).toBe(true);
    expect(store.row!.verification_result).toBe('FAIL');
    expect(store.row!.verification_result).not.toBe('PASS');
  });

  it('stays honestly SKIPPED when no criteria were declared', async () => {
    freshRun(null);
    await runCoworker({ ...RUN }, CTX);

    expect(verifierCalled(), 'no criteria means no verifier call').toBe(false);
    expect(completeWithFallback).toHaveBeenCalledTimes(1); // coworker output only
    expect(store.row!.verification_result).toBe('SKIPPED');
  });
});
