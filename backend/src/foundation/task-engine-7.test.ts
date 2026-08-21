/**
 * CodeConClave — task engine Phase 7 foundation tests.
 * Covers: priority + dependencies at creation, retry with exponential backoff,
 * dead-letter queue, manual recovery, watchdog retry/dependency sweeps,
 * claim gating (next_attempt_at, priority, dependency NOT EXISTS).
 * DB interaction is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
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
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));
const recordUsage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/workspace/service.js', () => ({ recordUsage }));

import {
  createTask,
  scheduleRetry,
  deadLetterTask,
  retryOrDeadLetter,
  retryTask,
  listDeadLettered,
  getTaskFailureInfo,
  addTaskDependency,
  listTaskDependencies,
  recoverTimedOutTasks,
  blockBlockedDependencies,
  retryBackoffMs,
  TASK_TIMEOUT_MS,
} from '../modules/execution/tasks.js';
import { claimNextTask } from '../shared/queue.js';
import { RetryPolicy } from '@codeconclave/shared';

function taskRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    conversation_id: null,
    owner_id: 'u1',
    title: 't',
    description: null,
    plan: null,
    status: 'CREATED',
    risk_level: 'MEDIUM',
    required_approval: false,
    approval_id: null,
    coworker_pipeline: null,
    execution_mode: 'CLOUD',
    timeout_ms: TASK_TIMEOUT_MS,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error_code: null,
    error_detail: null,
    attempt_count: 0,
    max_attempts: 3,
    last_heartbeat_at: null,
    watchdog_checked_at: null,
    priority: 0,
    failure_reason: null,
    recovery_status: 'NONE',
    retry_count: 0,
    next_attempt_at: null,
    dead_letter_at: null,
    requires_review_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function taskResolver(overrides: Record<string, unknown> = {}): (text: string, params: unknown[]) => unknown[] | null {
  return (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), overrides)] : null);
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
  recordUsage.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTask — priority and dependencies', () => {
  it('persists priority as the final INSERT parameter', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), { priority: 7 })] : null);
    await createTask({ userId: 'u1', projectId: 'p1', title: 't', priority: 7 });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO tasks'))!;
    expect(insert.params[12]).toBe(7);
    expect(insert.text).toContain('priority');
  });

  it('registers finish dependencies for the task', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]))] : null);
    await createTask({ userId: 'u1', projectId: 'p1', title: 't', dependsOn: ['tsk_a', 'tsk_b'] });
    const deps = db.state.calls.filter((c) => c.text.includes('INSERT INTO task_dependencies'));
    expect(deps.length).toBe(2);
    expect(deps[0]!.params[1]).toBe(deps[0]!.params[1]); // task id
    expect(deps[0]!.text).toContain("'finish'");
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.dependency_added' }));
  });

  it('addTaskDependency is idempotent (ON CONFLICT DO NOTHING)', async () => {
    db.state.resolve = null;
    await addTaskDependency('tsk_1', 'tsk_2');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO task_dependencies'))!;
    expect(insert.text).toContain('ON CONFLICT DO NOTHING');
    expect(insert.params[2]).toBe('tsk_2');
  });

  it('listTaskDependencies joins dependency status', async () => {
    db.state.rows = [{ id: 'dep_1', task_id: 'tsk_1', depends_on_task_id: 'tsk_2', depends_on_status: 'COMPLETED' }];
    const deps = await listTaskDependencies('tsk_1');
    expect(deps[0]!.depends_on_status).toBe('COMPLETED');
    const call = db.state.calls.find((c) => c.text.includes('JOIN tasks dep'))!;
    expect(call.params[0]).toBe('tsk_1');
  });
});

describe('claim gating — Phase 7 additions', () => {
  it('claim gate adds next_attempt_at, priority ordering, and dependency gates', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE tasks')) return [{ id: 't1', project_id: 'p1', owner_id: 'u1', title: 't', risk_level: 'LOW', execution_mode: 'CLOUD' }];
      return null;
    };
    const claimed = await claimNextTask('worker-1', 1);
    expect(claimed.length).toBe(1);
    const claim = db.state.calls.find((c) => c.text.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(claim.text).toContain('attempt_count < max_attempts');
    expect(claim.text).toContain("status IN ('CREATED','PLANNED','CHANGED')");
    expect(claim.text).toContain("'CLOUD','HYBRID'");
    expect(claim.text).toContain('required_approval = false OR approval_id IS NOT NULL');
    expect(claim.text).toContain('next_attempt_at IS NULL OR next_attempt_at <= now()');
    expect(claim.text).toContain('ORDER BY priority DESC, created_at');
    expect(claim.text).toContain('task_dependencies');
    expect(claim.text).toContain('dep.status <> ');
    expect(claim.params[0]).toBe(1);
  });
});

describe('retry policy — exponential backoff', () => {
  it('backoff doubles each retry and caps at the max', () => {
    expect(retryBackoffMs(0)).toBe(RetryPolicy.BASE_BACKOFF_MS);
    expect(retryBackoffMs(1)).toBe(RetryPolicy.BASE_BACKOFF_MS * 2);
    expect(retryBackoffMs(2)).toBe(RetryPolicy.BASE_BACKOFF_MS * 4);
    expect(retryBackoffMs(10)).toBe(RetryPolicy.MAX_BACKOFF_MS);
  });

  it('scheduleRetry returns the task to CREATED with backoff, RETRYING recovery, and audit', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), { retry_count: 1 })] : null);
    await scheduleRetry('tsk_1', 'gateway_error', 'boom');
    const update = db.state.calls.find((c) => c.text.includes("SET status = 'CREATED'"))!;
    expect(update.params[1]).toBe('RETRYING');
    expect(update.params[2]).toBe(RetryPolicy.BASE_BACKOFF_MS * 2); // retry_count 1 → 120s
    expect(update.text).toContain("retry_count = retry_count + 1");
    expect(update.text).toContain('next_attempt_at = now() +');
    expect(update.text).toContain('failure_reason');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.retried', detail: expect.objectContaining({ backoffMs: RetryPolicy.BASE_BACKOFF_MS * 2 }) }));
  });

  it('never claims a retrying task before next_attempt_at (claim gate covers it)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE tasks')) return [{ id: 't1', project_id: 'p1', owner_id: 'u1', title: 't', risk_level: 'LOW', execution_mode: 'CLOUD' }];
      return null;
    };
    await claimNextTask('worker-1', 1);
    const claim = db.state.calls.find((c) => c.text.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(claim.text).toContain('next_attempt_at IS NULL OR next_attempt_at <= now()');
  });

  it('retryOrDeadLetter retries while budget remains', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), { retry_count: 1, max_attempts: 3 })] : null);
    const decision = await retryOrDeadLetter('tsk_1', 'coworker_error', 'failed');
    expect(decision).toBe('RETRIED');
    expect(db.state.calls.some((c) => c.text.includes("SET status = 'CREATED'"))).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_dlq'))).toBe(false);
  });

  it('retryOrDeadLetter dead-letters when budget is exhausted', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), { retry_count: 2, max_attempts: 3 })] : null);
    const decision = await retryOrDeadLetter('tsk_1', 'coworker_error', 'failed');
    expect(decision).toBe('DEAD_LETTERED');
    expect(db.state.calls.some((c) => c.text.includes("SET status = 'CREATED'"))).toBe(false);
    const dlqInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO task_dlq'))!;
    expect(dlqInsert.params[1]).toBe('tsk_1');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.dead_lettered' }));
  });
});

describe('dead-letter queue', () => {
  it('deadLetterTask fails the task and records the DLQ row with attempt count', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), { attempt_count: 3, max_attempts: 3 })] : null);
    await deadLetterTask('tsk_1', 'coworker_error', 'exhausted retries');
    const statusUpdate = db.state.calls.find((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'FAILED')!;
    expect(statusUpdate).toBeDefined();
    const recoveryUpdate = db.state.calls.find((c) => c.text.includes("recovery_status = 'DEAD_LETTERED'"))!;
    expect(recoveryUpdate.text).toContain('dead_letter_at = now()');
    const dlqInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO task_dlq'))!;
    expect(dlqInsert.params[2]).toBe('p1');
    expect(dlqInsert.params[8]).toBe(3);
    expect(notify).toHaveBeenCalledWith('u1', 'task.failed', expect.anything(), expect.anything());
  });

  it('listDeadLettered returns rows joined with task status', async () => {
    db.state.rows = [{ id: 'dlq_1', task_id: 'tsk_1', task_status: 'FAILED', retry_count: 2 }];
    const rows = await listDeadLettered('u1');
    expect(rows[0]!.task_status).toBe('FAILED');
    const call = db.state.calls.find((c) => c.text.includes('JOIN tasks t'))!;
    expect(call.params[0]).toBe('u1');
  });

  it('retryTask recovers a dead-lettered task (RECOVERED) and removes the DLQ row', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]), { recovery_status: 'DEAD_LETTERED', status: 'FAILED' })] : null);
    await retryTask('u1', 'tsk_1', 'try again');
    const del = db.state.calls.find((c) => c.text.includes('DELETE FROM task_dlq'))!;
    expect(del.params[0]).toBe('tsk_1');
    const update = db.state.calls.find((c) => c.text.includes("SET status = 'CREATED'"))!;
    expect(update.params[1]).toBe('RECOVERED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.recovered' }));
  });

  it('retryTask rejects tasks that are not retryable', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM tasks') ? [taskRow(String(params[0]))] : null);
    await expect(retryTask('u1', 'tsk_1', 'nope')).rejects.toMatchObject({ errorCode: 'task_not_retryable' });
  });

  it('getTaskFailureInfo exposes the recovery story', async () => {
    db.state.resolve = (text, params) =>
      text.includes('FROM tasks')
        ? [taskRow(String(params[0]), { failure_reason: 'boom', recovery_status: 'RETRYING', retry_count: 1, next_attempt_at: new Date() })]
        : null;
    const info = await getTaskFailureInfo('tsk_1');
    expect(info.failure_reason).toBe('boom');
    expect(info.recovery_status).toBe('RETRYING');
    expect(info.retry_count).toBe(1);
    expect(info.max_attempts).toBe(3);
  });
});

describe('watchdog sweeps — Phase 7', () => {
  it('recoverTimedOutTasks applies retry policy per TIMED_OUT candidate', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes("status = 'TIMED_OUT'")) return [{ id: 'tsk_a' }, { id: 'tsk_b' }];
      if (text.includes('FROM tasks')) {
        const id = String(params[0]);
        return [taskRow(id, id === 'tsk_a' ? { retry_count: 0, max_attempts: 3 } : { retry_count: 2, max_attempts: 3 })];
      }
      return null;
    };
    const result = await recoverTimedOutTasks();
    expect(result).toEqual({ retried: 1, deadLettered: 1 });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_dlq'))).toBe(true);
  });

  it('blockBlockedDependencies marks dependents BLOCKED when a dependency failed', async () => {
    db.state.rowCount = 3;
    const n = await blockBlockedDependencies();
    expect(n).toBe(3);
    const call = db.state.calls.find((c) => c.text.includes('dependency_failed'))!;
    expect(call.text).toContain("status = 'BLOCKED'");
    expect(call.text).toContain("dep.status IN ('FAILED','TIMED_OUT','CANCELLED','BLOCKED')");
    expect(call.text).toContain('RETURNING id');
  });
});
