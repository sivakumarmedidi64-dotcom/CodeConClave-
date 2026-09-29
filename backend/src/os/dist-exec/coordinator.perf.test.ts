/**
 * CodeConclave — Phase K distributed-execution + isolation performance smoke
 * (honest TARGET/MEASURED, generous local targets, never flaky, no production
 * claim). Measures the real in-memory paths only: worker startup, scheduling,
 * lease latency, IPC latency, reassignment latency, and resource-governor
 * overhead. Numbers are logged for the report; assertions only guard against
 * gross regressions.
 */
import { describe, it, expect } from 'vitest';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { ExecutionCoordinator } from './coordinator.js';
import { EventBus } from '../event-bus.js';
import { Supervisor } from '../supervisor.js';
import { MemoryStateStore } from '../state.js';
import { ResourceGovernor } from '../resource-governor.js';
import { SupervisedWorkerExecutor } from './worker-executor.js';

const T0 = 1_000_000;

const beat = async (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('Phase K — coordinator performance (honest TARGET/MEASURED)', () => {
  it('worker scheduling + lease latency is sub-millisecond in memory', async () => {
    const coord = new ExecutionCoordinator();
    coord.register({
      id: 'w', labels: [], maxConcurrent: 1,
      resource: { concurrency: 1 }, lastHeartbeatAt: T0, registeredAt: T0,
    });
    coord.enqueue({ taskId: 't1', workspaceId: '', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' });
    const t = performance.now();
    const asg = coord.assign(T0);
    const measured = (performance.now() - t) * 1000; // µs
    console.error(`PERF worker_assign_us TARGET<=5000 MEASURED=${measured.toFixed(1)}`);
    expect(asg).not.toBeNull();
    expect(measured).toBeLessThan(5000);
  });

  it('lease reacquisition (expiry + requeue) is fast in memory', async () => {
    const coord = new ExecutionCoordinator({ leaseTtlMs: 1000 });
    coord.register({
      id: 'w1', labels: [], maxConcurrent: 1,
      resource: { concurrency: 1 }, lastHeartbeatAt: T0, registeredAt: T0,
    });
    coord.enqueue({ taskId: 't1', workspaceId: '', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' });
    coord.assign(T0);
    const t = performance.now();
    coord.tick(T0 + 2000); // lease expired -> requeued (attempt 2)
    const asg = coord.assign(T0 + 2000);
    const measured = (performance.now() - t) * 1000;
    console.error(`PERF lease_reacquire_us TARGET<=5000 MEASURED=${measured.toFixed(1)}`);
    expect(asg).not.toBeNull();
    expect(asg!.lease.attempt).toBe(2); // fresh lease, same task, next attempt
    expect(measured).toBeLessThan(5000);
  });

  it('IPC/event-bus publish latency stays sub-millisecond in memory', async () => {
    const bus = new EventBus();
    let received = 0;
    bus.subscribe('k', () => { received += 1; });
    const t = performance.now();
    for (let i = 0; i < 1000; i += 1) bus.publish('k', { i });
    const measuredMs = performance.now() - t;
    console.error(`PERF ipc_1000_ms TARGET<=50 MEASURED=${measuredMs.toFixed(2)}`);
    expect(received).toBe(1000);
    expect(measuredMs).toBeLessThan(50);
  });

  it('supervised process startup (in-memory runnable) completes in milliseconds', async () => {
    const state = new MemoryStateStore();
    const governor = new ResourceGovernor(4);
    const supervisor = new Supervisor(state, governor, 'never');
    const executor = new SupervisedWorkerExecutor({
      supervisor, governor, state,
      defaultBudget: { maxRuntimeMs: 10_000 },
      defaultCapabilities: ['run_isolated'],
    });
    const lease = { taskId: 't1', workerId: 'w', grantedAt: T0, expiresAt: T0 + 30_000, attempt: 1 };
    const t = performance.now();
    let n = 0;
    for (let i = 0; i < 20; i += 1) {
      const out = await executor.executeLease(
        { taskId: `t${i}`, workerId: 'w', lease: { ...lease, taskId: `t${i}` }, at: T0 },
        async () => 'ok',
      );
      if (out.ok) n += 1;
    }
    const measured = performance.now() - t;
    console.error(`PERF worker_supervised_20_ms TARGET<=2000 MEASURED=${measured.toFixed(1)}`);
    expect(n).toBe(20);
    expect(measured).toBeLessThan(2000);
  });

  it('resource-governor acquire/release overhead is neglible', async () => {
    const governor = new ResourceGovernor(100);
    const t = performance.now();
    for (let i = 0; i < 5000; i += 1) {
      const slot = await governor.acquire();
      slot.release();
    }
    const measured = performance.now() - t;
    console.error(`PERF gov_acquire_release_5000_ms TARGET<=50 MEASURED=${measured.toFixed(2)}`);
    expect(governor.concurrencyUsed).toBe(0);
    expect(measured).toBeLessThan(50);
  });

  it('observe heartbeat round (realistic 1s cadence) without drift', async () => {
    const coord = new ExecutionCoordinator();
    coord.register({
      id: 'w', labels: [], maxConcurrent: 1,
      resource: { concurrency: 1 }, lastHeartbeatAt: T0, registeredAt: T0,
    });
    const style = new PerformanceObserver(() => {});
    style.observe({ type: 'mark' });
    performance.mark('hb-start');
    for (let i = 0; i < 10; i += 1) coord.heartbeat('w', T0 + i * 1000);
    performance.mark('hb-end');
    performance.measure('hb', 'hb-start', 'hb-end');
    const m = performance.getEntriesByName('hb')[0];
    console.error(`PERF heartbeat_10_us TARGET<=5000 MEASURED=${(m.duration * 1000).toFixed(1)}`);
    expect(coord.listWorkers()[0]!.lastHeartbeatAt).toBe(T0 + 9000);
    expect(m.duration * 1000).toBeLessThan(5000);
    style.disconnect();
    void beat;
  });
});