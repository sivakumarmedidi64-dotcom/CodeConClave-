/**
 * CodeConClave — P2 unified action runtime tests.
 *
 * Pins the routing contract: the master gate is honored, each surface is gated
 * by its own flag, instructions are validated by the SAME browser/desktop
 * policies the rest of the product uses, and a routed action lands on the real
 * task fabric with the right execution mode. No DB / no network — the task
 * creator and device check are injected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  UNIFIED_ACTION_RUNTIME_ENABLED: 'true',
  LOCAL_EXECUTION_ENABLED: 'true',
  BROWSER_CONTROL_ENABLED: 'true',
  DESKTOP_CONTROL_ENABLED: 'true',
  LIVE_PREVIEW_ENABLED: 'true',
  DESKTOP_ALLOWED_APPS: 'notepad, calculator',
}));
vi.mock('../../config/env.js', () => ({ env: mockEnv }));

const recordAudit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../audit/service.js', () => ({ recordAudit }));

const requestBuild = vi.hoisted(() => vi.fn(async () => ({ id: 'pvw-1', project_id: 'p1', state: 'BUILDING', version: 2 })));
vi.mock('../preview/service.js', () => ({ requestBuild }));

import { routeAction, listActionSurfaces, stopAllWork } from './service.js';

const base = { userId: 'u1', projectId: 'p1', title: 'Do the thing' };
const browserInstruction = {
  type: 'browser',
  grants: { capabilities: ['browser.navigate'], allowedOrigins: ['https://example.com'] },
  actions: [{ op: 'navigate', url: 'https://example.com' }],
};
const desktopInstruction = {
  type: 'desktop',
  grants: { capabilities: ['desktop.inspect'], lifetimeMs: 60_000 },
  actions: [{ op: 'list_windows' }],
};

function makeDeps() {
  const createTask = vi.fn(async (input: Record<string, unknown>) => ({ id: 't1', execution_mode: input.executionMode }));
  const assertDeviceOwned = vi.fn(async () => {});
  return { createTask, assertDeviceOwned, deps: { createTask, assertDeviceOwned } as never };
}

describe('unified action runtime — surface catalogue', () => {
  it('reports honest availability from the real gates', () => {
    const views = listActionSurfaces();
    expect(views.map((v) => v.surface)).toEqual(['CLOUD', 'LOCAL', 'BROWSER', 'DESKTOP', 'PREVIEW']);
    expect(views.find((v) => v.surface === 'CLOUD')!.enabled).toBe(true);
    for (const s of ['LOCAL', 'BROWSER', 'DESKTOP', 'PREVIEW'] as const) {
      expect(views.find((v) => v.surface === s)!.enabled).toBe(true);
    }
  });
});

describe('unified action runtime — routing', () => {
  beforeEach(() => {
    mockEnv.UNIFIED_ACTION_RUNTIME_ENABLED = 'true';
    mockEnv.LOCAL_EXECUTION_ENABLED = 'true';
    mockEnv.BROWSER_CONTROL_ENABLED = 'true';
    mockEnv.DESKTOP_CONTROL_ENABLED = 'true';
    mockEnv.LIVE_PREVIEW_ENABLED = 'true';
  });

  it('refuses when the runtime class is disabled', async () => {
    mockEnv.UNIFIED_ACTION_RUNTIME_ENABLED = 'false';
    const { deps } = makeDeps();
    await expect(routeAction({ ...base }, deps)).rejects.toMatchObject({ errorCode: 'unified_action_runtime_disabled' });
  });

  it('routes a plain request to CLOUD with no instruction', async () => {
    const { deps, createTask, assertDeviceOwned } = makeDeps();
    const out = await routeAction({ ...base }, deps);
    expect(out.surface).toBe('CLOUD');
    expect(out.executionMode).toBe('CLOUD');
    expect(out.instruction).toBeUndefined();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(assertDeviceOwned).not.toHaveBeenCalled();
  });

  it('routes a browser instruction to LOCAL on a pinned device', async () => {
    const { deps, createTask, assertDeviceOwned } = makeDeps();
    const out = await routeAction({ ...base, deviceId: 'dev1', localInstruction: browserInstruction }, deps);
    expect(out.surface).toBe('BROWSER');
    expect(out.executionMode).toBe('LOCAL');
    expect((out.instruction as { type: string }).type).toBe('browser');
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'LOCAL' }));
    expect(assertDeviceOwned).toHaveBeenCalledWith('u1', 'dev1');
  });

  it('refuses a surface whose gate is off', async () => {
    mockEnv.DESKTOP_CONTROL_ENABLED = 'false';
    const { deps } = makeDeps();
    await expect(routeAction({ ...base, surface: 'DESKTOP', localInstruction: desktopInstruction }, deps)).rejects.toMatchObject({
      errorCode: 'desktop_surface_disabled',
    });
  });

  it('rejects a malformed browser instruction', async () => {
    const { deps } = makeDeps();
    await expect(routeAction({ ...base, surface: 'BROWSER', localInstruction: { type: 'browser' } }, deps)).rejects.toMatchObject({
      errorCode: 'invalid_browser_instruction',
    });
  });

  it('routes an allow-listed desktop action and rejects a non-allowlisted app', async () => {
    const { deps, createTask } = makeDeps();
    const out = await routeAction({ ...base, surface: 'DESKTOP', localInstruction: desktopInstruction, deviceId: 'd1' }, deps);
    expect(out.surface).toBe('DESKTOP');
    expect(out.executionMode).toBe('LOCAL');
    expect(createTask).toHaveBeenCalledTimes(1);

    const bad = { ...desktopInstruction, actions: [{ op: 'open_app', app: 'cmd' }] };
    await expect(routeAction({ ...base, surface: 'DESKTOP', localInstruction: bad }, deps)).rejects.toMatchObject({
      errorCode: 'invalid_desktop_instruction',
    });
  });

  it('routes a LOCAL command and rejects a command-less LOCAL instruction', async () => {
    const { deps, createTask } = makeDeps();
    const out = await routeAction({ ...base, surface: 'LOCAL', localInstruction: { command: 'ls' } }, deps);
    expect(out.surface).toBe('LOCAL');
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'LOCAL' }));
    await expect(routeAction({ ...base, surface: 'LOCAL', localInstruction: {} }, deps)).rejects.toMatchObject({
      errorCode: 'invalid_local_instruction',
    });
  });

  it('refuses a disabled BROWSER surface before validating', async () => {
    mockEnv.BROWSER_CONTROL_ENABLED = 'false';
    const { deps } = makeDeps();
    await expect(routeAction({ ...base, localInstruction: browserInstruction }, deps)).rejects.toMatchObject({
      errorCode: 'browser_surface_disabled',
    });
  });
});

describe('unified action runtime — PREVIEW surface', () => {
  beforeEach(() => {
    mockEnv.UNIFIED_ACTION_RUNTIME_ENABLED = 'true';
    mockEnv.LIVE_PREVIEW_ENABLED = 'true';
    requestBuild.mockClear();
    recordAudit.mockClear();
  });

  it('routes a PREVIEW action to a real preview build (no task, no instruction)', async () => {
    const { deps, createTask } = makeDeps();
    const out = await routeAction({ ...base, surface: 'PREVIEW' }, deps);
    expect(out.surface).toBe('PREVIEW');
    expect(out.executionMode).toBe('PREVIEW');
    expect(requestBuild).toHaveBeenCalledWith('u1', 'p1');
    expect(createTask).not.toHaveBeenCalled();
    expect(out.session).toMatchObject({ id: 'pvw-1', state: 'BUILDING' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'action.routed' }));
  });

  it('refuses a PREVIEW surface whose gate is off', async () => {
    mockEnv.LIVE_PREVIEW_ENABLED = 'false';
    const { deps } = makeDeps();
    await expect(routeAction({ ...base, surface: 'PREVIEW' }, deps)).rejects.toMatchObject({
      errorCode: 'preview_surface_disabled',
    });
    expect(requestBuild).not.toHaveBeenCalled();
  });

  it('rejects a PREVIEW action carrying an instruction or device', async () => {
    const { deps } = makeDeps();
    await expect(routeAction({ ...base, surface: 'PREVIEW', localInstruction: { command: 'x' } }, deps)).rejects.toMatchObject({
      errorCode: 'invalid_preview_action',
    });
    await expect(routeAction({ ...base, surface: 'PREVIEW', deviceId: 'd1' }, deps)).rejects.toMatchObject({
      errorCode: 'invalid_preview_action',
    });
    expect(requestBuild).not.toHaveBeenCalled();
  });
});

describe('unified action runtime — stop-all', () => {
  beforeEach(() => {
    mockEnv.UNIFIED_ACTION_RUNTIME_ENABLED = 'true';
    recordAudit.mockClear();
  });

  function stopDeps() {
    return {
      listActiveAssignments: vi.fn(async () => [{ id: 'a1', task_id: 't1' }, { id: 'a2', task_id: 't2' }]),
      cancelAssignmentById: vi.fn(async () => {}),
      listProjectTasks: vi.fn(async () => [
        { id: 't1', status: 'RUNNING' },
        { id: 't9', status: 'COMPLETED' },
      ]),
      cancelTaskById: vi.fn(async () => ({})),
    };
  }

  it('cancels active assignments and cancellable project tasks, skipping terminal ones', async () => {
    const deps = stopDeps();
    const out = await stopAllWork({ userId: 'u1', projectId: 'p1' }, deps);
    expect(out.assignmentsCancelled).toEqual(['a1', 'a2']);
    expect(out.assignmentsFailed).toEqual([]);
    expect(out.tasksCancelled).toEqual(['t1']);
    expect(out.tasksSkipped).toEqual(['t9']);
    expect(deps.cancelAssignmentById).toHaveBeenCalledTimes(2);
    expect(deps.cancelTaskById).toHaveBeenCalledWith('u1', 't1', expect.any(String));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'action.stop_all' }));
  });

  it('reports assignment failures honestly instead of claiming them stopped', async () => {
    const deps = stopDeps();
    deps.cancelAssignmentById.mockRejectedValueOnce(new Error('ledger down'));
    const out = await stopAllWork({ userId: 'u1' }, deps);
    expect(out.assignmentsCancelled).toEqual(['a2']);
    expect(out.assignmentsFailed).toEqual([{ id: 'a1', error: 'ledger down' }]);
    expect(out.tasksCancelled).toEqual([]);
  });

  it('refuses when the runtime is disabled', async () => {
    mockEnv.UNIFIED_ACTION_RUNTIME_ENABLED = 'false';
    await expect(stopAllWork({ userId: 'u1' }, stopDeps())).rejects.toMatchObject({
      errorCode: 'unified_action_runtime_disabled',
    });
  });
});
