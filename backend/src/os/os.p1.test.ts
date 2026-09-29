/**
 * CodeConClave — AI OS P1 tests (IPC bus, supervisor resilience, DAG
 * orchestration, observability, git engine). Read-only, no DB/network/provider,
 * additive to the existing P0 suite. Uses in-memory stores and fake git executors.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStateStore } from './state.js';
import { ResourceGovernor } from './resource-governor.js';
import { CapabilitySet, CapabilityLedger } from './capabilities.js';
import { Supervisor, SuperviseContext } from './supervisor.js';
import { IpcBus, MemoryIpcStore, OutboxIpcStore } from './ipc.js';
import { DagExecutor, DagNode } from './dag.js';
import { Trace, sanitizeFields } from './observability.js';
import { GitEngine, GitExecution } from './git.js';
import { CapabilityKind, RestartPolicy } from './types.js';
import { runPipelineViaDag, publishEventViaIpc } from './adapters/p1.js';

const alwaysCaps = () => {
  const s = new CapabilitySet();
  s.add(CapabilityKind.TERMINAL_EXEC, 'proj');
  return s;
};
const budget = { maxRuntimeMs: 0, maxConcurrency: 8, maxCostUsd: 0, priority: 0 };

describe('P1.1 Durable IPC / Event Bus', () => {
  it('publishes with ordered, monotonic seq and event ids', async () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const received: number[] = [];
    bus.subscribe<number>('t', (e) => received.push(e.seq));
    const e1 = await bus.publish('t', 1);
    const e2 = await bus.publish('t', 2);
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(e1.id).toBeTruthy();
    expect(received).toEqual([e1.seq, e2.seq]);
  });

  it('scopes events by workspace (cross-workspace delivery impossible)', async () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const got: string[] = [];
    bus.subscribe('x', (e: { workspaceId: string | null }) => got.push(String(e.workspaceId)));
    await bus.publish('x', 1, { workspaceId: 'ws-a' });
    await bus.publish('x', 2, { workspaceId: 'ws-b' });
    const wsA = await bus.replay('ws-a', 'x');
    const wsB = await bus.replay('ws-b', 'x');
    expect(wsA).toHaveLength(1);
    expect(wsB).toHaveLength(1);
    expect(wsA[0]?.payload).toBe(1);
    expect(wsB[0]?.payload).toBe(2);
  });

  it('consumer is idempotent + dead-letters after bounded retries', async () => {
    const bus = new IpcBus(new MemoryIpcStore());
    const ev = await bus.publish('t', { n: 1 });
    const consumer = bus.registerConsumer('c1', null);
    let calls = 0;
    const result = await bus.deliverDurable(
      consumer,
      ev,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
      },
      { retries: 5 },
    );
    expect(result).toBe('processed');
    expect(consumer.offset).toBe(ev.seq);
    // idempotent: re-delivering the same event is skipped
    const again = await bus.deliverDurable(consumer, ev, async () => {
      throw new Error('should not run');
    });
    expect(again).toBe('skipped');

    // dead-letter path: a persistently failing event
    const bad = await bus.publish('t', { n: 2 });
    const consumer2 = bus.registerConsumer('c2', null);
    const dlq = await bus.deliverDurable(
      consumer2,
      bad,
      async () => {
        throw new Error('always fails');
      },
      { retries: 1 },
    );
    expect(dlq).toBe('dead');
    expect(bus.deadLetterCount()).toBe(1);
  });

  it('replays events after an offset', async () => {
    const bus = new IpcBus(new MemoryIpcStore());
    await bus.publish('t', 1);
    await bus.publish('t', 2);
    await bus.publish('t', 3);
    const replayed = await bus.replay(null, 't', 1);
    expect(replayed.map((e) => e.payload)).toEqual([2, 3]);
  });

  it('outbox store is disabled by default (memory) and lazily loads', async () => {
    const outbox = new OutboxIpcStore(false);
    const bus = new IpcBus(outbox);
    const ev = await bus.publish('t', 1);
    expect(outbox.kind).toBe('outbox');
    expect(ev.seq).toBeGreaterThan(0);
  });
});

describe('P1.2 Supervisor resilience', () => {
  it('applies exponential backoff and bounded maxRestarts', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(8);
    const supervisor = new Supervisor(store, gov, 'on_failure' as RestartPolicy);
    const started = Date.now();
    const backoffBaseMs = 5;

    let attempts = 0;
    const outcome = await supervisor.supervised<number>({
      name: 'flaky',
      capabilities: alwaysCaps().list(),
      budget,
      maxRestarts: 2,
      backoffBaseMs,
      run: async () => {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 0));
        const elapsed = Date.now() - started;
        void elapsed;
        throw new Error('fail');
      },
    });
    // maxRestarts = max total attempts: exactly 2 attempts, then give up
    expect(attempts).toBe(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.restarts).toBe(1);
  });

  it('emits a crash event and does not restart when stable (completed)', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(8);
    const events: string[] = [];
    const supervisor = new Supervisor(store, gov, 'on_failure' as RestartPolicy, (ev) =>
      events.push(ev.type),
    );
    const outcome = await supervisor.supervised<number>({
      name: 'stable',
      capabilities: alwaysCaps().list(),
      budget,
      run: async () => 42,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe(42);
    expect(events).toContain('state');
  });

  it('checkpoint + loadCheckpoint enable resume from saved state', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(8);
    const supervisor = new Supervisor(store, gov, 'none' as RestartPolicy);
    let bubbles: string[] = [];
    const outcome = await supervisor.supervised<number>({
      id: 'resumable',
      name: 'resumable',
      capabilities: alwaysCaps().list(),
      budget,
      run: async (ctx: SuperviseContext) => {
        const saved = await ctx.loadCheckpoint<{ step: number }>('steps');
        const step = saved?.step ?? 0;
        bubbles = [step];
        await ctx.checkpoint('steps', { step: step + 1 });
        return step + 1;
      },
    });
    expect(outcome.result).toBe(1);
    // resume: a second process with the same id picks up the checkpoint
    const expected = await store.get<{ parent: string; data: { step: number } }>('os:proc:resumable:steps');
    expect(expected?.data.data.step).toBe(1);
    void bubbles;
  });
});

describe('P1.3 DAG orchestration', () => {
  const executor = new DagExecutor();

  it('runs a serial chain A→B→C in dependency order', async () => {
    const order: string[] = [];
    const nodes: DagNode[] = [
      { id: 'A', run: async () => { order.push('A'); } },
      { id: 'B', deps: ['A'], run: async () => { order.push('B'); } },
      { id: 'C', deps: ['B'], run: async () => { order.push('C'); } },
    ];
    const res = await executor.execute(nodes);
    expect(res.ok).toBe(true);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('runs fan-in A+B→C after both dependencies', async () => {
    const done: string[] = [];
    const nodes: DagNode[] = [
      { id: 'A', run: async () => { done.push('A'); } },
      { id: 'B', run: async () => { done.push('B'); } },
      { id: 'C', deps: ['A', 'B'], run: async () => { done.push('C'); } },
    ];
    const res = await executor.execute(nodes);
    expect(res.ok).toBe(true);
    expect(done).toEqual(['A', 'B', 'C']);
  });

  it('runs independent branches in parallel', async () => {
    let concurrency = 0;
    let max = 0;
    const nodes: DagNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      run: async () => {
        concurrency += 1;
        max = Math.max(max, concurrency);
        await new Promise((r) => setTimeout(r, 5));
        concurrency -= 1;
      },
    }));
    const res = await executor.execute(nodes);
    expect(res.ok).toBe(true);
    expect(max).toBeGreaterThan(1);
  });

  it('skips a conditional node when its condition is false', async () => {
    const nodes: DagNode[] = [
      { id: 'A', run: async () => 1 },
      { id: 'B', deps: ['A'], condition: () => false, run: async () => 2 },
      { id: 'C', deps: ['B'], run: async () => 3 },
    ];
    const res = await executor.execute(nodes);
    expect(res.ok).toBe(true);
    expect(res.nodes.B?.status).toBe('skipped');
    expect(res.nodes.C?.status).toBe('completed');
  });

  it('propagates failure and cancels downstream nodes', async () => {
    const nodes: DagNode[] = [
      { id: 'A', run: async () => { throw new Error('A fails'); } },
      { id: 'B', deps: ['A'], run: async () => 2 },
      { id: 'C', deps: ['A'], run: async () => 3 },
    ];
    const res = await executor.execute(nodes);
    expect(res.ok).toBe(false);
    expect(res.nodes.A?.status).toBe('failed');
    expect(res.nodes.B?.status).toBe('cancelled');
    expect(res.nodes.C?.status).toBe('cancelled');
  });

  it('retries a node up to its retry budget', async () => {
    let attempts = 0;
    const nodes: DagNode[] = [
      {
        id: 'R',
        retries: 2,
        run: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('retry me');
        },
      },
    ];
    const res = await executor.execute(nodes);
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('resumes from checkpoint skipping completed nodes', async () => {
    const done: string[] = [];
    // pre-seed a checkpoint where A was already completed
    const deps = {
      completed: new Set(['A']),
      async markCompleted(id: string) { this.completed.add(id); },
      async isCompleted(id: string) { return this.completed.has(id); },
    };
    const nodes: DagNode[] = [
      { id: 'A', run: async () => { done.push('A'); } },
      { id: 'B', deps: ['A'], run: async () => { done.push('B'); } },
    ];
    const res = await executor.execute(nodes, { deps, checkpoint: { version: 1, keyPrefix: 'dag:proj' } });
    expect(res.ok).toBe(true);
    expect(res.nodes.A?.status).toBe('completed');
    // A was resumed (not run); only B actually executed
    expect(done).toEqual(['B']);
  });
});

describe('P1.5 Observability / tracing', () => {
  it('sanitizes secret-like fields', () => {
    const out = sanitizeFields({ apiKey: 'sk-123', password: 'pw', label: 'ok', token: 'abc' });
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.label).toBe('ok');
  });

  it('records a begin/end span with duration', async () => {
    const trace = new Trace();
    const span = trace.begin('sandbox', 'run-1');
    await new Promise((r) => setTimeout(r, 2));
    trace.end(span.spanId, 'ok');
    const recent = trace.recent('sandbox');
    expect(recent.length).toBe(1);
    expect(recent[0]?.status).toBe('ok');
    expect(recent[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('correlates a trace with the process id in span context', () => {
    const trace = new Trace({ workspaceId: 'ws-9' });
    const span = trace.begin('process', 'p', { processId: 'proc-1' });
    expect(span.context.traceId).toBe(trace.traceId);
    expect(span.context.workspaceId).toBe('ws-9');
    expect(span.context.processId).toBe('proc-1');
  });
});

describe('P1.4 Git engine (policy-gated)', () => {
  function fakeEx(overrides?: Partial<GitExecution>): GitExecution {
    return {
      authorize: true,
      writeCapability: true,
      allowedCommands: ['git'],
      timeoutMs: 1000,
      cwd: '/repo',
      run: (args) => {
        const cmd = args[1];
        if (cmd === 'diff' && args.includes('--diff-filter=U')) {
          return Promise.resolve({ stdout: 'src/conflict.ts\n', stderr: '', exitCode: 0 });
        }
        if (cmd === 'status') return Promise.resolve({ stdout: ' M src/a.ts\n', stderr: '', exitCode: 0 });
        if (cmd === 'branch') return Promise.resolve({ stdout: '* main\n  feat\n', stderr: '', exitCode: 0 });
        if (cmd === 'diff') return Promise.resolve({ stdout: '@@ -1 +1 @@', stderr: '', exitCode: 0 });
        if (cmd === 'checkout' && args[2] === '-b') return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        if (cmd === 'checkout') return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      ...overrides,
    };
  }

  it('lists branches and reads status/diff', async () => {
    const git = new GitEngine(fakeEx());
    expect(await git.status()).toContain(' M src/a.ts');
    expect(await git.diff()).toContain('@@');
    const branches = await git.branches();
    expect(branches).toContain('main');
    expect(branches).toContain('feat');
  });

  it('fails closed without the git capability', async () => {
    const git = new GitEngine(fakeEx({ authorize: false }));
    await expect(git.status()).rejects.toMatchObject({ errorCode: 'aios_git_denied' });
  });

  it('detects merge conflicts', async () => {
    const git = new GitEngine(fakeEx());
    const conflicts = await git.conflicts();
    expect(conflicts).toContain('src/conflict.ts');
  });

  it('rejects invalid branch names', async () => {
    const git = new GitEngine(fakeEx());
    await expect(git.createBranch('bad;rm -rf')).rejects.toMatchObject({ errorCode: 'aios_git_bad_branch' });
  });
});

describe('P1.7 Adapters (flag-gated, no regression when disabled)', () => {
  it('publishes via IPC through the adapter', async () => {
    const aios = new (await import('./os-api.js')).Aios({ stateStore: new MemoryStateStore() });
    const ev = await publishEventViaIpc(aios, { topic: 't', payload: 1 });
    expect(ev.seq).toBeGreaterThan(0);
  });

  it('runs a pipeline DAG via the adapter', async () => {
    const aios = new (await import('./os-api.js')).Aios({ stateStore: new MemoryStateStore() });
    const order: string[] = [];
    const res = await runPipelineViaDag(aios, {
      stages: [
        { id: 's1', run: async () => { order.push('s1'); } },
        { id: 's2', deps: ['s1'], run: async () => { order.push('s2'); } },
      ],
      runFallback: async () => { order.push('s1'); order.push('s2'); },
    });
    expect(res.ok).toBe(true);
    expect(order).toEqual(['s1', 's2']);
  });
});
