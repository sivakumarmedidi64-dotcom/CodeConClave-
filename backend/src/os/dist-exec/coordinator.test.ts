/**
 * CodeConClave — distributed execution preparation tests (coordinator logic).
 * Architecture-only: worker registration, leases, heartbeats, task ownership,
 * label matching, resource availability, priority, dedupe/idempotency, failure
 * recovery and reassignment. Hermetic (fake clock, in-memory, no network, no
 * production wiring, no destructive actions).
 */
import { describe, it, expect } from 'vitest';
import { ExecutionCoordinator } from './coordinator.js';
import { EventBus } from '../event-bus.js';

const T0 = 1_000_000;
const worker = (id: string, labels: string[], maxC = 1) => ({
  id,
  labels,
  maxConcurrent: maxC,
  resource: { concurrency: maxC },
  lastHeartbeatAt: T0,
  registeredAt: T0,
});

describe('worker registration + heartbeats', () => {
  it('registers and lists workers', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('w-a', ['linux-amd64']), T0);
    expect(c.listWorkers()).toHaveLength(1);
    expect(c.listWorkers()[0]!.id).toBe('w-a');
  });

  it('rejects duplicate worker ids', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('w-a', []), T0);
    expect(() => c.register(worker('w-a', []), T0)).toThrow();
  });

  it('tracks heartbeats and stale workers', () => {
    const c = new ExecutionCoordinator({ heartbeatTimeoutMs: 1000 });
    c.register(worker('w-a', []), T0);
    expect(c.heartbeat('w-a', T0).ok).toBe(true);
    c.tick(T0 + 1500);
    expect(c.listWorkers()).toHaveLength(0); // dead worker reaped
  });
});

describe('task ownership, leases, priority', () => {
  it('assigns the highest-priority task to a label-matching worker', () => {
    const c = new ExecutionCoordinator({ leaseTtlMs: 1000 });
    c.register({ ...worker('w-a', ['docker_executor'], 2), capabilities: ['terminal.exec'] }, T0);
    c.enqueue({ taskId: 't-low', workspaceId: 'ws', priority: 1, requiredLabels: ['docker_executor'], capabilities: ['terminal.exec'], runnableKind: 'x' }, T0);
    c.enqueue({ taskId: 't-high', workspaceId: 'ws', priority: 9, requiredLabels: ['docker_executor'], capabilities: ['terminal.exec'], runnableKind: 'x' }, T0);
    const a = c.assign(T0);
    expect(a?.taskId).toBe('t-high');
    expect(a?.workerId).toBe('w-a');
    expect(a?.lease.attempt).toBe(1);
  });

  it('will not assign a task to a worker without the labels (label match gate)', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('w-a', ['linux-amd64']), T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 5, requiredLabels: ['windows-amd64'], capabilities: [], runnableKind: 'x' }, T0);
    expect(c.assign(T0)).toBeNull();
  });

  it('respects worker concurrency (resource availability)', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('w-a', [], 1), T0);
    c.enqueue({ taskId: 't1', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    c.enqueue({ taskId: 't2', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    expect(c.assign(T0)?.taskId).toBe('t1');
    expect(c.assign(T0)).toBeNull(); // no capacity
  });
});

describe('dedupe + idempotency', () => {
  it('enqueue is idempotent by taskId', () => {
    const c = new ExecutionCoordinator();
    const req = { taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' };
    expect(c.enqueue(req, T0).duplicated).toBe(false);
    expect(c.enqueue(req, T0).duplicated).toBe(true);
    expect(c.queuedCount()).toBe(1);
  });

  it('complete is idempotent with the same key', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('w-a', []), T0);
    const req = { taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' };
    c.enqueue(req, T0);
    const a = c.assign(T0)!;
    expect(c.complete('t', a.workerId, 'k1', T0 + 10).duplicated).toBe(false);
    expect(c.complete('t', a.workerId, 'k1', T0 + 20).duplicated).toBe(true);
    expect(c.taskState('t')?.phase).toBe('completed');
  });

  it('refuses a conflicting completion key (idempotency conflict)', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('w-a', []), T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    const a = c.assign(T0)!;
    c.complete('t', a.workerId, 'k1', T0);
    expect(c.complete('t', a.workerId, 'k2', T0).duplicated).toBe(true);
  });
});

describe('failure recovery + reassignment', () => {
  it('reassigns an expired lease (bounded attempts), then fails', () => {
    const c = new ExecutionCoordinator({ leaseTtlMs: 100, maxAttempts: 2 });
    c.register(worker('w-a', []), T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    c.assign(T0);
    // attempt 1 expires; tick requeues
    c.tick(T0 + 200);
    expect(c.taskState('t')?.phase).toBe('queued');
    // attempt 2 granted, expires again -> failed after maxAttempts
    c.assign(T0 + 200);
    c.tick(T0 + 400);
    expect(c.taskState('t')?.phase).toBe('failed');
    // lease bequeathed correctly
    expect(c.taskState('t')?.attempts).toBe(2);
  });

  it('reclaims leases of a worker whose heartbeat died', () => {
    const c = new ExecutionCoordinator({ heartbeatTimeoutMs: 500, maxAttempts: 1 });
    c.register(worker('w-a', []), T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    c.assign(T0);
    c.tick(T0 + 1000); // heartbeat stale + lease expired
    expect(c.taskState('t')?.phase).toBe('failed'); // maxAttempts=1
    expect(c.listWorkers()).toHaveLength(0);
  });

  it('renewLease extends ownership only for the owning worker', () => {
    const c = new ExecutionCoordinator({ leaseTtlMs: 100 });
    c.register(worker('w-a', []), T0);
    c.register(worker('w-b', [], 0 === 0 ? 1 : 0), T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    const a = c.assign(T0)!;
    expect(c.renewLease('t', 'w-b', T0 + 5).ok).toBe(false); // non-owner fails
    expect(c.renewLease('t', a.workerId, T0 + 5).ok).toBe(true);
  });

  it('emits coordination events on the existing event bus (reuse, not a second bus)', () => {
    const bus = new EventBus();
    const c = new ExecutionCoordinator({ eventBus: bus });
    c.register(worker('w-a', []), T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 1, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    c.assign(T0);
    const topics = bus.recent('aios.distexec');
    expect(topics.length).toBeGreaterThanOrEqual(2);
    expect(topics.some((e) => e.payload.type === 'worker_registered')).toBe(true);
    expect(topics.some((e) => e.payload.type === 'lease_granted')).toBe(true);
  });
});

describe('workspace isolation binding', () => {
  const bound = (id: string, workspaceId: string) => ({
    ...worker(id, [], 2),
    workspaceId,
  });

  it('bounds a workspace worker to its own workspace only', () => {
    const c = new ExecutionCoordinator({ requireWorkspaceBinding: true });
    c.register(bound('w1', 'ws-a'), T0);
    c.register(bound('w2', 'ws-b'), T0);
    c.enqueue({ taskId: 'ta', workspaceId: 'ws-a', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    const a = c.assign(T0)!;
    expect(a.workerId).toBe('w1'); // ws-a task never goes to w2
    c.enqueue({ taskId: 'tb', workspaceId: 'ws-b', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    const b = c.assign(T0)!;
    expect(b.workerId).toBe('w2');
  });

  it('never enqueues a workspace task to a worker bound to another workspace', () => {
    const c = new ExecutionCoordinator({ requireWorkspaceBinding: true });
    c.register(bound('w1', 'ws-a'), T0);
    c.enqueue({ taskId: 'ta', workspaceId: 'ws-b', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    expect(c.assign(T0)).toBeNull();
  });

  it('strict mode serves only system tasks to unbound workers', () => {
    const c = new ExecutionCoordinator({ requireWorkspaceBinding: true });
    c.register(worker('u', []), T0);
    c.enqueue({ taskId: 'ta', workspaceId: 'ws-a', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    expect(c.assign(T0)).toBeNull();
    c.enqueue({ taskId: 'sys', workspaceId: '', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    expect(c.assign(T0)?.workerId).toBe('u');
  });
});

describe('capability + resource-aware scheduling', () => {
  it('a worker must hold every required capability of the task', () => {
    const c = new ExecutionCoordinator();
    c.register({ ...worker('w-a', ['docker_executor'], 1), capabilities: ['terminal.exec', 'sandbox.container'] }, T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 5, requiredLabels: ['docker_executor'], capabilities: ['terminal.exec', 'sandbox.container'], runnableKind: 'x' }, T0);
    expect(c.assign(T0)?.workerId).toBe('w-a');
  });

  it('denies a task that needs a capability the worker lacks', () => {
    const c = new ExecutionCoordinator();
    c.register({ ...worker('w-a', ['docker_executor'], 1), capabilities: ['files.write'] }, T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 5, requiredLabels: ['docker_executor'], capabilities: ['terminal.exec'], runnableKind: 'x' }, T0);
    expect(c.assign(T0)).toBeNull();
  });

  it('skips workers that cannot meet the task resource floor', () => {
    const c = new ExecutionCoordinator();
    c.register({ ...worker('small', ['x'], 1), resource: { memoryBytes: 64 * 1024, cpu: 1, concurrency: 1 } }, T0);
    c.register({ ...worker('big', ['x'], 1), resource: { memoryBytes: 1024 * 1024, cpu: 2, concurrency: 1 } }, T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 5, requiredLabels: ['x'], capabilities: [], requires: { memoryBytes: 512 * 1024, cpu: 2 }, runnableKind: 'x' }, T0);
    const a = c.assign(T0)!;
    expect(a.workerId).toBe('big');
  });

  it('prefers the least-loaded matching worker', () => {
    const c = new ExecutionCoordinator();
    c.register(worker('busy', ['x'], 2), T0);
    c.register(worker('free', ['x'], 2), T0 + 1);
    c.enqueue({ taskId: 'a', workspaceId: 'ws', priority: 5, requiredLabels: ['x'], capabilities: [], runnableKind: 'x' }, T0);
    c.assign(T0); // deterministic by registeredAt -> lands on 'busy'
    c.enqueue({ taskId: 'b', workspaceId: 'ws', priority: 5, requiredLabels: ['x'], capabilities: [], runnableKind: 'x' }, T0);
    const second = c.assign(T0)!;
    const first = c.taskState('a')!.lease!.workerId;
    expect(second.workerId).not.toBe(first);
  });
});

describe('lease races + orphaning', () => {
  it('only one worker can own a task lease at a time (no double ownership)', () => {
    const c = new ExecutionCoordinator({ leaseTtlMs: 1000 });
    c.register({ ...worker('w-a', [], 2), workspaceId: 'ws' }, T0);
    c.register({ ...worker('w-b', [], 2), workspaceId: 'ws' }, T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    const a = c.assign(T0)!;
    // another assign for the same task must not hand it out again
    expect(c.assign(T0)).toBeNull();
    expect(c.renewLease('t', 'w-b', T0 + 10).ok).toBe(false);
    expect(c.renewLease('t', a.workerId, T0 + 10).ok).toBe(true);
    // concurrent duplicate completion is idempotent
    expect(c.complete('t', a.workerId, 'k', T0 + 20).duplicated).toBe(false);
    expect(c.complete('t', a.workerId, 'k', T0 + 30).duplicated).toBe(true);
  });

  it('does not orphan tasks when a worker deregisters mid-execution', () => {
    const c = new ExecutionCoordinator({ maxAttempts: 2 });
    c.register({ ...worker('w-a', [], 2), workspaceId: 'ws' }, T0);
    c.enqueue({ taskId: 't', workspaceId: 'ws', priority: 5, requiredLabels: [], capabilities: [], runnableKind: 'x' }, T0);
    c.assign(T0);
    c.deregister('w-a', T0 + 5);
    expect(c.taskState('t')?.phase).toBe('queued'); // requeued, not lost
    c.register({ ...worker('w-b', [], 2), workspaceId: 'ws' }, T0 + 5);
    expect(c.assign(T0 + 5)?.workerId).toBe('w-b');
  });
});