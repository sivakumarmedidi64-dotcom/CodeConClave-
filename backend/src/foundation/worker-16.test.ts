/**
 * CodeConClave — PHASE 16 worker hardening tests.
 * Graceful shutdown: stop() stops claiming immediately and drains in-flight
 * executions (bounded), so a restart never orphans RUNNING tasks mid-write;
 * anything that still cannot finish is honestly reclaimed by the watchdog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimNextTask = vi.hoisted(() => vi.fn());
vi.mock('../shared/queue.js', () => ({ claimNextTask, enqueueTask: async () => {}, queueProvider: () => 'memory' }));

const executeTask = vi.hoisted(() => vi.fn());
vi.mock('../modules/execution/orchestrator.js', () => ({ executeTask }));

const touchTask = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/execution/tasks.js', () => ({ touchTask }));

const registerCoreTools = vi.hoisted(() => vi.fn());
vi.mock('../modules/execution/tools.js', () => ({ registerCoreTools }));

import { startWorker, inFlightCount, _resetWorker } from '../workers/task-worker.js';

function task(id: string) {
  return { id, project_id: 'p1', owner_id: 'u1', title: 't', risk_level: 'LOW', execution_mode: 'CLOUD', created_at: new Date() };
}

/** Poll with real-ish time under fake timers (vi.waitFor is unreliable here). */
async function flushUntil(pred: () => boolean, maxTries = 40): Promise<void> {
  for (let i = 0; i < maxTries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWorker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker graceful shutdown', () => {
  it('drains in-flight executions before stop() resolves', async () => {
    let finished = false;
    executeTask.mockImplementation(() => new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 60)));
    claimNextTask.mockResolvedValue([task('tsk_1')]);
    const stop = startWorker();
    await vi.waitFor(() => expect(inFlightCount()).toBe(1));
    expect(finished).toBe(false);
    await stop();
    expect(finished).toBe(true);
    expect(inFlightCount()).toBe(0);
  });

  it('stops claiming new tasks while draining', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finishTask!: () => void;
    executeTask.mockImplementation(() => new Promise<void>((resolve) => { finishTask = resolve; }));
    claimNextTask.mockResolvedValue([task('tsk_1')]);
    const stop = startWorker();
    await flushUntil(() => inFlightCount() === 1);
    expect(inFlightCount()).toBe(1);
    const claimsSoFar = claimNextTask.mock.calls.length;
    const stopPromise = stop();
    await vi.advanceTimersByTimeAsync(11_000);
    await stopPromise;
    expect(claimNextTask.mock.calls.length).toBe(claimsSoFar);
    expect(inFlightCount()).toBe(1); // honest: the drain window was exceeded
    finishTask();
    await flushUntil(() => inFlightCount() === 0);
    expect(inFlightCount()).toBe(0);
  });

  it('reports remaining in-flight work when the drain window is exceeded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    executeTask.mockImplementation(() => new Promise<void>(() => undefined));
    claimNextTask.mockResolvedValue([task('tsk_1')]);
    const stop = startWorker();
    await flushUntil(() => inFlightCount() === 1);
    expect(inFlightCount()).toBe(1);
    const stopPromise = stop();
    await vi.advanceTimersByTimeAsync(11_000);
    await stopPromise;
    expect(inFlightCount()).toBe(1); // watchdog reclaims it — the worker never lies
  });
});