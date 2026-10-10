/**
 * CodeConClave — P1 browser dispatch fabric tests.
 *
 * Runs the REAL dispatcher (dispatch.ts) with the REAL browser policy
 * (browser-policy.ts) against the in-memory SQL emulation. Proves the P1
 * contract end-to-end at the dispatch layer:
 *  - browser instructions NEVER dispatch while BROWSER_CONTROL_ENABLED is off;
 *  - devices must advertise the exact browser capabilities to be eligible;
 *  - the assignment frame carries the validated instruction;
 *  - a user-pinned device is a hard scope (no silent hop to another device);
 *  - a failed non-idempotent browser action is dead-lettered, never replayed,
 *    while retryable (read/view) failures re-park while budget remains.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  LOCAL_EXECUTION_ENABLED: 'true',
  LOCAL_TASK_LEASE_MS: 120_000,
  BROWSER_CONTROL_ENABLED: 'false',
}));
vi.mock('../../config/env.js', () => ({ env: mockEnv }));

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
  beginAttempt: vi.fn(async () => ({ id: 'atp_new', task_id: 'tsk_b', attempt_number: 1, started_at: new Date(), finished_at: null, result: null, error_code: null, output_summary: null })),
  finishAttempt: vi.fn(async () => {}),
  touchTask: vi.fn(async () => {}),
  clearTaskFailureState: vi.fn(async () => {}),
  deadLetterTask: vi.fn(async () => {}),
}));
vi.mock('../execution/tasks.js', () => tasks);

vi.mock('../runtime/events.js', () => ({ broadcastRuntime: vi.fn(() => undefined) }));

const USER_ID = 'u1';
const DEVICE_ID = 'dev_browser';
const TASK_ID = 'tsk_b';

const BROWSER_INSTRUCTION = {
  type: 'browser',
  grants: {
    capabilities: ['browser.open', 'browser.read', 'browser.inspect', 'browser.click', 'browser.type', 'browser.submit'],
    allowedOrigins: ['http://127.0.0.1:*'],
    lifetimeMs: 86_400_000,
  },
  actions: [
    { op: 'open', url: 'http://127.0.0.1:4001/' },
    { op: 'read' },
    { op: 'click', selector: '#btn' },
    { op: 'submit', selector: 'form' },
  ],
};

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    project_id: 'prj_1',
    conversation_id: null,
    owner_id: USER_ID,
    title: 'Browser run',
    description: null,
    status: 'WAITING_FOR_LOCAL_AGENT',
    execution_mode: 'LOCAL',
    local_instruction: BROWSER_INSTRUCTION,
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
    id: 'lta_b',
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

function setup(seed: Partial<Store> = {}): Store {
  const store: Store = { devices: [], assignments: [], tasks: [], ...seed };
  db.state.resolve = (rawText, params) => {
    const t = rawText.toLowerCase();
    if (t.includes('from devices')) return store.devices.filter((d) => d.user_id === params[0] && d.state === 'PAIRED');
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
      return [];
    }
    if (t.includes('update local_task_assignments')) {
      const target = store.assignments.find((a) => a.id === params[0]);
      if (!target) return [];
      if (t.includes("set progress = $2")) target.progress = JSON.parse(String(params[1]));
      else if (t.includes("set status = 'running', attempt_id")) {
        target.status = 'RUNNING';
        target.attempt_id = params[1];
        target.attempt_number = params[2];
      } else if (t.includes("set status = 'failed'")) {
        target.status = 'FAILED';
        target.error_code = params[1];
        target.error_detail = params[2];
      }
      return [];
    }
    if (t.includes('from tasks')) return store.tasks;
    return [];
  };
  return store;
}

import { dispatchLocalTask, failAssignment, resolveEligibleDevices } from './dispatch.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  hub.sendToDevice.mockClear();
  hub.isOnline.mockReset();
  hub.isOnline.mockReturnValue(true);
  for (const fn of Object.values(tasks)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
  recordAudit.mockClear();
});

describe('P1 browser dispatch fabric', () => {
  it('is gated OFF by default: a browser task never dispatches', async () => {
    setup({ tasks: [taskRow()], devices: [{ id: DEVICE_ID, name: 'Box', user_id: USER_ID, state: 'PAIRED', capabilities: ['browser.open', 'browser.submit'] }] });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    const res = await dispatchLocalTask(TASK_ID, () => true);
    expect(res).toEqual({ dispatched: false, reason: 'browser_control_disabled' });
    expect(hub.sendToDevice).not.toHaveBeenCalled();
  });

  it('dispatches only when the flag is on and the device advertises every required capability', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    const store = setup({
      tasks: [taskRow()],
      devices: [
        { id: 'dev_terminal', name: 'Terminal-only', user_id: USER_ID, state: 'PAIRED', capabilities: ['terminal_exec'] },
        { id: DEVICE_ID, name: 'Browser Box', user_id: USER_ID, state: 'PAIRED', capabilities: ['browser.open', 'browser.read', 'browser.inspect', 'browser.click', 'browser.type', 'browser.submit'] },
      ],
    });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    const res = await dispatchLocalTask(TASK_ID, () => true);
    expect(res.dispatched).toBe(true);
    if (!res.dispatched) return;
    expect(res.deviceId).toBe(DEVICE_ID);
    const assigned = store.assignments[0]!;
    expect(assigned.device_id).toBe(DEVICE_ID);
    const frame = hub.sendToDevice.mock.calls[0]![2] as Record<string, unknown>;
    expect(frame.type).toBe('task_assign');
    const inner = frame.task as Record<string, unknown>;
    expect(inner.instruction).toEqual(BROWSER_INSTRUCTION);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'local.task_assigned' }));
  });

  it('requires browser capabilities explicitly (a terminal-only device is ineligible)', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    setup({
      tasks: [taskRow()],
      devices: [{ id: DEVICE_ID, name: 'Terminal-only', user_id: USER_ID, state: 'PAIRED', capabilities: ['terminal_exec'] }],
    });
    tasks.getTaskInternal.mockResolvedValue(taskRow());
    const res = await dispatchLocalTask(TASK_ID, () => true);
    expect(res).toEqual({ dispatched: false, reason: 'no_eligible_device' });
    expect(hub.sendToDevice).not.toHaveBeenCalled();
  });

  it('honors pinned deviceId: never silently hops to another device', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    const pinned = {
      ...BROWSER_INSTRUCTION,
      pinnedDeviceId: 'dev_a',
    };
    const store = setup({
      tasks: [taskRow({ local_instruction: pinned })],
      devices: [
        { id: 'dev_a', name: 'A', user_id: USER_ID, state: 'PAIRED', capabilities: ['browser.open', 'browser.read', 'browser.inspect', 'browser.click', 'browser.type', 'browser.submit'] },
        { id: 'dev_b', name: 'B', user_id: USER_ID, state: 'PAIRED', capabilities: ['browser.open', 'browser.read', 'browser.inspect', 'browser.click', 'browser.type', 'browser.submit'] },
      ],
    });
    hub.isOnline.mockImplementation((_u: string, d: string) => d !== 'dev_a'); // A offline
    tasks.getTaskInternal.mockResolvedValue(taskRow({ local_instruction: pinned }));
    const res = await dispatchLocalTask(TASK_ID, (u, d) => hub.isOnline(u, d));
    expect(res).toEqual({ dispatched: false, reason: 'no_eligible_device' }); // B online but not pinned → no hop
    expect(store.assignments).toHaveLength(0);
    expect(hub.sendToDevice).not.toHaveBeenCalled();
  });

  it('dead-letters a failed non-idempotent browser action even with retry budget left', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    setup({
      assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })],
      tasks: [taskRow()],
    });
    tasks.getTaskInternal.mockResolvedValue(taskRow({ max_attempts: 5, retry_count: 0 }));
    const out = await failAssignment({
      assignmentId: 'lta_b',
      userId: USER_ID,
      deviceId: DEVICE_ID,
      attemptNumber: 1,
      errorCode: 'browser_action_failed',
      error: JSON.stringify({ actionIndex: 3, op: 'submit', reason: 'form_validation_blocked' }),
    });
    expect(out.decision).toBe('DEAD_LETTERED');
    expect(tasks.deadLetterTask).toHaveBeenCalled();
  });

  it('dead-letters a browser failure that cannot be identified (never blind replay)', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    setup({ assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })], tasks: [taskRow()] });
    tasks.getTaskInternal.mockResolvedValue(taskRow({ max_attempts: 5, retry_count: 0 }));
    const out = await failAssignment({
      assignmentId: 'lta_b',
      userId: USER_ID,
      deviceId: DEVICE_ID,
      attemptNumber: 1,
      errorCode: 'browser_action_failed',
      error: 'mysterious failure',
    });
    expect(out.decision).toBe('DEAD_LETTERED');
  });

  it('re-parks a retryable browser failure (read/view class) while budget remains', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    setup({
      assignments: [assignmentRow({ status: 'RUNNING', attempt_id: 'atp_1', attempt_number: 1 })],
      tasks: [taskRow()],
    });
    tasks.getTaskInternal.mockResolvedValue(taskRow({ max_attempts: 5, retry_count: 0 }));
    const out = await failAssignment({
      assignmentId: 'lta_b',
      userId: USER_ID,
      deviceId: DEVICE_ID,
      attemptNumber: 1,
      errorCode: 'browser_action_failed',
      error: JSON.stringify({ actionIndex: 1, op: 'read', reason: 'page_not_loaded' }),
    });
    expect(out.decision).toBe('REPARKED');
    expect(tasks.deadLetterTask).not.toHaveBeenCalled();
  });

  it('eligibility requires the device to advertise ALL required browser ops', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    setup({
      devices: [
        { id: 'dev_full', name: 'Full', user_id: USER_ID, state: 'PAIRED', capabilities: ['browser.open', 'browser.read', 'browser.click', 'browser.submit'] },
        { id: 'dev_partial', name: 'Partial', user_id: USER_ID, state: 'PAIRED', capabilities: ['browser.open', 'browser.read'] },
      ],
    });
    const eligible = await resolveEligibleDevices(USER_ID, () => true, ['browser.open', 'browser.click', 'browser.submit'] as const);
    expect(eligible.map((d) => d.id)).toEqual(['dev_full']);
  });
});