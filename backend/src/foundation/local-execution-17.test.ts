/**
 * CodeConClave — PHASE 17 local-execution E2E.
 *
 * The local execution contract is honesty: offline means WAITING_FOR_LOCAL_AGENT
 * and never a claimed pipeline run. When a device connects, the flow is
 * connect → authenticate (paired device) → revalidate (remote session +
 * capability + task mode) → execute. Every branch below runs the REAL
 * service code through the in-memory SQL emulation.
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

const USER_ID = 'u1';
const DEVICE_ID = 'dev1';

function setup() {
  const devices: Record<string, unknown>[] = [
    { id: DEVICE_ID, name: 'Dev Box', user_id: USER_ID, state: 'PAIRED', capabilities: ['terminal_exec', 'browser'], paired_at: new Date().toISOString(), last_seen_at: null, created_at: new Date().toISOString() },
  ];
  const remoteSessions: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];

  const row = (text: string, params: unknown[]) => {
    const t = text.toLowerCase();
    if (t.includes('from devices')) return devices.filter((d) => d.id === params[0]);
    if (t.includes('from remote_sessions')) {
      if (t.includes('select 1 from remote_sessions')) {
        return remoteSessions.filter((s) => s.owner_id === params[0] && s.device_id === params[1] && s.state === 'ACTIVE');
      }
      return remoteSessions;
    }
    if (t.includes('insert into remote_sessions')) {
      remoteSessions.push({ id: params[0], owner_id: params[1], device_id: params[2], state: 'ACTIVE', started_at: null, expires_at: new Date(Date.now() + Number(params[3])).toISOString(), last_active_at: null, screenshot_authorized: false, screenshot_auth_expires_at: null, revoked_at: null, created_at: new Date().toISOString() });
      return [];
    }
    if (t.includes('update remote_sessions')) {
      const target = remoteSessions.find((s) => s.id === params[0]);
      if (target) {
        target.state = 'REVOKED';
        return [{ id: params[0] }];
      }
      return [];
    }
    if (t.includes('from projects where id = $1')) {
      return [{ id: params[0], owner_id: USER_ID, team_id: null, deleted_at: null }];
    }
    if (t.includes('insert into tasks')) {
      tasks.push({ id: params[0], project_id: params[1], conversation_id: params[2], owner_id: params[3], title: params[4], description: params[5], status: 'CREATED', risk_level: params[6], required_approval: params[7], coworker_pipeline: params[8], execution_mode: params[9], timeout_ms: params[10], max_attempts: params[11], priority: params[12], created_at: new Date(), updated_at: new Date(), deleted_at: null });
      return [];
    }
    if (t.includes('update tasks set')) {
      const target = tasks.find((x) => x.id === params[0]);
      if (target) target.status = params[1];
      return [];
    }
    if (t.includes('from tasks')) return tasks;
    if (t.includes('from task_attempts') || t.includes('from coworker_runs') || t.includes('from plans')) return [];
    return [];
  };
  db.state.resolve = (text, params) => row(text, params);
  return { devices, remoteSessions, tasks };
}

import { createTask, setTaskStatus } from '../modules/execution/tasks.js';
import { executeTask } from '../modules/execution/orchestrator.js';
import { requirePairedDevice, requireAgentOnline, requireRemoteSession, hasActiveRemoteSession, devicePresence } from '../modules/agent/service.js';
import { createRemoteSession, revokeRemoteSession } from '../modules/remote/service.js';
import { AppError } from '../shared/errors.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  recordAudit.mockClear();
});

describe('PHASE 17 local execution — offline honesty', () => {
  it('a LOCAL task becomes WAITING_FOR_LOCAL_AGENT and never runs a pipeline offline', async () => {
    const { tasks } = setup();
    const task = await createTask({ userId: USER_ID, projectId: 'p1', title: 'Run on my machine', description: 'local', riskLevel: 'LOW', executionMode: 'LOCAL' });
    await executeTask(task);

    const stored = tasks[0] as Record<string, unknown>;
    expect(stored.status).toBe('WAITING_FOR_LOCAL_AGENT');
    // No attempt, no coworker run, no plan: nothing is claimed offline.
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_attempts'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO coworker_runs'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO plans'))).toBe(false);
  });

  it('requireAgentOnline throws the honest offline error — no execution claimed', () => {
    expect(() => requireAgentOnline(USER_ID, DEVICE_ID, () => false)).toThrowError(
      expect.objectContaining({ errorCode: 'local_agent_offline' }),
    );
    const err = (() => {
      try {
        requireAgentOnline(USER_ID, DEVICE_ID, () => false);
      } catch (e) {
        return e as AppError;
      }
    })()!;
    expect(err.message).toContain('no local execution is active and none is claimed');
  });
});

describe('PHASE 17 local execution — connect + authenticate + revalidate', () => {
  it('a paired device authenticates, a remote session is created idempotently, and revalidation passes', async () => {
    const { remoteSessions } = setup();
    const device = await requirePairedDevice(USER_ID, DEVICE_ID);
    expect(device.name).toBe('Dev Box');
    expect(device.capabilities).toContain('terminal_exec');

    const online = (): boolean => true;
    expect(() => requireAgentOnline(USER_ID, DEVICE_ID, online)).not.toThrow();

    const session = await createRemoteSession(USER_ID, DEVICE_ID);
    expect(session.state).toBe('ACTIVE');
    expect(session.deviceId).toBe(DEVICE_ID);
    // Idempotent: a second call reuses the ACTIVE session instead of duplicating.
    const again = await createRemoteSession(USER_ID, DEVICE_ID);
    expect(again.id).toBe(session.id);
    expect(remoteSessions.length).toBe(1);

    await requireRemoteSession(USER_ID, DEVICE_ID);
    expect(await hasActiveRemoteSession(USER_ID, DEVICE_ID)).toBe(true);
  });

  it('revalidation rejects a revoked remote session', async () => {
    setup();
    const session = await createRemoteSession(USER_ID, DEVICE_ID);
    await revokeRemoteSession(USER_ID, session.id);
    await expect(requireRemoteSession(USER_ID, DEVICE_ID)).rejects.toMatchObject({ errorCode: 'remote_session_required' });
  });

  it('revalidation rejects an unpaired device', async () => {
    setup();
    await expect(requirePairedDevice(USER_ID, 'dev_unknown')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('presence is derived, never guessed', () => {
    expect(devicePresence(null, false)).toBe('OFFLINE');
    expect(devicePresence(new Date().toISOString(), true)).toBe('ONLINE');
    expect(devicePresence(new Date(Date.now() - 30_000).toISOString(), false)).toBe('STALE');
    expect(devicePresence(new Date(Date.now() - 86_400_000).toISOString(), false)).toBe('OFFLINE');
  });
});

describe('PHASE 17 local execution — task revalidation after reconnect', () => {
  it('a LOCAL task that was parked stays WAITING_FOR_LOCAL_AGENT until a device executes it', async () => {
    const { tasks } = setup();
    const task = await createTask({ userId: USER_ID, projectId: 'p1', title: 'Local job', riskLevel: 'LOW', executionMode: 'LOCAL' });
    await executeTask(task);
    expect((tasks[0] as Record<string, unknown>).status).toBe('WAITING_FOR_LOCAL_AGENT');

    // The device reconnects and revalidates: it is authenticated and its
    // remote session is active, so the parked task is the one it may claim.
    const device = await requirePairedDevice(USER_ID, DEVICE_ID);
    await createRemoteSession(USER_ID, DEVICE_ID);
    await requireAgentOnline(USER_ID, DEVICE_ID, () => true);
    await requireRemoteSession(USER_ID, DEVICE_ID);
    expect(device.capabilities).toContain('terminal_exec');
    // Parked state is preserved and visible to the connected device.
    expect((tasks[0] as Record<string, unknown>).status).toBe('WAITING_FOR_LOCAL_AGENT');
  });
});

describe('PHASE 17 local execution — creation contract honors executionMode', () => {
  it('createTaskFromChat with executionMode LOCAL parks the task instead of enqueueing it', async () => {
    const { tasks } = setup();
    const { createTaskFromChat } = await import('../modules/execution/orchestrator.js');
    const task = await createTaskFromChat({
      userId: USER_ID,
      projectId: 'p1',
      conversationId: '',
      title: 'Run locally from the UI',
      riskLevel: 'LOW',
      executionMode: 'LOCAL',
    });
    expect(task.execution_mode).toBe('LOCAL');
    const stored = tasks[0] as Record<string, unknown>;
    expect(stored.status).toBe('WAITING_FOR_LOCAL_AGENT');
    expect(task.status).toBe('WAITING_FOR_LOCAL_AGENT');
    // Nothing claimed or executed offline, and no attempt/coworker run was made.
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO task_attempts'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO coworker_runs'))).toBe(false);
  });

  it('createTaskFromChat defaults CLOUD tasks to the enqueued worker path (never parked)', async () => {
    setup();
    const { createTaskFromChat } = await import('../modules/execution/orchestrator.js');
    const task = await createTaskFromChat({
      userId: USER_ID,
      projectId: 'p1',
      conversationId: '',
      title: 'Cloud task',
      riskLevel: 'LOW',
    });
    expect(task.execution_mode).toBe('CLOUD');
    const parked = db.state.calls.some((c) => c.params[1] === 'WAITING_FOR_LOCAL_AGENT');
    expect(parked).toBe(false);
  });
});