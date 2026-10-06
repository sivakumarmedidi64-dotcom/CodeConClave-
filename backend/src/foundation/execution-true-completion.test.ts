/**
 * Regression: a task must only report SUCCESSFUL completion when it actually
 * earned it.
 *
 * Live evidence gathered 2026-10-05 against commit 1850598 (all real production
 * tasks, free TEMPORARY_DEMO_MODE account):
 *
 *  - BUG 1 — `tsk_jof04v40ey9vbldu361z` and `tsk_t3rd00erf9fq9aub6lst` both came
 *    back COMPLETED with a published deliverable even though the REVIEWER
 *    returned verification_result = 'FAIL' ("missing timeout handling",
 *    "too generic"). The orchestrator wrote VERIFIED/COMPLETED unconditionally,
 *    so a failing review was indistinguishable from a passing one.
 *  - BUG 2 — `tsk_kdx6nw42ks8pn4nmkfg4` published `write-runbook-md-with-three-
 *    sections-output.md` with verification = SKIPPED on every run, because the
 *    verifier could not be reached ("All configured models failed (billing)").
 *    An unverified deliverable was published as if it had been checked.
 *  - BUG 3 — the same session burned retries on premium-only stages:
 *    ARCHITECT and SECURITY failed once with "Premium compute requires an
 *    entitled plan (Pro/Team/Enterprise) / All configured models failed" before
 *    recovering, because a free demo account has no class-C model eligible.
 *  - BUG 4 — `tsk_jof04v40ey9vbldu361z` was COMPLETED while still carrying the
 *    previous attempt's failure_reason and recovery_status = 'RETRYING'.
 *
 * The terminal-success contract asserted here:
 *   COMPLETED requires: every stage completed, no run returned FAIL, the
 *   deliverable's own verification is PASS when the plan required it, a
 *   deliverable exists, and the final task row carries no stale failure state.
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

vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback: vi.fn(async () => ({ text: '{}', model: 'mock' })) }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'ctx') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));
vi.mock('../modules/workspace/service.js', () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock('../modules/dna/service.js', () => ({ autoSaveTaskDna: vi.fn(async () => {}) }));
vi.mock('../modules/preview/service.js', () => ({ previewTaskCompleted: vi.fn(async () => {}) }));
vi.mock('../modules/automations/events.js', () => ({ emitTaskCompleted: vi.fn(async () => {}), emitTaskFailed: vi.fn(async () => {}) }));
vi.mock('../modules/agents/service.js', () => ({ agentTaskChanged: vi.fn(async () => {}) }));
vi.mock('../shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const store = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  persisted: new Map<string, Record<string, unknown>>(),
  artifacts: [] as Array<Record<string, unknown>>,
}));

const coworkers = vi.hoisted(() => ({
  createCoworkerRun: vi.fn(async (input: Record<string, unknown>) => {
    const run = {
      id: `crw_${store.created.length + 1}`, task_id: input.taskId,
      coworker_type: input.coworkerType, order_index: input.orderIndex,
      state: 'QUEUED', input: input.runInput ?? {}, output: null,
      verification_result: null, error_code: null, timeout_ms: 1800000,
      started_at: null, completed_at: null, parallel_group: input.parallelGroup ?? null,
    };
    store.created.push(run);
    return run;
  }),
  runCoworker: vi.fn(async () => {}),
  recordHandoff: vi.fn(async () => {}),
  saveCoworkerArtifact: vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: `art_${store.artifacts.length + 1}`, ...input };
    store.artifacts.push(row);
    return row;
  }),
  listCoworkerRuns: vi.fn(async () => store.created.map((r) => ({
    ...r,
    output: store.persisted.get(r.id as string)?.output ?? null,
    verification_result: store.persisted.get(r.id as string)?.verification_result ?? 'SKIPPED',
    error_code: store.persisted.get(r.id as string)?.error_code ?? null,
  }))),
}));
vi.mock('../modules/execution/coworkers.js', () => coworkers);

import { executeTask } from '../modules/execution/orchestrator.js';
import { TASK_TIMEOUT_MS } from '../modules/execution/tasks.js';

const DELIVERABLE = '{"changes":[{"path":"RUNBOOK.md","content":"1. Overview 2. Setup 3. First Steps"}]}';

function taskRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, project_id: 'p1', conversation_id: null, owner_id: 'u1',
    title: 'Runbook', description: 'Write the runbook',
    plan: null, status: 'RUNNING', risk_level: 'LOW', required_approval: false, approval_id: null,
    coworker_pipeline: null, execution_mode: 'CLOUD', timeout_ms: TASK_TIMEOUT_MS,
    started_at: new Date(), completed_at: null, failed_at: null,
    error_code: null, error_detail: null, attempt_count: 0, max_attempts: 3,
    last_heartbeat_at: new Date(), watchdog_checked_at: null, priority: 0,
    failure_reason: null, recovery_status: 'NONE', retry_count: 0,
    next_attempt_at: null, dead_letter_at: null, requires_review_reason: null,
    created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

/** RESEARCH + CODER + REVIEWER, every entry declaring acceptance criteria. */
function resolver(task: Record<string, unknown>, criteria: unknown = 'c') {
  let plansReads = 0;
  return (text: string, params: unknown[]) => {
    if (text.includes('COALESCE(MAX(attempt_number)')) return [{ n: 0 }];
    if (text.includes('FROM task_attempts') && text.includes('WHERE id = $1')) {
      return [{ id: String(params[0]), task_id: task.id, attempt_number: 1, started_at: new Date() }];
    }
    if (text.includes('FROM task_steps') && text.includes('WHERE id = $1')) {
      return [{ id: String(params[0]), task_id: task.id, attempt_id: 'atp_1', kind: 'x', title: 'y', status: 'RUNNING', started_at: new Date() }];
    }
    if (text.includes('FROM users')) return [{ plan_id: 'free' }];
    if (text.includes('FROM plans')) {
      plansReads += 1;
      if (plansReads === 1) return null;
      return [{ id: 'pln_1', task_id: task.id, goal: 'Write the runbook', status: 'ACTIVE', risk_level: 'LOW', estimated_work: null }];
    }
    if (text.includes('FROM plan_entries')) {
      return [
        { id: 'pne_1', plan_id: 'pln_1', order_index: 0, coworker_type: 'RESEARCH', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: criteria, expected_artifacts: [] },
        { id: 'pne_2', plan_id: 'pln_1', order_index: 1, coworker_type: 'CODER', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: criteria, expected_artifacts: [] },
        { id: 'pne_3', plan_id: 'pln_1', order_index: 2, coworker_type: 'REVIEWER', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: criteria, expected_artifacts: [] },
      ];
    }
    if (text.includes('FROM tasks')) return [task];
    return null;
  };
}

type Verdict = { text: string; verification_result: string; error_code?: string };

function stageVerdicts(verdicts: Record<string, Verdict>) {
  coworkers.runCoworker.mockImplementation(async (r: Record<string, unknown>) => {
    const v = verdicts[String(r.coworker_type)]!;
    store.persisted.set(r.id as string, {
      output: { text: v.text },
      verification_result: v.verification_result,
      error_code: v.error_code ?? null,
    });
  });
}

const PASSING: Record<string, Verdict> = {
  RESEARCH: { text: 'research notes', verification_result: 'PASS' },
  CODER: { text: DELIVERABLE, verification_result: 'PASS' },
  REVIEWER: { text: 'PASS — the runbook is complete.', verification_result: 'PASS' },
};

const statusWrites = () => db.calls.filter((c) => c.text.includes('UPDATE tasks SET status = $2')).map((c) => c.params[1]);
const artifact = (kind: string) => store.artifacts.find((a) => a.kind === kind);

beforeEach(() => {
  db.reset();
  store.created.length = 0;
  store.persisted.clear();
  store.artifacts.length = 0;
  for (const m of Object.values(coworkers)) (m as { mockClear: () => void }).mockClear();
  stageVerdicts(PASSING);
});

describe('terminal success contract — the guarantees that must be retained', () => {
  it('a PASS pipeline completes, publishes the deliverable and separates the review', async () => {
    const task = taskRow('tsk_ok');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(statusWrites().at(-1)).toBe('COMPLETED');
    expect(store.artifacts.length).toBe(2);
    expect(String(artifact('output')!.content)).toContain('RUNBOOK.md');
    expect(artifact('output')!.verification).toBe('PASS');
    // The deliverable is bound to the producing CODER stage, never the reviewer.
    expect(artifact('output')!.runId).toBe('crw_2');
    expect(String(artifact('review')!.content)).toContain('the runbook is complete');
    expect(artifact('review')!.runId).toBe('crw_3');
  });

  it('a successful attempt records the attempt as SUCCESS', async () => {
    const task = taskRow('tsk_ok2');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(db.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'SUCCESS')).toBe(true);
  });

  it('artifact verification reflects the deliverable run verdict, never an invented PASS', async () => {
    // No run in this pipeline earned a verdict, so the artifact must say
    // SKIPPED. A deliverable is never relabelled PASS by borrowing some other
    // stage's result or by defaulting on an absent value.
    stageVerdicts({
      RESEARCH: { text: 'notes', verification_result: 'SKIPPED' },
      CODER: { text: DELIVERABLE, verification_result: 'SKIPPED' },
      REVIEWER: { text: 'fine', verification_result: 'SKIPPED' },
    });
    const task = taskRow('tsk_borrow');
    db.setResolver(resolver(task, null));

    await executeTask(task as never);

    expect(artifact('output')!.verification).toBe('SKIPPED');
    expect(store.artifacts.some((a) => a.verification === 'PASS')).toBe(false);
  });
});

describe('BUG 1 — a FAIL verdict must not produce successful completion', () => {
  it('a REVIEWER FAIL parks the task in REQUIRES_REVIEW instead of COMPLETED', async () => {
    stageVerdicts({ ...PASSING, REVIEWER: { text: 'FAIL — missing timeout handling.', verification_result: 'FAIL' } });
    const task = taskRow('tsk_revfail');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(statusWrites()).toContain('REQUIRES_REVIEW');
    expect(statusWrites()).not.toContain('COMPLETED');
  });

  it('a REVIEWER FAIL publishes no deliverable at all', async () => {
    stageVerdicts({ ...PASSING, REVIEWER: { text: 'FAIL — missing timeout handling.', verification_result: 'FAIL' } });
    const task = taskRow('tsk_revfail2');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(store.artifacts.length).toBe(0);
  });

  it('a REVIEWER FAIL never relabels the artifact as PASS', async () => {
    stageVerdicts({ ...PASSING, REVIEWER: { text: 'FAIL', verification_result: 'FAIL' } });
    const task = taskRow('tsk_revfail3');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(store.artifacts.some((a) => a.verification === 'PASS')).toBe(false);
  });

  it('the review failure is preserved and visible on the task row', async () => {
    stageVerdicts({ ...PASSING, REVIEWER: { text: 'FAIL — too generic.', verification_result: 'FAIL' } });
    const task = taskRow('tsk_revfail4');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const reviewWrite = db.calls.find((c) => c.text.includes('requires_review_reason = $2'));
    expect(reviewWrite, 'requires_review_reason is written').toBeDefined();
    expect(String(reviewWrite!.params[1])).toMatch(/reviewer verification returned FAIL/i);
  });

  it('a FAIL verdict from any producing stage also blocks completion', async () => {
    stageVerdicts({ ...PASSING, CODER: { text: DELIVERABLE, verification_result: 'FAIL' } });
    const task = taskRow('tsk_coderfail');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(statusWrites()).not.toContain('COMPLETED');
    expect(store.artifacts.length).toBe(0);
  });

  it('the attempt is recorded as FAILURE so the history shows why', async () => {
    stageVerdicts({ ...PASSING, REVIEWER: { text: 'FAIL', verification_result: 'FAIL' } });
    const task = taskRow('tsk_revfail5');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(db.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'FAILURE')).toBe(true);
  });
});

describe('BUG 2 — a required SKIPPED verification must not look successful', () => {
  it('an unreachable verifier on the deliverable blocks COMPLETED', async () => {
    // Live tsk_kdx6nw42: every run was SKIPPED because the verifier could not be
    // reached, and the deliverable was published anyway.
    stageVerdicts({
      RESEARCH: { text: 'notes', verification_result: 'PASS' },
      CODER: { text: DELIVERABLE, verification_result: 'SKIPPED', error_code: 'verification_unavailable' },
      REVIEWER: { text: 'FAIL', verification_result: 'SKIPPED', error_code: 'verification_unavailable' },
    });
    const task = taskRow('tsk_skip');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(statusWrites()).not.toContain('COMPLETED');
    expect(store.artifacts.length).toBe(0);
  });

  it('an unreachable verifier routes through the existing retry policy', async () => {
    stageVerdicts({
      RESEARCH: { text: 'notes', verification_result: 'PASS' },
      CODER: { text: DELIVERABLE, verification_result: 'SKIPPED', error_code: 'verification_unavailable' },
      REVIEWER: { text: 'x', verification_result: 'PASS' },
    });
    const task = taskRow('tsk_skip_retry');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    // retryOrDeadLetter -> scheduleRetry: status CREATED, recovery RETRYING, backoff.
    const retryWrite = db.calls.find((c) => c.text.includes('recovery_status = $2') && c.text.includes('retry_count = retry_count + 1'));
    expect(retryWrite, 'the existing retry path is used').toBeDefined();
    expect(retryWrite!.params[1]).toBe('RETRYING');
    expect(statusWrites()).not.toContain('COMPLETED');
  });

  it('the resume checkpoint is dropped so the retry really re-verifies', async () => {
    stageVerdicts({
      RESEARCH: { text: 'notes', verification_result: 'PASS' },
      CODER: { text: DELIVERABLE, verification_result: 'SKIPPED', error_code: 'verification_unavailable' },
      REVIEWER: { text: 'x', verification_result: 'PASS' },
    });
    const task = taskRow('tsk_skip_cp');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    // Without this the next attempt resumes the same SKIPPED runs and
    // dead-letters without ever retrying verification.
    expect(db.calls.some((c) => c.text.includes('SET checkpoint = NULL'))).toBe(true);
  });

  it('the unverified attempt is recorded as FAILURE with the reason', async () => {
    stageVerdicts({
      RESEARCH: { text: 'notes', verification_result: 'PASS' },
      CODER: { text: DELIVERABLE, verification_result: 'SKIPPED', error_code: 'verification_unavailable' },
      REVIEWER: { text: 'x', verification_result: 'PASS' },
    });
    const task = taskRow('tsk_skip_att');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const fail = db.calls.find((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'FAILURE');
    expect(fail).toBeDefined();
    expect(String(fail!.params[2] ?? '')).toMatch(/verification is SKIPPED/i);
  });

  it('a stage the plan never asked to verify may still complete', async () => {
    // No acceptance criteria anywhere: verification was never required, so a
    // SKIPPED verdict is honest rather than a blocked completion.
    stageVerdicts({
      RESEARCH: { text: 'notes', verification_result: 'SKIPPED' },
      CODER: { text: DELIVERABLE, verification_result: 'SKIPPED' },
      REVIEWER: { text: 'fine', verification_result: 'SKIPPED' },
    });
    const task = taskRow('tsk_nocrit');
    db.setResolver(resolver(task, null));

    await executeTask(task as never);

    expect(statusWrites().at(-1)).toBe('COMPLETED');
    expect(artifact('output')!.verification).toBe('SKIPPED');
  });
});

describe('BUG 4 — a successful retry must clear stale final failure state', () => {
  it('clears failure_reason and error_code before writing COMPLETED', async () => {
    const task = taskRow('tsk_stale', {
      failure_reason: 'Premium compute requires an entitled plan (Pro/Team/Enterprise)',
      error_code: 'no_eligible_model',
      error_detail: 'gateway',
      recovery_status: 'RETRYING',
      retry_count: 1,
    });
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const clear = db.calls.find((c) => c.text.includes('SET failure_reason = NULL'));
    expect(clear, 'stale failure state is cleared').toBeDefined();
    expect(clear!.text).toMatch(/error_code = NULL/);
    expect(clear!.text).toMatch(/requires_review_reason = NULL/);
  });

  it('marks a previously retried task RECOVERED rather than leaving RETRYING', async () => {
    const task = taskRow('tsk_stale2', { recovery_status: 'RETRYING', failure_reason: 'boom' });
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const clear = db.calls.find((c) => c.text.includes('SET failure_reason = NULL'))!;
    expect(clear.text).toMatch(/recovery_status = CASE WHEN recovery_status = 'NONE' THEN 'NONE' ELSE 'RECOVERED' END/);
    expect(statusWrites().at(-1)).toBe('COMPLETED');
  });

  it('leaves a never-failed task at recovery_status NONE', async () => {
    const task = taskRow('tsk_stale3');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const clear = db.calls.find((c) => c.text.includes('SET failure_reason = NULL'))!;
    expect(clear.text).toMatch(/CASE WHEN recovery_status = 'NONE' THEN 'NONE' ELSE 'RECOVERED' END/);
  });

  it('clears the state before the terminal COMPLETED write', async () => {
    const task = taskRow('tsk_stale4', { failure_reason: 'boom', recovery_status: 'RETRYING' });
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const clearIdx = db.calls.findIndex((c) => c.text.includes('SET failure_reason = NULL'));
    const completedIdx = db.calls.findIndex((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'COMPLETED');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeLessThan(completedIdx);
  });

  it('attempt history is never erased by the cleanup', async () => {
    const task = taskRow('tsk_stale5', { failure_reason: 'boom', retry_count: 2 });
    db.setResolver(resolver(task));

    await executeTask(task as never);

    // Only the tasks row is cleaned; the attempt/steps/runs tables keep writing.
    expect(db.calls.filter((c) => c.text.includes('INSERT INTO task_steps')).length).toBeGreaterThan(0);
    expect(db.calls.some((c) => c.text.includes('DELETE FROM task_attempts'))).toBe(false);
  });
});