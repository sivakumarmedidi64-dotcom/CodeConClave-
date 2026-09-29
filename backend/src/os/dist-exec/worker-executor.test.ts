/**
 * CodeConclave — SupervisedWorkerExecutor tests (Phase E supervisor binding).
 *
 * Verifies the missing link between a coordinator lease and the EXISTING
 * Supervisor: leases run through the canonical lifecycle and produce a RESULT,
 * recover from failures via the supervisor, never get more authority than the
 * task requires (capability/budget enforcement), and do not restart beyond the
 * coordinator's retry ownership.
 */
import { describe, it, expect, vi } from 'vitest';
import { SupervisedWorkerExecutor } from './worker-executor.js';
import { ExecutionCoordinator } from './coordinator.js';
import { EventBus } from '../event-bus.js';
import { Supervisor } from '../supervisor.js';
import { MemoryStateStore } from '../state.js';
import { ResourceGovernor } from '../resource-governor.js';

const T0 = 1_000_000;

function makeStack(over = {}) {
  const state = new MemoryStateStore();
  const governor = new ResourceGovernor(4);
  const supervisor = new Supervisor(state, governor, 'never');
  const bus = new EventBus();
  const executor = new SupervisedWorkerExecutor({
    supervisor,
    governor,
    state,
    eventBus: bus,
    defaultBudget: { maxRuntimeMs: 10_000 },
    defaultCapabilities: ['run_isolated', 'exec_python'],
    ...over,
  });
  return { state, governor, supervisor, bus, executor };
}

const lease = {
  taskId: 'task-1',
  workerId: 'worker-a',
  grantedAt: T0,
  expiresAt: T0 + 30_000,
  attempt: 1,
};

describe('SupervisedWorkerExecutor — lease → Supervisor → RESULT', () => {
  it('runs a lease through the supervisor and returns the RESULT', async () => {
    const { executor } = makeStack();
    const outcome = await executor.executeLease(
      { taskId: 'task-1', workerId: 'worker-a', lease, at: T0 },
      async () => 'produced-result',
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe('produced-result');
    expect(outcome.processId).toBeTruthy();
  });

  it('propagates a failing runnable as an honest failed outcome (no retry by executor)', async () => {
    const { executor } = makeStack();
    const outcome = await executor.executeLease(
      { taskId: 'task-1', workerId: 'worker-a', lease, at: T0 },
      async () => {
        throw new Error('boom');
      },
    );
    expect(outcome.ok).toBe(false);
    // The supervisor faults plain errors honestly; the executor does NOT retry.
    expect(outcome.errorCode).toBe('aios_proc_failed');
    expect(outcome.result).toBeNull();
  });

  it('respects the resource governor ceiling (fail-closed before running)', async () => {
    const governor = new ResourceGovernor(0);
    const state = new MemoryStateStore();
    const supervisor = new Supervisor(state, governor, 'never');
    const executor = new SupervisedWorkerExecutor({
      supervisor,
      governor,
      state,
      defaultBudget: { maxRuntimeMs: 10_000 },
      defaultCapabilities: ['run_isolated'],
    });
    const outcome = await executor.executeLease(
      { taskId: 'task-2', workerId: 'worker-a', lease: { ...lease, taskId: 'task-2' }, at: T0 },
      async () => 'should-not-run',
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('aios_resource_limited');
  });

  it('checkpoints the result durably into the state store', async () => {
    const { state, executor } = makeStack();
    const outcome = await executor.executeLease(
      { taskId: 'task-3', workerId: 'worker-a', lease: { ...lease, taskId: 'task-3' }, at: T0 },
      async () => 'durable-result',
    );
    const found = await state.get<{ parent: string; data: string }>(`os:proc:${outcome.processId}:dist-exec:result`);
    expect(found).toBeTruthy();
    expect(found!.data.data).toBe('durable-result');
  });

  it('does not restart a lease-owned task (coordinator owns retry policy)', async () => {
    const onEvent = vi.fn();
    const state = new MemoryStateStore();
    const governor = new ResourceGovernor(4);
    const supervisor = new Supervisor(state, governor, 'on_failure', onEvent);
    const executor = new SupervisedWorkerExecutor({
      supervisor,
      governor,
      state,
      defaultBudget: { maxRuntimeMs: 10_000 },
      defaultCapabilities: ['run_isolated'],
    });
    process.env.FORCE_FAIL_ONCE = '1';
    try {
      const outcome = await executor.executeLease(
        { taskId: 'task-4', workerId: 'worker-a', lease: { ...lease, taskId: 'task-4' }, at: T0 },
        async () => {
          const v = process.env.FORCE_FAIL_ONCE;
          if (v === '1') {
            process.env.FORCE_FAIL_ONCE = '0';
            throw new Error('transient');
          }
          return 'ok';
        },
      );
      expect(outcome.restarts).toBe(0);
      expect(outcome.ok).toBe(false); // maxRestarts=0 -> no retry inside executor
    } finally {
      delete process.env.FORCE_FAIL_ONCE;
    }
  });
});

describe('Phase F — capability-profile routing (coordinator side)', () => {
  const coord = new ExecutionCoordinator({ requireWorkspaceBinding: true });

  const gpuWorker = {
    id: 'gpu1',
    labels: ['gpu'],
    capabilities: ['run_isolated', 'exec_torch'],
    workspaceId: 'w1',
    maxConcurrent: 1,
    resource: {
      concurrency: 1,
      os: 'linux',
      architecture: 'amd64',
      gpu: true,
      networkPolicy: 'isolated' as const,
      executionClass: 'container' as const,
    },
    lastHeartbeatAt: T0,
    registeredAt: T0,
  };

  it('routes a GPU task only to a worker advertising gpu=true', () => {
    coord.register(gpuWorker);
    const req = {
      taskId: 'gpu-task',
      workspaceId: 'w1',
      priority: 1,
      requiredLabels: [],
      capabilities: ['run_isolated', 'exec_torch'],
      requireGpu: true,
      requireOs: 'linux',
      requireArchitecture: 'amd64',
      requireExecutionClass: 'container' as const,
      runnableKind: 'train',
    };
    coord.enqueue(req);
    const asg = coord.assign(T0);
    expect(asg).not.toBeNull();
    expect(asg!.workerId).toBe('gpu1');
  });

  it('does NOT route a GPU task to a worker that lacks the advertised profile', () => {
    const coord2 = new ExecutionCoordinator({ requireWorkspaceBinding: true });
    const cpuWorker = {
      id: 'cpu1',
      labels: ['cpu'],
      capabilities: ['run_isolated', 'exec_torch'],
      workspaceId: 'w1',
      maxConcurrent: 1,
      resource: {
        concurrency: 1,
        os: 'linux',
        architecture: 'amd64',
        gpu: false,
        networkPolicy: 'isolated' as const,
        executionClass: 'container' as const,
      },
      lastHeartbeatAt: T0,
      registeredAt: T0,
    };
    coord2.register(cpuWorker);
    coord2.enqueue({
      taskId: 'gpu-task',
      workspaceId: 'w1',
      priority: 1,
      requiredLabels: [],
      capabilities: ['run_isolated', 'exec_torch'],
      requireGpu: true,
      runnableKind: 'train',
    });
    expect(coord2.assign(T0)).toBeNull();
  });

  it('enforces network-policy matching', () => {
    const coord3 = new ExecutionCoordinator({ requireWorkspaceBinding: true });
    coord3.register({ ...gpuWorker, id: 'net1', workspaceId: 'w1', resource: { ...gpuWorker.resource, networkPolicy: 'none' as const } });
    coord3.enqueue({
      taskId: 'net-task',
      workspaceId: 'w1',
      priority: 1,
      requiredLabels: [],
      capabilities: ['run_isolated'],
      requireNetworkPolicy: 'isolated',
      runnableKind: 'fetch',
    });
    expect(coord3.assign(T0)).toBeNull();
  });
});

describe('SupervisedWorkerExecutor — audit/security', () => {
  it('never gives the runnable beyond its declared capability budget', async () => {
    const received: string[] = [];
    const { executor } = makeStack();
    await executor.executeLease(
      { taskId: 'sec-1', workerId: 'worker-a', lease: { ...lease, taskId: 'sec-1' }, at: T0 },
      async () => {
        received.push(Object.keys(process.env).some((k) => k.startsWith('CC_')) ? 'secret' : 'none');
        return 'no-secret';
      },
    );
    expect(received).toEqual(['none']);
  });
});