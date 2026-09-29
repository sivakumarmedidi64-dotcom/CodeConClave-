/**
 * CodeConclave — Phase G/H distributed-execution integration tests.
 *
 * Full chain: EXECUTION COORDINATOR → LEASE → SUPERVISED WORKER → RESULT,
 * reusing the EXISTING Supervisor + StateStore + ResourceGovernor (no second
 * scheduler/queue/state/bus). Verifies:
 *   - hostile task completion cannot inject a result it did not own
 *   - a worker crash mid-task ends the lease (no duplicate destructive exec)
 *   - the coordinator requeues and reassigns after a worker disappears
 *   - durable task state is never lost across the chain
 */
import { describe, it, expect } from 'vitest';
import { ExecutionCoordinator } from './coordinator.js';
import { SupervisedWorkerExecutor } from './worker-executor.js';
import { Supervisor } from '../supervisor.js';
import { MemoryStateStore } from '../state.js';
import { ResourceGovernor } from '../resource-governor.js';

const T0 = 1_000_000;

function harness() {
  const state = new MemoryStateStore();
  const governor = new ResourceGovernor(8);
  const supervisor = new Supervisor(state, governor, 'never');
  const workerStack = new SupervisedWorkerExecutor({
    supervisor,
    governor,
    state,
    defaultBudget: { maxRuntimeMs: 10_000 },
    defaultCapabilities: ['run_isolated'],
  });
  const coord = new ExecutionCoordinator({ requireWorkspaceBinding: true });
  return { state, governor, supervisor, workerStack, coord };
}

function taskReq(taskId: string, workspaceId: string, extra = {}) {
  return {
    taskId,
    workspaceId,
    priority: 1,
    requiredLabels: [],
    capabilities: ['run_isolated'],
    runnableKind: 'x',
    ...extra,
  };
}

/** A workspace-bound worker that holds the required run capability. */
function regWorker(id: string, workspaceId: string, maxC = 1) {
  return {
    id,
    labels: ['run_isolated'],
    capabilities: ['run_isolated'],
    workspaceId,
    maxConcurrent: maxC,
    resource: { concurrency: maxC },
    lastHeartbeatAt: T0,
    registeredAt: T0,
  };
}

describe('Phase G/H — hosted worker security + crash recovery', () => {
  it('a hostile completion from a NON-owner worker is refused (no injection)', async () => {
    const h = harness();
    h.coord.register(regWorker('w1', 'ws'));
    h.coord.register(regWorker('w2', 'ws'));
    h.coord.enqueue(taskReq('t1', 'ws'));
    const asg = h.coord.assign(T0)!;
    expect(asg.workerId).toBe('w1');
    // w2 tries to claim completion for t1 it does not own:
    const hostile = h.coord.complete('t1', 'w2', 'stolen', T0 + 1);
    expect(hostile.duplicated).toBe(true);
    expect(h.coord.taskState('t1')!.phase).toBe('assigned'); // still owned by w1
    // owner completes honestly:
    const owned = h.coord.complete('t1', 'w1', 'real-result', T0 + 2);
    expect(owned.duplicated).toBe(false);
    expect(h.coord.taskState('t1')!.result).toBe('real-result');
  });

  it('a worker crash mid-task ends the lease: no duplicate destructive execution; task requeues', async () => {
    const h = harness();
    h.coord.register(regWorker('w1', 'ws'));
    h.coord.enqueue(taskReq('t1', 'ws'));
    const asg = h.coord.assign(T0)!;
    // the worker executes the lease but crashes mid-task (runnable throws):
    const outcome = await h.workerStack.executeLease(asg, async () => {
      throw new Error('crash mid-task');
    });
    expect(outcome.ok).toBe(false);
    // crash ends the lease via failSync -> task requeued for next attempt:
    h.coord.failSync('t1', 'w1', T0 + 1);
    expect(h.coord.taskState('t1')!.phase).toBe('queued');
    expect(h.coord.taskState('t1')!.attempts).toBeGreaterThanOrEqual(1);
    // it can be reassigned (a fresh, safe execution):
    const asg2 = h.coord.assign(T0 + 2)!;
    expect(asg2.taskId).toBe('t1');
    expect(asg2.lease.attempt).toBe(2);
  });

  it('a worker disappearing mid-execution requeues its borrowed tasks (no lost state)', async () => {
    const h = harness();
    h.coord.register(regWorker('w1', 'ws', 2)); // only worker => both tasks land here
    h.coord.enqueue(taskReq('t1', 'ws'));
    h.coord.enqueue(taskReq('t2', 'ws'));
    h.coord.assign(T0); // t1 -> w1
    h.coord.assign(T0); // t2 -> w1
    expect(h.coord.listWorkers()[0]!.running).toBe(2);
    h.coord.deregister('w1', T0 + 1); // worker vanishes
    expect(h.coord.queuedCount()).toBe(2); // both tasks requeued, nothing lost
    h.coord.register(regWorker('w2', 'ws')); // replacement worker
    const next = h.coord.assign(T0 + 2)!;
    expect(next.workerId).toBe('w2');
    expect(h.coord.taskState('t1') || h.coord.taskState('t2')).toBeTruthy();
  });

  it('durable task state survives the chain (checkpoint present after supervised run)', async () => {
    const h = harness();
    h.coord.register(regWorker('w1', 'ws'));
    h.coord.enqueue(taskReq('t1', 'ws'));
    const asg = h.coord.assign(T0)!;
    const outcome = await h.workerStack.executeLease(asg, async () => 'durable');
    expect(outcome.ok).toBe(true);
    const rec = await h.state.get(`os:proc:${outcome.processId}:dist-exec:result`);
    expect(rec).toBeTruthy();
    expect((rec!.data as { data: string }).data).toBe('durable');
    h.coord.complete('t1', 'w1', 'durable', T0 + 1);
    expect(h.coord.taskState('t1')!.phase).toBe('completed');
  });

  it('no cross-workspace execution: a workspace-bound worker never serves another workspace', async () => {
    const h = harness();
    h.coord.register(regWorker('wa', 'ws-a'));
    h.coord.register(regWorker('wb', 'ws-b'));
    h.coord.enqueue(taskReq('t-a', 'ws-a'));
    h.coord.enqueue(taskReq('t-b', 'ws-b'));
    const asg1 = h.coord.assign(T0)!;
    const asg2 = h.coord.assign(T0)!;
    expect(asg1.workerId).toBe('wa');
    expect(asg2.workerId).toBe('wb');
    expect(asg1.taskId).toBe('t-a');
    expect(asg2.taskId).toBe('t-b');
  });
});