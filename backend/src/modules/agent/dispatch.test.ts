/**
 * CodeConClave — P0 local execution fabric tests.
 *
 * Exercises the real dispatcher (dispatch.ts) against an in-memory SQL
 * emulation and mocked task/attempt primitives. Proves the P0 contract:
 *  - a parked LOCAL task is assigned to an eligible online device only;
 *  - offline / incapable devices never receive work (no fabricated claim);
 *  - claim opens a real attempt and moves the task to EXECUTING;
 *  - ownership is verified (device ⇄ assignment);
 *  - leases are fenced by attempt generation and recovered on expiry;
 *  - completion/failure route through the existing task lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { calls: { text: string; params: unknown[] }[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = {
    calls: [],
    resolve: null,
  };
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
vi.mock('../../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../audit/service.js', () => ({ recordAudit }));

const hub = vi.hoisted(() => ({ sendToDevice: vi.fn(() => true), isOnline: vi.fn(() => true) }));
vi.mock('./hub.js', () => ({ wsHub: () => hub }));

const tasks = vi.hoisted(() => ({
  getTaskInternal: vi.fn(),
  setTaskStatus: vi.fn(async () => {}),
  beginAttempt: vi.fn(async () => ({ id: 'atp_new', task_id: 'tsk_1', attempt_number: 1, started_at: new Date(), finished_at: null, result: null, error_code: null, output_summary: null })),
  finishAttempt: vi.fn(async () => {}),
  touchTask: vi.fn(async () => {}),
  clearTaskFailureState: vi.fn(async () => {}),
  deadLetterTask: vi.fn(async () => {}),
}));
vi.mock('../execution/tasks.js', () => tasks);

const USER_ID = 'u1';
const DEVICE_ID = 'dev_online';
const TASK_ID = 'tsk_1';

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    project_id: 'prj_1',
    conversation_id: null,
    owner_id: USER_ID,
    title: 'Run locally',
    description: 'do the thing',
    status: 'WAITING_FOR_LOCAL_AGENT',
    execution_mode: 'LOCAL',
    timeout_ms: 900_000,
    attempt_count: 0,
    max_attempts: 3,
    retry_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lta_1',
    task_id: TASK_ID,
    owner_id: USER_ID,
    project_id: 'prj_1',
    device_id: DEVICE_ID,
    attempt_id: null,
    attempt_number: null,
    status: 'ASSIGNED',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    claimed_at: null,
    last_heartbeat_at: null,
    completed_at: null,
    result: null,
    error_code: null,
    error_detail: null,
    progress: null,
    artifact_refs: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

interface Store {
  devices: Record<string, unknown>[];
  assignments: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
}

function setup(seed: Partial<Store> = {}, online = true): Store {
  const store: Store = { devices: [], assignments: [], tasks: [], ...seed };
  hub.isOnline.mockReturnValue(online);
  db.state.resolve = (rawText, params) => {
    const t = rawText.toLowerCase();
    if (t.includes('from devices')) {
      return store.devices.filter((d) => d.user_id === params[0] && d.state === 'PAIRED');
    }
    if (t.includes('insert into local_task_assignments')) {
      store.assignments.push({
        id: params[0],
        task_id: params[1],
        owner_id: params[2],
        project_id: params[3],
        device_id: params[4],
        status: 'ASSIGNED',
        lease_expires_at: params[5],
        attempt_id: null,
        attempt_number: null,
        claimed_at: null,
        last_heartbeat_at: null,
        completed_at: null,
        result: null,
        error_code: null,
        error_detail: null,
        progress: null,
        artifact_refs: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return [];
    }
    if (t.includes('update tasks set assigned_device_id')) {
      const target = store.tasks.find((x) => x.id === params[0]);
      if (target) target.assigned_device_id = params[1];
      return [];
    }
    if (t.includes('from local_task_assignments')) {
      if (t.includes('lease_expires_at <')) {
        const cutoff = new Date(params[0] as string).getTime();
        return store.assignments.filter(
          (a) => ['ASSIGNED', 'CLAIMED', 'RUNNING'].includes(String(a.status)) && new Date(String(a.lease_expires_at)).getTime() < cutoff,
        );
      }
      if (t.includes('where id = $1')) return store.assignments.filter((a) => a.id === params[0]);
      if (t.includes('where task_id = $1 and status in')) {
        return store.assignments.filter((a) => a.task_id === params[0] && ['ASSIGNED', 'CLAIMED', 'RUNNING', 'REPORTED'].includes(String(a.status)));
      }
      if (t.includes('where owner_id = $1 and device_id = $2')) {
        return store.assignments.filter(
          (a) => a.owner_id === params[0] && a.device_id === params[1] && ['ASSIGNED', 'CLAIMED', 'RUNNING', 'REPORTED'].includes(String(a.status)),
        );
      }
      return [];
    }
    if (t.includes('update local_task_assignments')) {
      const target = store.assignments.find((a) => a.id === params[0]);
      if (!target) return [];
      if (t.includes("set status = 'running', attempt_id")) {
        target.status = 'RUNNING';
        target.attempt_id = params[1];
        target.attempt_number = params[2];
        target.claimed_at = new Date().toISOString();
        target.last_heartbeat_at = new Date().toISOString();
      } else if (t.includes('set last_heartbeat_at = now()')) {
        target.last_heartbeat_at = new Date().toISOString();
        if (target.status === 'CLAIMED') target.status = 'RUNNING';
      } else if (t.includes('set progress = $2')) {
        target.progress = JSON.parse(String(params[1]));
      } else if (t.includes('artifact_refs = $2::jsonb')) {
        const arr = JSON.parse(String(params[1])) as unknown[];
        target.artifact_refs = arr;
        if (target.status === 'CLAIMED') target.status = 'RUNNING';
      } else if (t.includes("set status = 'completed'")) {
        target.status = 'COMPLETED';
        target.result = JSON.parse(String(params[1]));
        target.artifact_refs = JSON.parse(String(params[2]));
        target.completed_at = new Date().toISOString();
      } else if (t.includes("set status = 'failed'")) {
        target.status = 'FAILED';
        target.error_code = params[1];
        target.error_detail = params[2];
      } else if (t.includes("set status = 'cancelled'")) {
        target.status = 'CANCELLED';
      } else if (t.includes("set status = 'expired'")) {
        target.status = 'EXPIRED';
      }
      return [];
    }
    if (t.includes('from tasks')) {
      if (t.includes("execution_mode = 'local'") && t.includes("status = 'waiting_for_local_agent'")) {
        return store.tasks.filter((x) => x.owner_id === params[0] && x.execution_mode === 'LOCAL' && x.status === 'WAITING_FOR_LOCAL_AGENT');
      }
      return store.tasks;
    }
    return [];
  };
  return store;
}

import {
  localExecutionEnabled,
  resolveEligibleDevices,
  dispatchLocalTask,
  claimAssignment,
  heartbeatAssignment,
  completeAssignment,
  failAssignment,
  reportAssignmentArtifact,
  recoverExpiredAssignments,
  onAgentReady,
} from './dispatch.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  hub.sendToDevice.mockClear();
  hub.isOnline.mockReset();
  hub.isOnline.mockReturnValue(true);
  for (const fn of Object.values(tasks)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
  recordAudit.mockClear();
  tasks.beginAttempt.mockResolvedValue({ id: 'atp_new', task_id: TASK_ID, attempt_number: 1, started_at: new Date(), finished_at: null, result: null, error_code: null, output_summary: null });
});

describe('P0 local execution fabric', () => {
  it('is gated OFF by default (a disabled capability is never reported enabled)', () => {
    expect(localExecutionEnabled()).toBe(false);
  });

  it('resolves only online devices advertising every required capability', async () => {
    setup({
      devices: [
        { id: 'dev_online', name: 'Box', user_id: USER_ID, state: 'PAIRED', capabilities: ['terminal_exec'] },
        { id: 'dev_offline', name: 'Laptop', user_id: USER_ID, state: 'PAIRED', capabilities: ['terminal_exec'] },
        { id: 'dev_incapable', name: 'Phone', user_id: USER_ID, state: 'PAIRED', capabilities: ['file_read'] },
      ],
    });
    hub.isOnline.mockImplementation((_u: string, d: string) => d !== 'dev_offline');
    const eligible = await resolveEligibleDevices(USER_ID, (u, d) => hub.isOnline(u, d));
    expect(eligible.map((d) => d.id)).toEqual(['dev_online']);
  });

  it('does not assign when no eligible device is online', async () => {
    const store = setup({ tasks: [taskRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    hub.isOnline.mockReturnValue(false);
    const res = await dispatchLocalTask(TASK_ID, (u, d) => hub.isOnline(u, d));
    expect(res).toEqual({ dispatched: false, reason: 'no_eligible_device' });
    expect(store.assignments).toHaveLength(0);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO local_task_assignments'))).toBe(false);
  });

  it('assigns a parked LOCAL task to an online device and delivers the frame', async () => {
    const store = setup({
      tasks: [taskRow()],
      devices: [{ id: DEVICE_ID, name: 'Box', user_id: USER_ID, state: 'PAIRED', capabilities: ['terminal_exec'] }],
    });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    const res = await dispatchLocalTask(TASK_ID, (u, d) => hub.isOnline(u, d));
    expect(res.dispatched).toBe(true);
    if (!res.dispatched) return;
    expect(store.assignments).toHaveLength(1);
    expect(store.tasks[0]!.assigned_device_id).toBe(DEVICE_ID);
    expect(hub.sendToDevice).toHaveBeenCalledWith(USER_ID, DEVICE_ID, expect.objectContaining({ type: 'task_assign' }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'local.task_assigned' }));
  });

  it('does not dispatch a non-parked task', async () => {
    setup();
    tasks.getTaskInternal.mockResolvedValue(taskRow({ status: 'RUNNING' }));
    const res = await dispatchLocalTask(TASK_ID, () => true);
    expect(res).toEqual({ dispatched: false, reason: 'not_parked' });
  });

  it('claim opens an attempt and moves the task to EXECUTING', async () => {
    setup({ assignments: [assignmentRow()], tasks: [taskRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    const out = await claimAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID });
    expect(out.attemptNumber).toBe(1);
    expect(tasks.beginAttempt).toHaveBeenCalledWith(TASK_ID);
    expect(tasks.setTaskStatus).toHaveBeenCalledWith(TASK_ID, 'EXECUTING');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'local.task_claimed' }));
  });

  it('claim rejects a device that does not own the assignment (cross-device)', async () => {
    setup({ assignments: [assignmentRow()] });
    await expect(claimAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: 'dev_other' })).rejects.toMatchObject({
      errorCode: 'assignment_not_owned',
    });
    expect(tasks.beginAttempt).not.toHaveBeenCalled();
  });

  it('claim rejects and expires an already-lapsed lease', async () => {
    const store = setup({ assignments: [assignmentRow({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })] });
    await expect(claimAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID })).rejects.toMatchObject({
      errorCode: 'assignment_lease_expired',
    });
    expect(store.assignments[0]!.status).toBe('EXPIRED');
    expect(tasks.beginAttempt).not.toHaveBeenCalled();
  });

  it('claim refuses when the task is no longer awaiting a local agent', async () => {
    setup({ assignments: [assignmentRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow({ status: 'CANCELLED' }));
    await expect(claimAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID })).rejects.toMatchObject({
      errorCode: 'task_not_waiting_local',
    });
  });

  it('heartbeat is fenced: a superseded attempt generation is rejected', async () => {
    setup({ assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })] });
    await expect(
      heartbeatAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID, attemptNumber: 2 }),
    ).rejects.toMatchObject({ errorCode: 'attempt_superseded' });
  });

  it('completion finishes the attempt and COMPLETEs the task', async () => {
    setup({ assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })] });
    await completeAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID, attemptNumber: 1, result: { summary: 'done' } });
    expect(tasks.finishAttempt).toHaveBeenCalledWith('atp_1', 'SUCCESS', undefined, 'done');
    expect(tasks.clearTaskFailureState).toHaveBeenCalledWith(TASK_ID);
    expect(tasks.setTaskStatus).toHaveBeenCalledWith(TASK_ID, 'COMPLETED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'local.task_completed' }));
  });

  it('records a real artifact reference without fabricating content', async () => {
    const store = setup({ assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })] });
    await reportAssignmentArtifact({
      assignmentId: 'lta_1',
      userId: USER_ID,
      deviceId: DEVICE_ID,
      artifact: { path: 'out/result.md', sha256: 'abc' },
    });
    expect((store.assignments[0]!.artifact_refs as unknown[]).length).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'local.task_artifact' }));
  });

  it('re-parks a failed task while retry budget remains', async () => {
    setup({ assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })], tasks: [taskRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow({ max_attempts: 3, retry_count: 0 }));
    const out = await failAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID, attemptNumber: 1, error: 'boom' });
    expect(out.decision).toBe('REPARKED');
    expect(tasks.deadLetterTask).not.toHaveBeenCalled();
    const repark = db.state.calls.find((c) => c.text.includes("status = 'WAITING_FOR_LOCAL_AGENT'") && c.text.includes('retry_count = retry_count + 1'));
    expect(repark).toBeTruthy();
  });

  it('dead-letters a failed task when retry budget is exhausted', async () => {
    setup({ assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })], tasks: [taskRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow({ max_attempts: 1, retry_count: 0 }));
    const out = await failAssignment({ assignmentId: 'lta_1', userId: USER_ID, deviceId: DEVICE_ID, attemptNumber: 1, error: 'boom' });
    expect(out.decision).toBe('DEAD_LETTERED');
    expect(tasks.deadLetterTask).toHaveBeenCalled();
  });

  it('recovery sweep expires lapsed assignments', async () => {
    const store = setup({ assignments: [assignmentRow({ status: 'ASSIGNED', lease_expires_at: new Date(Date.now() - 5000).toISOString() })] });
    const n = await recoverExpiredAssignments();
    expect(n).toBe(1);
    expect(store.assignments[0]!.status).toBe('EXPIRED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'local.task_expired' }));
  });

  it('reconnect re-delivers live assignments to the device', async () => {
    setup({ assignments: [assignmentRow({ status: 'ASSIGNED' })], tasks: [taskRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    const n = await onAgentReady(USER_ID, DEVICE_ID);
    expect(n).toBe(1);
    expect(hub.sendToDevice).toHaveBeenCalledTimes(1);
  });
});
