/**
 * CodeConClave — task worker (in-process or standalone: npm run worker).
 * Polls the queue, claims tasks atomically, executes them. Heartbeats are the
 * watchdog's signal; recovery is the watchdog's job. Phase 16: graceful
 * shutdown — stop() stops claiming and drains in-flight executions (bounded),
 * so a restart never orphans RUNNING tasks mid-write (the watchdog reclaims
 * anything that still cannot finish in time).
 */
import { logger } from '../shared/logger.js';
import { claimNextTask } from '../shared/queue.js';
import { executeTask } from '../modules/execution/orchestrator.js';
import { registerCoreTools } from '../modules/execution/tools.js';

const POLL_MS = 2_000;
const CONCURRENCY = 2;
const DRAIN_TIMEOUT_MS = 10_000;
let draining = false;
const inFlight = new Set<Promise<void>>();

async function pump(): Promise<void> {
  if (draining) return;
  try {
    const tasks = await claimNextTask('worker', CONCURRENCY);
    for (const task of tasks) {
      let run!: Promise<void>;
      run = (async () => {
        try {
          await executeTask(task as never);
        } catch (err) {
          // Message-only: raw error objects can carry provider internals.
          // No heartbeat touch here: recovery is the watchdog's job (stale
          // heartbeat or started_at timeout). Touching would keep a crashed
          // task artificially alive and delay its reclaim.
          logger.error('worker task execution threw', {
            taskId: task.id,
            err: err instanceof Error ? err.message : String(err),
          });
        } finally {
          inFlight.delete(run);
        }
      })();
      inFlight.add(run);
    }
  } catch (err) {
    logger.error('worker pump error', { err });
  }
}

export function startWorker(): () => Promise<void> {
  registerCoreTools();
  logger.info('task worker started', { pollMs: POLL_MS });
  let timer: NodeJS.Timeout | null = null;
  timer = setInterval(() => void pump(), POLL_MS);
  void pump();
  return async () => {
    if (timer) clearInterval(timer);
    draining = true;
    logger.info('task worker draining', { inFlight: inFlight.size });
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    if (inFlight.size > 0) {
      logger.warn('task worker drain timed out', { stillInFlight: inFlight.size });
    }
    logger.info('task worker stopped', { inFlight: inFlight.size });
  };
}

/** Test hook: number of executions currently in flight. */
export function inFlightCount(): number {
  return inFlight.size;
}

/** Test hook: reset module state between tests (module is a singleton). */
export function _resetWorker(): void {
  draining = false;
  inFlight.clear();
}