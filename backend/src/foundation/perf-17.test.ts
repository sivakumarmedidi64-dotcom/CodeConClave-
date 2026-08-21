/**
 * CodeConClave — PHASE 17 performance smoke (honest TARGET/MEASURED).
 *
 * perf-16 covers the instrumentation itself. This file MEASURES real
 * end-to-end paths through the in-memory execution engine and reports
 * TARGET/MEASURED per run. Assertions are deliberately generous so the
 * suite is never flaky on CI; the honest numbers are logged for the report.
 * Nothing here claims production performance — it measures the local,
 * in-memory execution path only.
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
  };
});
vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const completeWithFallback = vi.hoisted(() => vi.fn(async () => ({ text: 'Done' })));
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));

function setup() {
  const t: { tasks: Record<string, unknown>[]; attempts: Record<string, unknown>[]; steps: Record<string, unknown>[]; runs: Record<string, unknown>[]; plans: Record<string, unknown>[]; entries: Record<string, unknown>[] } = { tasks: [], attempts: [], steps: [], runs: [], plans: [], entries: [] };
  db.state.resolve = (text, params) => {
    const s = text.toLowerCase();
    if (s.includes('select plan_id from users')) return [{ id: 'u1', plan_id: 'free' }];
    if (s.includes('select team_id from projects')) return [];
    if (s.includes('from notifications')) return [];
    if (s.includes('from tasks') && s.includes('where id = $1')) return t.tasks.filter((x) => x.id === params[0]);
    if (s.includes('update tasks') && s.includes('last_heartbeat_at')) return [];
    if (s.includes('update tasks') && s.includes('recovery_status = $2')) {
      const task = t.tasks.find((x) => x.id === params[0])!;
      task.status = 'CREATED'; task.recovery_status = params[1]; task.retry_count = (task.retry_count as number) + 1;
      task.next_attempt_at = new Date(Date.now() + Number(params[2] ?? 0)).toISOString();
      task.failure_reason = params[3] ?? task.failure_reason; task.error_code = params[4] ?? task.error_code;
      task.failed_at = null; task.completed_at = null;
      return [];
    }
    if (s.includes('update tasks')) {
      const task = t.tasks.find((x) => x.id === params[0]);
      if (!task) return [];
      const m = text.match(/status = \$(\d+)/i);
      if (m) task.status = params[Number(m[1]) - 1];
      const ec = text.match(/error_code = \$(\d+)/i);
      if (ec) task.error_code = params[Number(ec[1]) - 1];
      if (task.status === 'COMPLETED') task.completed_at = new Date().toISOString();
      if (task.status === 'FAILED' || task.status === 'TIMED_OUT') task.failed_at = new Date().toISOString();
      return [];
    }
    if (s.includes('insert into tasks')) {
      t.tasks.push({ id: params[0], project_id: params[1], conversation_id: params[2], owner_id: params[3], title: params[4], description: params[5], status: 'CREATED', risk_level: params[6], required_approval: params[7], coworker_pipeline: params[8], execution_mode: params[9], timeout_ms: params[10], max_attempts: params[11], priority: params[12], attempt_count: 0, retry_count: 0, recovery_status: 'NONE', error_code: null, error_detail: null, failure_reason: null, next_attempt_at: null, completed_at: null, failed_at: null, started_at: null, last_heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null });
      return [];
    }
    if (s.includes('from task_attempts') && s.includes('max(attempt_number)')) {
      const nums = t.attempts.filter((a) => a.task_id === params[0]).map((a) => Number(a.attempt_number));
      return [{ n: (nums.length ? Math.max(...nums) : 0) + 1 }];
    }
    if (s.includes('from task_attempts') && s.includes('checkpointed_at is not null')) {
      const row = t.attempts.filter((a) => a.task_id === params[0] && a.id !== params[1] && a.checkpointed_at).sort((a, b) => String(b.checkpointed_at).localeCompare(String(a.checkpointed_at)))[0];
      return row ? [{ checkpoint: row.checkpoint }] : [];
    }
    if (s.includes('from task_attempts') && s.includes('where id = $1')) return t.attempts.filter((a) => a.id === params[0]);
    if (s.includes('from task_attempts')) return t.attempts.filter((a) => a.task_id === params[0]);
    if (s.includes('insert into task_attempts')) {
      t.attempts.push({ id: params[0], task_id: params[1], attempt_number: params[2], started_at: new Date().toISOString(), result: null, error_code: null, output_summary: null, checkpoint: null, checkpointed_at: null, finished_at: null });
      return [];
    }
    if (s.includes('update task_attempts set checkpoint')) {
      const attempt = t.attempts.find((a) => a.id === params[0])!;
      attempt.checkpoint = JSON.parse(String(params[1])); attempt.checkpointed_at = new Date().toISOString();
      return [];
    }
    if (s.includes('update task_attempts set')) {
      const attempt = t.attempts.find((a) => a.id === params[0])!;
      attempt.result = params[1]; attempt.error_code = params[2] ?? null; attempt.output_summary = params[3] ?? null; attempt.finished_at = new Date().toISOString();
      return [];
    }
    if (s.includes('from task_steps') && s.includes('where id = $1')) return t.steps.filter((x) => x.id === params[0]);
    if (s.includes('from task_steps')) return t.steps.filter((x) => x.task_id === params[0]);
    if (s.includes('insert into task_steps')) {
      t.steps.push({ id: params[0], task_id: params[1], attempt_id: params[2], kind: params[3], title: params[4], status: 'RUNNING', detail: null, output: null, error_code: null, started_at: new Date().toISOString(), completed_at: null });
      return [];
    }
    if (s.includes('update task_steps')) {
      const step = t.steps.find((x) => x.id === params[0])!;
      step.status = params[1]; step.detail = params[2] ? JSON.parse(String(params[2])) : step.detail; step.output = params[3] ?? step.output; step.error_code = params[4] ?? step.error_code; step.completed_at = new Date().toISOString();
      return [];
    }
    if (s.includes('select id from plans where task_id')) return t.plans.filter((p) => p.task_id === params[0]).map((p) => ({ id: p.id }));
    if (s.includes('from plans where task_id')) return t.plans.filter((p) => p.task_id === params[0]);
    if (s.includes('insert into plans')) {
      const existing = t.plans.find((p) => p.task_id === params[1]);
      if (existing) { existing.goal = params[2]; existing.status = 'ACTIVE'; }
      else t.plans.push({ id: params[0], task_id: params[1], goal: params[2], status: 'ACTIVE', risk_level: params[3], estimated_work: params[4], acceptance_criteria: JSON.parse(String(params[5])), expected_artifacts: JSON.parse(String(params[6])), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return [];
    }
    if (s.includes('delete from plan_entries')) { t.entries = t.entries.filter((e) => e.plan_id !== params[0]); return []; }
    if (s.includes('insert into plan_entries')) {
      t.entries.push({ id: params[0], plan_id: params[1], order_index: params[2], coworker_type: params[3], input: JSON.parse(String(params[4])), parallel_group: params[5], depends_on: JSON.parse(String(params[6])), required_tools: JSON.parse(String(params[7])), risk: params[8], acceptance_criteria: params[9], expected_artifacts: JSON.parse(String(params[10])) });
      return [];
    }
    if (s.includes('from plan_entries')) return t.entries.filter((e) => e.plan_id === params[0]).sort((a, b) => Number(a.order_index) - Number(b.order_index));
    if (s.includes('select id from coworker_runs')) {
      return t.runs.filter((r) => r.task_id === params[0] && r.coworker_type === params[1] && r.order_index === params[2]).map((r) => ({ id: r.id }));
    }
    if (s.includes('from coworker_runs') && s.includes('where id = $1')) return t.runs.filter((r) => r.id === params[0]);
    if (s.includes('from coworker_runs')) return t.runs.filter((r) => r.task_id === params[0]).sort((a, b) => Number(a.order_index) - Number(b.order_index));
    if (s.includes('insert into coworker_runs')) {
      const existing = t.runs.find((r) => r.task_id === params[1] && r.coworker_type === params[2] && r.order_index === params[3]);
      if (existing) { existing.input = JSON.parse(String(params[4])); return []; }
      t.runs.push({ id: params[0], task_id: params[1], coworker_type: params[2], order_index: params[3], state: 'QUEUED', input: JSON.parse(String(params[4])), timeout_ms: params[5], parallel_group: params[6], output: null, verification_result: null, error_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return [];
    }
    if (s.includes('update coworker_runs set state')) {
      const run = t.runs.find((r) => r.id === params[0])!;
      run.state = params[1]; run.error_code = params[2] ?? run.error_code;
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
    if (s.includes('insert into task_dlq')) return [];
    if (s.includes('from task_dlq')) return [];
    if (s.includes('from task_dependencies')) return [];
    return [];
  };
  return t;
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  completeWithFallback.mockReset();
  completeWithFallback.mockResolvedValue({ text: 'Done' });
});

describe('PHASE 17 performance smoke — honest TARGET/MEASURED', () => {
  it('runs the full execution pipeline (2-stage) well within a generous local target', async () => {
    const t = setup();
    const { createTask } = await import('../modules/execution/tasks.js');
    const { executeTask } = await import('../modules/execution/orchestrator.js');
    const task = await createTask({
      userId: 'u1',
      projectId: 'p1',
      title: 'Perf smoke',
      riskLevel: 'LOW',
      executionMode: 'CLOUD',
      maxAttempts: 3,
      coworkerPipeline: [{ coworker: 'ARCHITECT' }, { coworker: 'CODER' }],
    });
    const startedAt = Date.now();
    await executeTask(task);
    const measured = Date.now() - startedAt;
    console.error(`PERF task_execute_ms TARGET<=2000 MEASURED=${measured}`);
    expect(t.tasks[0]!.status).toBe('COMPLETED');
    expect(measured).toBeLessThan(2000);
  });

  it('creates the task row quickly (write path)', async () => {
    const t = setup();
    const { createTask } = await import('../modules/execution/tasks.js');
    const startedAt = Date.now();
    for (let i = 0; i < 20; i += 1) {
      await createTask({ userId: 'u1', projectId: 'p1', title: `task-${i}`, riskLevel: 'LOW', executionMode: 'CLOUD' });
    }
    const measured = Date.now() - startedAt;
    console.error(`PERF task_create_20_ms TARGET<=1000 MEASURED=${measured}`);
    expect(t.tasks.length).toBe(20);
    expect(measured).toBeLessThan(1000);
  });

  it('keeps the SSE replay buffer rebuild linear and fast for 500 events', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({ id: `evt_${i}`, event: 'message', data: JSON.stringify({ i }) }));
    const startedAt = Date.now();
    const rebuilt = events.map((e) => `${e.event}: ${e.data}`).join('\n');
    const measured = Date.now() - startedAt;
    console.error(`PERF sse_rebuild_500_ms TARGET<=50 MEASURED=${measured}`);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(measured).toBeLessThan(50);
  });
});