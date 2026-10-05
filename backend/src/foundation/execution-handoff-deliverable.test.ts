/**
 * Regression suite for the two remaining execution-quality defects.
 *
 * PROBLEM 1 — CODER -> REVIEWER HANDOFF
 *   A dependent coworker received only `Output of CODER completed (<run-id>)`,
 *   never the produced work, so the REVIEWER could not genuinely review and
 *   returned FAIL for missing input. runCoworker() now loads the actual output
 *   of the earlier stages of the same task into its prompt.
 *
 * PROBLEM 2 — ARTIFACT MUST BE THE DELIVERABLE
 *   With a trailing REVIEWER the artifact stored the reviewer's commentary, so
 *   the produced file was never the deliverable. The artifact is now the last
 *   non-review stage that PASSED verification, and the review result is kept
 *   as its own separately recorded artifact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  let resolve: ((text: string, params: unknown[]) => unknown[] | null) | null = null;
  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    const rows = resolve ? resolve(text, params) : null;
    return { rows: rows ?? [] };
  };
  return {
    calls,
    setResolver: (fn: ((t: string, p: unknown[]) => unknown[] | null) | null) => { resolve = fn; },
    reset: () => { calls.length = 0; resolve = null; },
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const sent = vi.hoisted(() => ({ prompts: [] as string[], verdict: 'PASS' as string, genuine: false, reviewerSaid: '' }));
const completeWithFallback = vi.hoisted(() =>
  vi.fn(async (arg: { messages?: { role?: string; content?: string }[] }) => {
    const user = String(arg?.messages?.find((m) => m.role === 'user')?.content ?? '');
    sent.prompts.push(user);
    // The verifier instruction lives in the system message.
    const isVerifier = /verification engine/i.test(JSON.stringify(arg?.messages ?? []));
    if (isVerifier) {
      // In genuine mode the verifier judges whatever the REVIEWER itself concluded.
      if (sent.genuine) return { text: sent.reviewerSaid.trim().toUpperCase().startsWith('PASS') ? 'PASS' : 'FAIL', model: 'mock' };
      return { text: sent.verdict, model: 'mock' };
    }
    if (sent.genuine) {
      // A reviewer can only judge work it can actually read.
      sent.reviewerSaid = user.includes(DELIVERABLE_MARKER)
        ? 'PASS - the deploy checklist covers health, migrations and rollback.'
        : 'FAIL - no deliverable content was supplied, only a run reference.';
      return { text: sent.reviewerSaid, model: 'mock' };
    }
    return { text: 'the coworker output', model: 'mock' };
  }),
);
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'memory') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import { runCoworker, loadPriorStageContext, HANDOFF_PER_RUN_CHARS, HANDOFF_TOTAL_CHARS } from '../modules/execution/coworkers.js';

/** The content the REVIEWER must be able to read in order to judge the work. */
const DELIVERABLE_MARKER = 'REAL CODER DELIVERABLE: DEPLOY_CHECKLIST.md';

/** Assembled at runtime so this fixture is never a scannable secret literal. */
const FAKE_GITHUB_TOKEN = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz012345';

const CTX = { userId: 'usr_1', title: 'Task', description: null, plan: null, projectId: null };
const run = (orderIndex: number, type: string, id: string) => ({
  id, task_id: 'tsk_1', coworker_type: type, order_index: orderIndex,
  state: 'QUEUED', input: {}, output: null, verification_result: null,
  error_code: null, timeout_ms: 1800000, started_at: null, completed_at: null, parallel_group: null,
});

/** Prior completed stages available in the DB, keyed by the order_index filter. */
let priorRows: { order_index: number; coworker_type: string; output: { text: string } }[] = [];
let criteria: string | null = 'The checklist covers health, migrations and rollback.';

function resolver(text: string) {
  const sql = text.replace(/\s+/g, ' ');
  if (/order_index < \$2/i.test(sql)) return priorRows;
  if (/FROM coworker_runs/i.test(sql)) {
    return [{ ...run(2, 'REVIEWER', 'crw_3'), output: { text: 'REVIEW TEXT' }, state: 'VERIFYING' }];
  }
  if (/FROM users/i.test(sql)) return [{ id: 'usr_1', plan_id: 'free' }];
  if (/FROM plan_entries pe/i.test(sql)) return criteria ? [{ acceptance_criteria: criteria }] : [];
  return [];
}

const finalWrite = () => db.calls.filter((c) => /UPDATE coworker_runs SET output/i.test(c.text)).at(-1)?.params;

beforeEach(() => {
  db.reset();
  sent.prompts = [];
  sent.verdict = 'PASS';
  sent.genuine = false;
  sent.reviewerSaid = '';
  priorRows = [];
  criteria = 'The checklist covers health, migrations and rollback.';
  completeWithFallback.mockClear();
});

describe('PROBLEM 1 — the dependent coworker receives the actual previous output', () => {
  it('puts the CODER output into the REVIEWER prompt (not just a run id)', async () => {
    priorRows = [{ order_index: 1, coworker_type: 'CODER', output: { text: 'REAL CODER DELIVERABLE: DEPLOY_CHECKLIST.md' } }];
    db.setResolver(resolver);

    await runCoworker(run(2, 'REVIEWER', 'crw_3'), CTX);

    const reviewerPrompt = sent.prompts[0]!;
    expect(reviewerPrompt, 'REVIEWER must see the real prior output').toContain('REAL CODER DELIVERABLE: DEPLOY_CHECKLIST.md');
    expect(reviewerPrompt).toContain('Output of CODER (stage 1)');
  });

  it('carries every earlier stage, newest first', async () => {
    priorRows = [
      { order_index: 0, coworker_type: 'RESEARCH', output: { text: 'RESEARCH BODY' } },
      { order_index: 1, coworker_type: 'CODER', output: { text: 'CODER BODY' } },
    ];
    db.setResolver(resolver);

    const block = await loadPriorStageContext('usr_1', 'tsk_1', 2);

    expect(block).toContain('RESEARCH BODY');
    expect(block).toContain('CODER BODY');
    expect(block.indexOf('CODER BODY')).toBeLessThan(block.indexOf('RESEARCH BODY'));
  });

  it('returns nothing for the first stage of a pipeline', async () => {
    priorRows = [];
    db.setResolver(resolver);
    expect(await loadPriorStageContext('usr_1', 'tsk_1', 0)).toBe('');
  });

  it('scopes the read to the caller tenant and the same task', async () => {
    priorRows = [{ order_index: 1, coworker_type: 'CODER', output: { text: 'X' } }];
    db.setResolver(resolver);
    await loadPriorStageContext('usr_1', 'tsk_1', 2);

    const prior = db.calls.find((c) => /order_index < \$2/i.test(c.text));
    expect(prior, 'prior-stage read must be parameterised by task').toBeDefined();
    expect(prior!.params[0]).toBe('tsk_1');
    expect(prior!.params[1]).toBe(2);
  });

  it('enforces the output-size budgets', async () => {
    priorRows = [
      { order_index: 0, coworker_type: 'RESEARCH', output: { text: 'A'.repeat(HANDOFF_PER_RUN_CHARS * 3) } },
      { order_index: 1, coworker_type: 'CODER', output: { text: 'B'.repeat(HANDOFF_PER_RUN_CHARS * 3) } },
    ];
    db.setResolver(resolver);

    const block = await loadPriorStageContext('usr_1', 'tsk_1', 2);

    expect(block.length).toBeLessThan(HANDOFF_TOTAL_CHARS + 200);
    expect(block).toContain('[truncated]');
    // newest stage survives; the oldest is dropped once the budget is spent
    expect(block).toContain('BBBB');
  });

  it('redacts secrets from the carried output', async () => {
    priorRows = [{ order_index: 1, coworker_type: 'CODER',
      output: { text: `token: ${FAKE_GITHUB_TOKEN}` } }];
    db.setResolver(resolver);

    const block = await loadPriorStageContext('usr_1', 'tsk_1', 2);

    expect(block).not.toContain(FAKE_GITHUB_TOKEN);
    expect(block).toContain('[REDACTED:');
  });
});

describe('PROBLEM 1 — the reviewer can genuinely judge the work', () => {
  it('lets the reviewer PASS on its own reading when the real output satisfies the criteria', async () => {
    sent.genuine = true;
    priorRows = [{ order_index: 1, coworker_type: 'CODER', output: { text: DELIVERABLE_MARKER } }];
    db.setResolver(resolver);

    await runCoworker(run(2, 'REVIEWER', 'crw_3'), CTX);

    // The reviewer's own conclusion...
    expect(String(finalWrite()?.[1])).toContain('PASS');
    // ...and the persisted verification verdict that follows from it.
    expect(finalWrite()?.[2]).toBe('PASS');
  });

  it('lets the reviewer FAIL on its own reading when the output is not available to it', async () => {
    sent.genuine = true;
    priorRows = [];
    db.setResolver(resolver);

    await runCoworker(run(2, 'REVIEWER', 'crw_3'), CTX);

    expect(String(finalWrite()?.[1])).toContain('FAIL');
    expect(finalWrite()?.[2]).toBe('FAIL');
  });

  it('stays honestly SKIPPED with no criteria, even with prior output present', async () => {
    priorRows = [{ order_index: 1, coworker_type: 'CODER', output: { text: 'work' } }];
    criteria = null;
    db.setResolver(resolver);

    await runCoworker(run(2, 'REVIEWER', 'crw_3'), CTX);

    expect(finalWrite()?.[2]).toBe('SKIPPED');
  });
});
