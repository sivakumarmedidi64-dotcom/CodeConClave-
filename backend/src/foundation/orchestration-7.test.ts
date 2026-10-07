/**
 * CodeConClave — orchestration Phase 7 foundation tests.
 * Covers: persisted-plan execution, dependency-safe parallel groups,
 * LOCAL tasks never faked, retry policy on failure, dead-letter queue.
 * DB + AI gateway + coworker runtime are mocked.
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

const coworkers = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  const createCoworkerRun = vi.fn(async (input: Record<string, unknown>) => {
    const run = {
      id: `crw_${created.length + 1}`,
      task_id: input.taskId,
      coworker_type: input.coworkerType,
      order_index: input.orderIndex,
      state: 'QUEUED',
      input: input.runInput ?? {},
      output: null,
      verification_result: null,
      error_code: null,
      timeout_ms: input.timeoutMs ?? 1800000,
      started_at: null,
      completed_at: null,
      parallel_group: input.parallelGroup ?? null,
    };
    created.push(run);
    return run;
  });
  const runCoworker = vi.fn(async () => {});
  const recordHandoff = vi.fn(async () => {});
  const saveCoworkerArtifact = vi.fn(async (input: Record<string, unknown>) => ({
    id: 'art_1',
    run_id: input.runId,
    name: input.name,
    kind: input.kind,
    content: input.content ?? null,
    storage_key: null,
    sha256: 'abc',
    attempt_id: input.attemptId ?? null,
    verification: input.verification ?? null,
  }));
  const listCoworkerRuns = vi.fn(async () => created.map((r) => ({ ...r, verification_result: 'SKIPPED' })));
  return { created, createCoworkerRun, runCoworker, recordHandoff, saveCoworkerArtifact, listCoworkerRuns };
});
vi.mock('../modules/execution/coworkers.js', () => coworkers);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));
const recordUsage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/workspace/service.js', () => ({ recordUsage }));
const autoSaveTaskDna = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/dna/service.js', () => ({ autoSaveTaskDna }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../shared/logger.js', () => ({ logger }));

import { executeTask } from '../modules/execution/orchestrator.js';
import { TASK_TIMEOUT_MS } from '../modules/execution/tasks.js';

const PLANNER_PARALLEL_PLAN = {
  pipeline: [
    { coworker: 'ARCHITECT' },
    { coworker: 'RESEARCH', parallelGroup: 0 },
    { coworker: 'CODER', parallelGroup: 0 },
    { coworker: 'DOCS' },
  ],
};

function taskRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    conversation_id: null,
    owner_id: 'u1',
    title: 'Build auth',
    description: 'Auth module',
    plan: null,
    status: 'RUNNING',
    risk_level: 'MEDIUM',
    required_approval: false,
    approval_id: null,
    coworker_pipeline: null,
    execution_mode: 'CLOUD',
    timeout_ms: TASK_TIMEOUT_MS,
    started_at: new Date(),
    completed_at: null,
    failed_at: null,
    error_code: null,
    error_detail: null,
    attempt_count: 0,
    max_attempts: 3,
    last_heartbeat_at: new Date(),
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

function standardResolver(task: Record<string, unknown>): (text: string, params: unknown[]) => unknown[] | null {
  let plansReads = 0;
  return (text, params) => {
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
      // first read (loadOrGeneratePlan) finds no plan → PLANNER runs and persists
      if (plansReads === 1) return null;
      return [{ id: 'pln_1', task_id: task.id, goal: 'Build auth', status: 'ACTIVE', risk_level: 'MEDIUM', estimated_work: null }];
    }
    if (text.includes('FROM plan_entries')) {
      return [
        { id: 'pne_1', plan_id: 'pln_1', order_index: 0, coworker_type: 'ARCHITECT', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: null, expected_artifacts: [] },
        { id: 'pne_2', plan_id: 'pln_1', order_index: 1, coworker_type: 'RESEARCH', input: {}, parallel_group: 0, required_tools: [], risk: null, acceptance_criteria: null, expected_artifacts: [] },
        { id: 'pne_3', plan_id: 'pln_1', order_index: 2, coworker_type: 'CODER', input: {}, parallel_group: 0, required_tools: [], risk: null, acceptance_criteria: null, expected_artifacts: [] },
        { id: 'pne_4', plan_id: 'pln_1', order_index: 3, coworker_type: 'DOCS', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: null, expected_artifacts: [] },
      ];
    }
    if (text.includes('FROM tasks')) return [task];
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  coworkers.created.length = 0;
  coworkers.createCoworkerRun.mockClear();
  coworkers.runCoworker.mockClear();
  coworkers.recordHandoff.mockClear();
  coworkers.saveCoworkerArtifact.mockClear();
  coworkers.listCoworkerRuns.mockClear();
  recordAudit.mockClear();
  notify.mockClear();
  recordUsage.mockClear();
  autoSaveTaskDna.mockClear();
  completeWithFallback.mockClear();
  completeWithFallback.mockResolvedValue({ text: JSON.stringify(PLANNER_PARALLEL_PLAN), model: 'mock' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('executeTask — LOCAL mode is never faked', () => {
  it('hands LOCAL tasks to WAITING_FOR_LOCAL_AGENT without running any coworker', async () => {
    const task = taskRow('tsk_local', { execution_mode: 'LOCAL' });
    db.state.resolve = (text) => (text.includes('FROM tasks') ? [task] : null);
    await executeTask(task as never);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'WAITING_FOR_LOCAL_AGENT')!;
    expect(update).toBeDefined();
    expect(coworkers.runCoworker).not.toHaveBeenCalled();
    expect(coworkers.createCoworkerRun).not.toHaveBeenCalled();
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_attempts'))).toBe(false);
  });
});

describe('executeTask — persisted plan + parallel groups', () => {
  it('executes the persisted planner pipeline with dependency-safe parallel groups', async () => {
    const task = taskRow('tsk_1');
    db.state.resolve = standardResolver(task);
    await executeTask(task as never);

    // plan persisted before any run
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO plans'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.plan_created', detail: expect.objectContaining({ source: 'planner' }) }),
    );

    // all four coworkers ran in order
    expect(coworkers.createCoworkerRun).toHaveBeenCalledTimes(4);
    const types = coworkers.createCoworkerRun.mock.calls.map((c) => c[0]!.coworkerType);
    expect(types).toEqual(['ARCHITECT', 'RESEARCH', 'CODER', 'DOCS']);
    expect(coworkers.createCoworkerRun.mock.calls[1]![0]!.parallelGroup).toBe(0);
    expect(coworkers.createCoworkerRun.mock.calls[2]![0]!.parallelGroup).toBe(0);
    expect(coworkers.runCoworker).toHaveBeenCalledTimes(4);

    // handoffs between groups, never within a parallel group
    expect(coworkers.recordHandoff).toHaveBeenCalledTimes(2);
    const handoffRuns = coworkers.recordHandoff.mock.calls.map((c) => [c[0], c[1]]);
    expect(handoffRuns).toEqual([
      ['crw_1', 'crw_2'],
      ['crw_3', 'crw_4'],
    ]);

    // task completed with verification + artifact refs
    expect(db.state.calls.some((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'VERIFIED')).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'COMPLETED')).toBe(true);
    const artifactCall = coworkers.saveCoworkerArtifact.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(artifactCall.attemptId)).toMatch(/^atp_/);
    expect(artifactCall.verification).toBe('SKIPPED');
    expect(notify).toHaveBeenCalledWith('u1', 'task.completed', expect.anything(), expect.anything());
    expect(db.state.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'SUCCESS')).toBe(true);
    expect(autoSaveTaskDna).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'tsk_1' }));
  });

  it('keeps the task heartbeat fresh DURING a long coworker stage so the recovery watchdog cannot reset a healthy RUNNING task', async () => {
    vi.useFakeTimers();
    try {
      const task = taskRow('tsk_hb');
      db.state.resolve = standardResolver(task);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      coworkers.runCoworker.mockImplementation(() => gate);

      const run = executeTask(task as never);
      // Let plan generation + first-stage wiring settle; the first coworker is
      // now parked on the gate (a stand-in for a slow LLM stage).
      await vi.advanceTimersByTimeAsync(0);

      // No heartbeat may have fired yet: the stage has only just begun.
      const before = db.state.calls.filter((c) => c.text.includes('SET last_heartbeat_at = now(), updated_at = now()')).length;

      // Advance well past HEARTBEAT_TTL_MS (30s) while the stage is still in
      // flight. The worker must keep proving liveness on its own.
      await vi.advanceTimersByTimeAsync(35_000);
      const after = db.state.calls.filter((c) => c.text.includes('SET last_heartbeat_at = now(), updated_at = now()')).length;
      expect(after - before).toBeGreaterThanOrEqual(3);

      release();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs same-group coworkers concurrently (never sequentially)', async () => {
    const task = taskRow('tsk_par');
    db.state.resolve = standardResolver(task);
    let active = 0;
    let maxActive = 0;
    coworkers.runCoworker.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    await executeTask(task as never);
    expect(maxActive).toBe(2); // RESEARCH + CODER overlapped
  });
});

describe('executeTask — failure goes through the retry policy', () => {
  it('reschedules with backoff while the retry budget remains', async () => {
    const task = taskRow('tsk_fail');
    db.state.resolve = standardResolver(task);
    coworkers.runCoworker.mockImplementationOnce(async () => {
      throw new Error('model exploded');
    });
    await executeTask(task as never);

    // attempt recorded as failure
    const finishUpdate = db.state.calls.find((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'FAILURE')!;
    expect(finishUpdate).toBeDefined();
    // task returned to CREATED with RETRYING recovery, never FAILED, never DLQ
    const retryUpdate = db.state.calls.find((c) => c.text.includes("SET status = 'CREATED'"))!;
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate.params[1]).toBe('RETRYING');
    expect(retryUpdate.params[2]).toBe(60_000); // first backoff
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_dlq'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.retried' }));
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.failed', detail: expect.objectContaining({ decision: 'RETRIED' }) }),
    );
  });

  it('stops before later stages when the task is cancelled mid-run (cooperative cancel)', async () => {
    const task = taskRow('tsk_cancel');
    db.state.resolve = standardResolver(task);
    coworkers.runCoworker.mockImplementationOnce(async () => {
      task.status = 'CANCELLED'; // user cancels while the first coworker runs
    });
    await executeTask(task as never);
    // Only the first group ran; later coworkers never executed.
    expect(coworkers.runCoworker).toHaveBeenCalledTimes(1);
    // The attempt is finished as CANCELLED — never FAILURE, never retried,
    // never dead-lettered, never completed.
    const finishCancel = db.state.calls.find((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'CANCELLED')!;
    expect(finishCancel).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'VERIFIED')).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'COMPLETED')).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes("SET status = 'CREATED'"))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_dlq'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.cancelled' }));
  });

  it('dead-letters when retries are exhausted', async () => {
    const task = taskRow('tsk_dlq', { max_attempts: 1, retry_count: 0 });
    db.state.resolve = standardResolver(task);
    coworkers.runCoworker.mockImplementationOnce(async () => {
      throw new Error('model exploded');
    });
    await executeTask(task as never);

    const dlqInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO task_dlq'))!;
    expect(dlqInsert).toBeDefined();
    const failedUpdate = db.state.calls.find((c) => c.text.includes('UPDATE tasks SET status = $2') && c.params[1] === 'FAILED')!;
    expect(failedUpdate).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes("recovery_status = 'DEAD_LETTERED'"))).toBe(true);
    expect(notify).toHaveBeenCalledWith('u1', 'task.failed', expect.anything(), expect.anything());
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.dead_lettered' }));
  });
});