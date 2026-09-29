/**
 * CodeConClave — PHASE 17 failure matrix, categories 12-15.
 *
 * Categories 1-11 live in failures-15.test.ts (infra/health honesty). These
 * four complete the 15-category matrix at the EXECUTION level, running the
 * real orchestrator + planner + coworker code against the in-memory SQL
 * emulation with a controllable AI gateway:
 *   12. mid-pipeline coworker crash → persisted FAILED step/run/attempt + retry decision; never crashes the app
 *   13. worker crash recovery → resumes from the persisted checkpoint, reuses runs, never re-runs or regenerates the plan
 *   14. verification evidence gate → SKIPPED without a verifier, never claims verified
 *   15. planner AI outage → deterministic DEFAULT_PLAN fallback persisted with honest source audit, never fabricated
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { calls: { text: string; params: unknown[] }[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = { calls: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: (rows ?? []).length };
  };
  return {
    state,
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

// Controllable AI gateway: rejects exactly the sessions each category needs.
const completeWithFallback = vi.hoisted(() => vi.fn(async () => ({ text: 'Done' })));
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));

const USER_ID = 'u1';

interface Emulated {
  tasks: Record<string, unknown>[];
  attempts: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  plans: Record<string, unknown>[];
  planEntries: Record<string, unknown>[];
  dlq: Record<string, unknown>[];
}

function setup(): Emulated {
  const t: Emulated = { tasks: [], attempts: [], steps: [], runs: [], plans: [], planEntries: [], dlq: [] };
  db.state.resolve = (text, params) => {
    const s = text.toLowerCase();

    if (s.includes('select plan_id from users')) return [{ id: USER_ID, plan_id: 'free' }];
    if (s.includes('select team_id from projects')) return [];
    if (s.includes('from projects where id = $1')) return [{ id: String(params[0]), owner_id: USER_ID, team_id: null, deleted_at: null }];
    if (s.includes('from notifications')) return [];

    if (s.includes('from tasks') && s.includes('where id = $1')) {
      return t.tasks.filter((x) => x.id === params[0]);
    }
    if (s.includes('update tasks') && s.includes('last_heartbeat_at')) return [];
    if (s.includes('update tasks') && s.includes('recovery_status = $2') && !s.includes('dead_lettered')) {
      const task = t.tasks.find((x) => x.id === params[0])!;
      task.status = 'CREATED';
      task.recovery_status = params[1];
      task.retry_count = (task.retry_count as number) + 1;
      task.next_attempt_at = new Date(Date.now() + Number(params[2] ?? 0)).toISOString();
      task.failure_reason = params[3] ?? task.failure_reason;
      task.error_code = params[4] ?? task.error_code;
      task.error_detail = params[5] ?? task.error_detail;
      task.failed_at = null;
      task.completed_at = null;
      return [];
    }
    if (s.includes('update tasks') && s.includes("recovery_status = 'DEAD_LETTERED'")) {
      const task = t.tasks.find((x) => x.id === params[0])!;
      task.recovery_status = 'DEAD_LETTERED';
      task.dead_letter_at = new Date().toISOString();
      task.failure_reason = params[1] ?? task.failure_reason;
      return [];
    }
    if (s.includes('update tasks')) {
      const task = t.tasks.find((x) => x.id === params[0]);
      if (!task) return [];
      const m = text.match(/status = \$(\d+)/i);
      if (m) task.status = params[Number(m[1]) - 1];
      const ec = text.match(/error_code = \$(\d+)/i);
      if (ec) task.error_code = params[Number(ec[1]) - 1];
      if (text.includes("'COMPLETED'") || task.status === 'COMPLETED') task.completed_at = new Date().toISOString();
      if (text.includes("'FAILED'") || text.includes("'TIMED_OUT'")) task.failed_at = new Date().toISOString();
      return [];
    }
    if (s.includes('insert into tasks')) {
      t.tasks.push({
        id: params[0], project_id: params[1], conversation_id: params[2], owner_id: params[3],
        title: params[4], description: params[5], status: 'CREATED', risk_level: params[6],
        required_approval: params[7], coworker_pipeline: params[8], execution_mode: params[9],
        timeout_ms: params[10], max_attempts: params[11], priority: params[12],
        attempt_count: 0, retry_count: 0, recovery_status: 'NONE', error_code: null, error_detail: null,
        failure_reason: null, next_attempt_at: null, completed_at: null, failed_at: null,
        started_at: null, last_heartbeat_at: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
      });
      return [];
    }

    if (s.includes('from task_attempts') && s.includes('max(attempt_number)')) {
      const nums = t.attempts.filter((a) => a.task_id === params[0]).map((a) => Number(a.attempt_number));
      return [{ n: (nums.length ? Math.max(...nums) : 0) + 1 }];
    }
    if (s.includes('from task_attempts') && s.includes('checkpointed_at is not null')) {
      const row = t.attempts
        .filter((a) => a.task_id === params[0] && a.id !== params[1] && a.checkpointed_at)
        .sort((a, b) => String(b.checkpointed_at).localeCompare(String(a.checkpointed_at)))[0];
      return row ? [{ checkpoint: row.checkpoint }] : [];
    }
    if (s.includes('from task_attempts') && s.includes('where id = $1')) {
      return t.attempts.filter((a) => a.id === params[0]);
    }
    if (s.includes('from task_attempts')) return t.attempts.filter((a) => a.task_id === params[0]);
    if (s.includes('insert into task_attempts')) {
      t.attempts.push({
        id: params[0], task_id: params[1], attempt_number: params[2], started_at: new Date().toISOString(),
        result: null, error_code: null, output_summary: null, checkpoint: null, checkpointed_at: null, finished_at: null,
      });
      return [];
    }
    if (s.includes('update task_attempts set checkpoint')) {
      const attempt = t.attempts.find((a) => a.id === params[0])!;
      attempt.checkpoint = JSON.parse(String(params[1]));
      attempt.checkpointed_at = new Date().toISOString();
      return [];
    }
    if (s.includes('update task_attempts set')) {
      const attempt = t.attempts.find((a) => a.id === params[0])!;
      attempt.result = params[1];
      attempt.error_code = params[2] ?? null;
      attempt.output_summary = params[3] ?? null;
      attempt.finished_at = new Date().toISOString();
      return [];
    }

    if (s.includes('from task_steps') && s.includes('where id = $1')) return t.steps.filter((x) => x.id === params[0]);
    if (s.includes('from task_steps')) return t.steps.filter((x) => x.task_id === params[0]);
    if (s.includes('insert into task_steps')) {
      t.steps.push({
        id: params[0], task_id: params[1], attempt_id: params[2], kind: params[3], title: params[4],
        status: 'RUNNING', detail: null, output: null, error_code: null, started_at: new Date().toISOString(), completed_at: null,
      });
      return [];
    }
    if (s.includes('update task_steps')) {
      const step = t.steps.find((x) => x.id === params[0])!;
      step.status = params[1];
      step.detail = params[2] ? JSON.parse(String(params[2])) : step.detail;
      step.output = params[3] ?? step.output;
      step.error_code = params[4] ?? step.error_code;
      step.completed_at = new Date().toISOString();
      return [];
    }

    if (s.includes('select id from plans where task_id')) return t.plans.filter((p) => p.task_id === params[0]).map((p) => ({ id: p.id }));
    if (s.includes('from plans where task_id')) return t.plans.filter((p) => p.task_id === params[0]);
    if (s.includes('insert into plans')) {
      const existing = t.plans.find((p) => p.task_id === params[1]);
      if (existing) {
        existing.goal = params[2];
        existing.status = 'ACTIVE';
      } else {
        t.plans.push({
          id: params[0], task_id: params[1], goal: params[2], status: 'ACTIVE', risk_level: params[3],
          estimated_work: params[4], acceptance_criteria: JSON.parse(String(params[5])), expected_artifacts: JSON.parse(String(params[6])),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
      return [];
    }
    if (s.includes('delete from plan_entries')) {
      t.planEntries = t.planEntries.filter((e) => e.plan_id !== params[0]);
      return [];
    }
    if (s.includes('insert into plan_entries')) {
      t.planEntries.push({
        id: params[0], plan_id: params[1], order_index: params[2], coworker_type: params[3],
        input: JSON.parse(String(params[4])), parallel_group: params[5], depends_on: JSON.parse(String(params[6])),
        required_tools: JSON.parse(String(params[7])), risk: params[8], acceptance_criteria: params[9],
        expected_artifacts: JSON.parse(String(params[10])),
      });
      return [];
    }
    if (s.includes('from plan_entries')) {
      return t.planEntries.filter((e) => e.plan_id === params[0]).sort((a, b) => Number(a.order_index) - Number(b.order_index));
    }

    if (s.includes('select id from coworker_runs')) {
      return t.runs
        .filter((r) => r.task_id === params[0] && r.coworker_type === params[1] && r.order_index === params[2])
        .map((r) => ({ id: r.id }));
    }
    if (s.includes('from coworker_runs') && s.includes('where id = $1')) return t.runs.filter((r) => r.id === params[0]);
    if (s.includes('from coworker_runs')) return t.runs.filter((r) => r.task_id === params[0]).sort((a, b) => Number(a.order_index) - Number(b.order_index));
    if (s.includes('insert into coworker_runs')) {
      const existing = t.runs.find((r) => r.task_id === params[1] && r.coworker_type === params[2] && r.order_index === params[3]);
      if (existing) {
        existing.input = JSON.parse(String(params[4]));
        return [];
      }
      t.runs.push({
        id: params[0], task_id: params[1], coworker_type: params[2], order_index: params[3], state: 'QUEUED',
        input: JSON.parse(String(params[4])), timeout_ms: params[5], parallel_group: params[6],
        output: null, verification_result: null, error_code: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      return [];
    }
    if (s.includes('update coworker_runs set state')) {
      const run = t.runs.find((r) => r.id === params[0])!;
      run.state = params[1];
      run.error_code = params[2] ?? run.error_code;
      return [];
    }
    if (s.includes('update coworker_runs set')) {
      const run = t.runs.find((r) => r.id === params[0])!;
      run.output = params[1] ? JSON.parse(String(params[1])) : run.output;
      run.verification_result = params[2] ?? run.verification_result;
      return [];
    }

    if (s.includes('insert into coworker_handoffs')) return [];
    if (s.includes('insert into coworker_artifacts')) return [];
    if (s.includes('from coworker_artifacts')) return [];
    if (s.includes('insert into task_dlq')) {
      t.dlq.push({ id: params[0], task_id: params[1], project_id: params[2], owner_id: params[3], title: params[4], reason: params[5], error_code: params[6], error_detail: params[7], attempts: params[8] });
      return [];
    }
    if (s.includes('from task_dlq')) return t.dlq.filter((d) => d.task_id === params[0]);
    if (s.includes('from task_dependencies')) return [];
    if (s.includes('update tasks set last_heartbeat_at')) return [];

    return [];
  };
  return t;
}

async function seedCloudTask(t: Emulated, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { createTask } = await import('../modules/execution/tasks.js');
  const task = await createTask({
    userId: USER_ID,
    projectId: 'p1',
    title: 'Ship the feature',
    description: 'Full pipeline job',
    riskLevel: 'LOW',
    executionMode: 'CLOUD',
    maxAttempts: 3,
    ...overrides,
  });
  return task;
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  completeWithFallback.mockReset();
  completeWithFallback.mockResolvedValue({ text: 'Done' });
});

describe('FAILURE CATEGORY 12 — mid-pipeline coworker crash', () => {
  it('persists the FAILED step, run and attempt with the retry decision — the app never crashes', async () => {
    const t = setup();
    completeWithFallback.mockImplementation(async (args: { ctx?: { sessionId?: string } }) => {
      if (String(args.ctx?.sessionId ?? '').startsWith('coworker:')) throw new Error('all providers unavailable');
      return { text: 'Done' };
    });
    const task = await seedCloudTask(t);
    const { executeTask } = await import('../modules/execution/orchestrator.js');
    await expect(executeTask(task)).resolves.toBeUndefined();

    const failedRun = t.runs.find((r) => r.order_index === 0)!;
    expect(failedRun.state).toBe('FAILED');
    const failedStep = t.steps.find((x) => x.status === 'FAILED' && x.kind !== 'plan')!;
    expect(failedStep).toBeDefined();
    expect(failedStep.error_code).toBe('coworker_error');
    const attempt = t.attempts[0]!;
    expect(attempt.result).toBe('FAILURE');
    const stored = t.tasks[0]!;
    expect(stored.status).toBe('CREATED');
    expect(stored.recovery_status).toBe('RETRYING');
    expect(stored.retry_count).toBe(1);
    expect(stored.next_attempt_at).toBeTruthy();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.failed', detail: expect.objectContaining({ decision: 'RETRIED' }) }),
    );
  });
});

describe('FAILURE CATEGORY 13 — worker crash recovery resumes from the checkpoint', () => {
  it('reuses the persisted run, never re-runs it and never regenerates the plan', async () => {
    const t = setup();
    let coworkerCalls = 0;
    completeWithFallback.mockImplementation(async (args: { ctx?: { sessionId?: string } }) => {
      if (String(args.ctx?.sessionId ?? '').startsWith('coworker:')) {
        coworkerCalls += 1;
        if (coworkerCalls === 2) throw new Error('worker killed mid-pipeline');
      }
      return { text: 'Done' };
    });
    const task = await seedCloudTask(t);
    const { executeTask } = await import('../modules/execution/orchestrator.js');
    // The worker claims a task before executing (queue.ts claimNextTask flips
    // CREATED → RUNNING); the PKG-25 state-machine guard rejects CREATED →
    // VERIFIED, so the fixture must model the claim exactly as production does.
    t.tasks[0]!.status = 'RUNNING';
    await executeTask(task);

    // Crash persisted: attempt 1 FAILURE with a checkpoint after stage 1.
    expect(t.attempts[0]!.result).toBe('FAILURE');
    expect(t.attempts[0]!.checkpoint).toBeTruthy();

    // Re-claim and re-execute (the retried worker).
    t.tasks[0]!.status = 'RUNNING';
    await executeTask(t.tasks[0]!);
    const stored = t.tasks[0]!;
    expect(stored.status).toBe('COMPLETED');

    // The stage-0 run was created exactly once: attempt 2 reused it.
    const run0 = t.runs.filter((r) => r.order_index === 0);
    expect(run0.length).toBe(1);
    const resumedStep = t.steps.find((x) => x.kind === 'ARCHITECT' && x.status === 'COMPLETED' && x.detail && (x.detail as { resumed?: boolean }).resumed === true)!;
    expect(resumedStep).toBeDefined();
    expect(resumedStep.kind).toBe('ARCHITECT');

    // The plan was never regenerated: a single persisted plan for the task.
    expect(t.plans.length).toBe(1);
    // Resume was honoured end-to-end: plan step of attempt 2 reports resumed.
    const planStep = t.steps.find((x) => x.kind === 'plan' && x.detail && (x.detail as { resumed?: boolean }).resumed === true)!;
    expect(planStep).toBeDefined();
    // The completed run that crashed (stage 1) was re-run on the new attempt.
    const rerun = t.runs.find((r) => r.order_index === 1)!;
    expect(rerun.state).toBe('COMPLETED');
  });
});

describe('FAILURE CATEGORY 14 — verification evidence gate', () => {
  it('a pipeline without a verifier is SKIPPED, never claimed verified', async () => {
    const t = setup();
    const task = await seedCloudTask(t);
    const { executeTask } = await import('../modules/execution/orchestrator.js');
    t.tasks[0]!.status = 'RUNNING'; // worker claim (queue.ts) precedes executeTask
    await executeTask(task);

    const verifyStep = t.steps.find((x) => x.kind === 'verify')!;
    expect(verifyStep.status).toBe('SKIPPED');
    expect((verifyStep.detail as { reason?: string }).reason).toBe('no verifier executed');
    const artifact = db.state.calls.find((c) => c.text.includes('INSERT INTO coworker_artifacts'))!;
    expect(artifact).toBeDefined();
    expect(t.tasks[0]!.status).toBe('COMPLETED');
  });
});

describe('FAILURE CATEGORY 15 — planner AI outage falls back deterministically', () => {
  it('persists the DEFAULT_PLAN with honest source audit — never fabricated', async () => {
    const t = setup();
    completeWithFallback.mockImplementation(async (args: { ctx?: { sessionId?: string } }) => {
      if (String(args.ctx?.sessionId ?? '').startsWith('plan:')) throw new Error('planner provider down');
      return { text: 'Done' };
    });
    const task = await seedCloudTask(t);
    const { executeTask } = await import('../modules/execution/orchestrator.js');
    t.tasks[0]!.status = 'RUNNING'; // worker claim (queue.ts) precedes executeTask
    await executeTask(task);

    expect(t.plans.length).toBe(1);
    const entries = t.planEntries.filter((e) => e.plan_id === t.plans[0]!.id);
    expect(entries.length).toBe(6);
    expect(entries.map((e) => e.coworker_type)).toEqual(['ARCHITECT', 'CODER', 'SECURITY', 'TESTER', 'REVIEWER', 'DOCS']);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.plan_created', detail: expect.objectContaining({ source: 'default_fallback' }) }),
    );
    expect(t.tasks[0]!.status).toBe('COMPLETED');
  });
});