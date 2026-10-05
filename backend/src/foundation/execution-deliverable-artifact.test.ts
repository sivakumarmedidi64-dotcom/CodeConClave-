/**
 * Regression: the artifact must be the PRODUCED DELIVERABLE, with the review
 * result recorded separately.
 *
 * Previously the artifact was always built from the LAST run. On a
 * RESEARCH -> CODER -> REVIEWER pipeline that stored the reviewer's commentary
 * as the deliverable, so the produced file was never surfaced.
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

const completeWithFallback = vi.hoisted(() => vi.fn(async () => ({ text: '{"pipeline":[]}', model: 'mock' })));
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'ctx') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));
vi.mock('../modules/workspace/service.js', () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock('../modules/dna/service.js', () => ({ autoSaveTaskDna: vi.fn(async () => {}) }));
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
  }))),
}));
vi.mock('../modules/execution/coworkers.js', () => coworkers);

import { executeTask } from '../modules/execution/orchestrator.js';
import { TASK_TIMEOUT_MS } from '../modules/execution/tasks.js';

const DELIVERABLE = '{"changes":[{"path":"DEPLOY_CHECKLIST.md","content":"1. Health 2. Migrations 3. Rollback"}]}';
const REVIEW = 'PASS — the checklist is complete, accurate and actionable.';

function taskRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, project_id: 'p1', conversation_id: null, owner_id: 'u1',
    title: 'Deploy checklist', description: 'Create the file',
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

/** RESEARCH + CODER pass; REVIEWER is last. */
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
      if (plansReads === 1) return null;
      return [{ id: 'pln_1', task_id: task.id, goal: 'Create the file', status: 'ACTIVE', risk_level: 'LOW', estimated_work: null }];
    }
    if (text.includes('FROM plan_entries')) {
      return [
        { id: 'pne_1', plan_id: 'pln_1', order_index: 0, coworker_type: 'RESEARCH', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: 'c', expected_artifacts: [] },
        { id: 'pne_2', plan_id: 'pln_1', order_index: 1, coworker_type: 'CODER', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: 'c', expected_artifacts: [] },
        { id: 'pne_3', plan_id: 'pln_1', order_index: 2, coworker_type: 'REVIEWER', input: {}, parallel_group: null, required_tools: [], risk: null, acceptance_criteria: 'c', expected_artifacts: [] },
      ];
    }
    if (text.includes('FROM tasks')) return [task];
    return null;
  };
}

/** Each run persists its own output and verdict, exactly like runCoworker. */
function persistPipeline() {
  const outputs: Record<string, { text: string; verification_result: string }> = {
    RESEARCH: { text: 'research notes', verification_result: 'PASS' },
    CODER: { text: DELIVERABLE, verification_result: 'PASS' },
    REVIEWER: { text: REVIEW, verification_result: 'PASS' },
  };
  coworkers.runCoworker.mockImplementation(async (r: Record<string, unknown>) => {
    const o = outputs[String(r.coworker_type)]!;
    store.persisted.set(r.id as string, { output: { text: o.text }, verification_result: o.verification_result });
  });
}

beforeEach(() => {
  db.reset();
  store.created.length = 0;
  store.persisted.clear();
  store.artifacts.length = 0;
  for (const m of Object.values(coworkers)) (m as { mockClear: () => void }).mockClear();
  completeWithFallback.mockClear();
  completeWithFallback.mockResolvedValue({ text: JSON.stringify({ pipeline: [{ coworker: 'CODER' }] }), model: 'mock' });
  persistPipeline();
});

const artifact = (kind: string) => store.artifacts.find((a) => a.kind === kind)!;

describe('PROBLEM 2 — the artifact is the produced deliverable', () => {
  it('stores the verified deliverable, not the reviewer commentary', async () => {
    const task = taskRow('tsk_deliv');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    expect(store.artifacts.length, 'deliverable + review artifacts').toBe(2);
    const out = artifact('output');
    expect(String(out.content)).toContain('DEPLOY_CHECKLIST.md');
    expect(String(out.content)).toBe(JSON.stringify({ text: DELIVERABLE }, null, 2));
    expect(String(out.content)).not.toContain('the checklist is complete');
    expect(out.runId, 'artifact is bound to the CODER run').toBe('crw_2');
    expect(out.verification).toBe('PASS');
    expect(String(out.name)).toMatch(/-output\.md$/);
  });

  it('keeps the review result as its own separately recorded artifact', async () => {
    const task = taskRow('tsk_review');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const rev = artifact('review');
    expect(rev).toBeDefined();
    expect(String(rev.content)).toBe(JSON.stringify({ text: REVIEW }, null, 2));
    expect(rev.runId).toBe('crw_3');
    expect(String(rev.name)).toMatch(/-review\.md$/);
  });

  it('reviewer output is never removed from the run history', async () => {
    const task = taskRow('tsk_hist');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const reviewer = store.created.find((r) => r.coworker_type === 'REVIEWER')!;
    expect(store.persisted.get(reviewer.id as string)!.output).toEqual({ text: REVIEW });
  });

  it('artifact content is never the string "null" and keeps real bytes', async () => {
    const task = taskRow('tsk_null');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    for (const a of store.artifacts) {
      expect(String(a.content)).not.toBe('null');
      expect(String(a.content).length).toBeGreaterThan(10);
    }
  });

  it('never promotes the reviewer to the deliverable when nothing passed verification', async () => {
    coworkers.runCoworker.mockImplementation(async (r: Record<string, unknown>) => {
      store.persisted.set(r.id as string, { output: { text: `output of ${String(r.coworker_type)}` }, verification_result: 'FAIL' });
    });
    const task = taskRow('tsk_nopass');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    // The producing stage stays the deliverable and keeps the FAIL verdict; the
    // reviewer's commentary is recorded separately as the review artifact. The
    // previous `?? lastPersisted` fallback promoted REVIEWER to the deliverable
    // here, which is what stored a 20-byte {"text":"PASS"} as the artifact in
    // production and discarded the real produced document.
    expect(store.artifacts.length).toBe(2);
    expect(String(artifact('output').content)).toContain('output of CODER');
    expect(String(artifact('output').content)).not.toContain('output of REVIEWER');
    expect(artifact('output').verification).toBe('FAIL');
    expect(String(artifact('review').content)).toContain('output of REVIEWER');
  });

  it('task lifecycle is unchanged', async () => {
    const task = taskRow('tsk_life');
    db.setResolver(resolver(task));

    await executeTask(task as never);

    const statuses = db.calls.filter((c) => c.text.includes('UPDATE tasks SET status = $2')).map((c) => c.params[1]);
    expect(statuses.at(-1)).toBe('COMPLETED');
    expect(db.calls.some((c) => c.text.includes('UPDATE task_attempts') && c.params[1] === 'SUCCESS')).toBe(true);
    const steps = db.calls.filter((c) => c.text.includes('INSERT INTO task_steps')).length;
    expect(steps).toBeGreaterThan(0);
  });
});
