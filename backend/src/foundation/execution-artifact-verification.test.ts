/**
 * Regression suite for two production defects in the execution path.
 *
 * 1. ARTIFACT CONTENT WAS "null"
 *    executeTask() built the artifact from the in-memory run object returned by
 *    createCoworkerRun(), whose `output` is never mutated by runCoworker() — the
 *    real output is written to coworker_runs.output. Serializing that stale
 *    field persisted the literal string "null" for every artifact ever produced.
 *
 * 2. PLANNER ACCEPTANCE CRITERIA
 *    Proves a planner-supplied pipeline keeps non-null acceptance_criteria all
 *    the way into plan_entries, so the verifier has criteria to judge against.
 *
 * The REAL orchestrator and the REAL planner run here; only the gateway, the
 * database and the coworker runtime are mocked, with the database mock
 * faithfully modelling that persisted run rows carry the run output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  let resolve: ((text: string, params: unknown[]) => unknown[] | null) | null = null;
  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
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

const completeWithFallback = vi.hoisted(() => vi.fn(async () => ({ text: '{}', model: 'mock' })));
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'ctx') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));
vi.mock('../modules/workspace/service.js', () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock('../modules/dna/service.js', () => ({ autoSaveTaskDna: vi.fn(async () => {}) }));
vi.mock('../shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

// Coworker runtime. createCoworkerRun returns output:null exactly like the real
// one; runCoworker "persists" output into a store; listCoworkerRuns (SELECT *)
// returns the persisted rows — so a stale in-memory read is detectable.
const store = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  const persisted = new Map<string, Record<string, unknown>>();
  const artifacts = new Map<string, Record<string, unknown>>();
  return { created, persisted, artifacts };
});

const coworkers = vi.hoisted(() => ({
  createCoworkerRun: vi.fn(async (input: Record<string, unknown>) => {
    const run = {
      id: `crw_${store.created.length + 1}`,
      task_id: input.taskId,
      coworker_type: input.coworkerType,
      order_index: input.orderIndex,
      state: 'QUEUED',
      input: input.runInput ?? {},
      output: null, // <- the real run object never receives the output
      verification_result: null,
      error_code: null,
      timeout_ms: input.timeoutMs ?? 1800000,
      started_at: null,
      completed_at: null,
      parallel_group: input.parallelGroup ?? null,
    };
    store.created.push(run);
    return run;
  }),
  runCoworker: vi.fn(async () => {}),
  recordHandoff: vi.fn(async () => {}),
  saveCoworkerArtifact: vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: `art_${store.artifacts.size + 1}`, ...input };
    store.artifacts.set(row.id as string, row);
    return row;
  }),
  listCoworkerRuns: vi.fn(async () =>
    store.created.map((r) => ({
      ...r,
      output: store.persisted.get(r.id as string)?.output ?? null,
      verification_result: store.persisted.get(r.id as string)?.verification_result ?? 'SKIPPED',
    })),
  ),
}));
vi.mock('../modules/execution/coworkers.js', () => coworkers);

import { executeTask } from '../modules/execution/orchestrator.js';
import { TASK_TIMEOUT_MS } from '../modules/execution/tasks.js';

const REAL_OUTPUT = '# Onboarding Guide\n\nStep 1: clone the repo.\nStep 2: run the tests.\n';
const CRITERIA = 'The output must provide concrete, actionable onboarding steps.';

/** A planner response whose entries declare acceptance criteria. */
const PLAN_WITH_CRITERIA = {
  pipeline: [
    { coworker: 'ARCHITECT', acceptanceCriteria: CRITERIA, expectedArtifacts: ['plan.md'] },
    { coworker: 'CODER', acceptanceCriteria: CRITERIA, expectedArtifacts: ['code.md'] },
  ],
};

function taskRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, project_id: 'p1', conversation_id: null, owner_id: 'u1',
    title: 'Onboarding guide', description: 'Write onboarding docs',
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

function resolver(task: Record<string, unknown>) {
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
      if (plansReads === 1) return null; // no plan yet -> PLANNER runs
      return [{ id: 'pln_1', task_id: task.id, goal: 'Onboarding guide', status: 'ACTIVE', risk_level: 'LOW', estimated_work: null }];
    }
    if (text.includes('FROM plan_entries')) {
      return [
        { id: 'pne_1', plan_id: 'pln_1', order_index: 0, coworker_type: 'ARCHITECT', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: CRITERIA, expected_artifacts: ['plan.md'] },
        { id: 'pne_2', plan_id: 'pln_1', order_index: 1, coworker_type: 'CODER', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: CRITERIA, expected_artifacts: ['code.md'] },
      ];
    }
    if (text.includes('FROM tasks')) return [task];
    return null;
  };
}

/** Persist each run's output like the real runCoworker does. */
function persistOutputs(text = REAL_OUTPUT, verification: 'PASS' | 'FAIL' | 'SKIPPED' = 'PASS') {
  coworkers.runCoworker.mockImplementation(async (run: Record<string, unknown>) => {
    store.persisted.set(run.id as string, { output: { text }, verification_result: verification });
  });
}

beforeEach(() => {
  db.reset();
  store.created.length = 0;
  store.persisted.clear();
  store.artifacts.clear();
  for (const m of Object.values(coworkers)) if (typeof m === 'function' && 'mockClear' in m) (m as { mockClear: () => void }).mockClear();
  completeWithFallback.mockReset();
  completeWithFallback.mockResolvedValue({ text: JSON.stringify(PLAN_WITH_CRITERIA), model: 'mock' });
});

describe('A. planner acceptance criteria reach plan_entries (non-null)', () => {
  it('persists non-null acceptance_criteria for every planner entry', async () => {
    const task = taskRow('tsk_crit');
    db.setResolver(resolver(task));
    persistOutputs();

    await executeTask(task as never);

    const inserts = db.calls.filter((c) => c.text.includes('INSERT INTO plan_entries'));
    expect(inserts.length).toBeGreaterThan(0);
    // parameter 9 is acceptance_criteria in the INSERT column order
    for (const ins of inserts) {
      expect(ins.params[9], `criteria for ${JSON.stringify(ins.params[3])}`).toBe(CRITERIA);
      expect(ins.params[9]).not.toBeNull();
    }
  });
});

describe('D/E. artifact content is the real output, never the string "null"', () => {
  it('persists the real run output as artifact content', async () => {
    const task = taskRow('tsk_art');
    db.setResolver(resolver(task));
    persistOutputs(REAL_OUTPUT);

    await executeTask(task as never);

    expect(coworkers.saveCoworkerArtifact).toHaveBeenCalledTimes(1);
    const call = coworkers.saveCoworkerArtifact.mock.calls[0]![0] as Record<string, unknown>;
    const content = String(call.content);

    expect(content, 'artifact content must not be the string "null"').not.toBe('null');
    expect(content).not.toBe('undefined');
    expect(content).toBe(JSON.stringify({ text: REAL_OUTPUT }, null, 2));
    expect(content).toContain('Step 1: clone the repo.');
  });

  it('returns the identical meaningful content when the artifact is read back', async () => {
    const task = taskRow('tsk_read');
    db.setResolver(resolver(task));
    persistOutputs(REAL_OUTPUT);

    await executeTask(task as never);

    const stored = [...store.artifacts.values()];
    expect(stored.length).toBe(1);
    const artifact = stored[0]!;
    // retrieval returns exactly what was persisted
    const readBack = store.artifacts.get(artifact.id as string)!;
    expect(readBack.content).toBe(artifact.content);
    expect(String(readBack.content)).toContain('Onboarding Guide');
    expect(String(readBack.content)).not.toBe('null');
  });

  it('still records the verification verdict on the artifact', async () => {
    const task = taskRow('tsk_ver');
    db.setResolver(resolver(task));
    persistOutputs(REAL_OUTPUT, 'PASS');

    await executeTask(task as never);

    const call = coworkers.saveCoworkerArtifact.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.verification).toBe('PASS');
  });
});

describe('G. task lifecycle is preserved', () => {
  it('keeps RUNNING -> VERIFIED -> COMPLETED with a SUCCESS attempt', async () => {
    const task = taskRow('tsk_life');
    expect(task.status).toBe('RUNNING'); // claimed task, enqueued by the worker
    db.setResolver(resolver(task));
    persistOutputs();

    await executeTask(task as never);

    const statuses = db.calls
      .filter((c) => c.text.includes('UPDATE tasks SET status = $2'))
      .map((c) => c.params[1]);
    expect(statuses).toEqual(['VERIFIED', 'COMPLETED']);
    expect(statuses).not.toContain('FAILED');
    expect(db.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'SUCCESS')).toBe(true);
  });

  it('marks the task FAILED (not COMPLETED) once the retry budget is spent', async () => {
    const task = taskRow('tsk_fail', { attempt_count: 3, retry_count: 2 });
    db.setResolver(resolver(task));
    coworkers.runCoworker.mockImplementation(async () => { throw new Error('gateway exploded'); });

    await executeTask(task as never);

    const statuses = db.calls
      .filter((c) => c.text.includes('UPDATE tasks SET status = $2'))
      .map((c) => c.params[1]);
    expect(statuses).not.toContain('COMPLETED');
    expect(statuses).toContain('FAILED');
    // the failed attempt is recorded as a failure, never a success
    expect(db.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'SUCCESS')).toBe(false);
    expect(db.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'FAILURE')).toBe(true);
  });
});
