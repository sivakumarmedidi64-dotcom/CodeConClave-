/**
 * CodeConclave AI OS — SupervisedWorkerExecutor (Phase E supervisor binding).
 *
 * THE missing link: binds a TaskAssignment (lease) to the EXISTING Supervisor,
 * executing the task through the canonical lifecycle (queued → starting →
 * running → completed/failed/killed) and producing a RESULT. No second
 * scheduler, no second queue, no second event bus, no second state system:
 * this module reuses Supervisor + ResourceGovernor + StateStore as the
 * directive requires.
 *
 * SECURITY CHAIN (unchanged):
 *   AUTH → CAPABILITY → STOP RULES → RESOURCE GOVERNOR → REAL ISOLATION → AUDIT
 *
 * This module sits between RESOURCE GOVERNOR and REAL ISOLATION: it routes the
 * leased task to the Supervisor, which enforces resource bounds (concurrency
 * slots, runtime deadline) and produces a durable result.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import type { TaskAssignment, Lease } from './types.js';
import type { Supervisor, SuperviseOutcome } from '../supervisor.js';
import type { ResourceGovernor } from '../resource-governor.js';
import type { StateStore } from '../state.js';
import type { EventBus } from '../event-bus.js';
import type { Capability, ResourceBudget } from '../types.js';

/** Runtime body a worker-supervisor actually executes for a single lease. */
export type TaskRunnable = (lease: Lease) => Promise<string>;

export interface SupervisedWorkerExecutorOptions {
  supervisor: Supervisor;
  governor: ResourceGovernor;
  state: StateStore;
  eventBus?: Pick<EventBus, 'publish'>;
  /** Default resource budget for leased tasks (overridable per-run). */
  defaultBudget: ResourceBudget;
  /** Default capability set for worker-executed tasks (overridable per-run). */
  defaultCapabilities: Capability[];
}

export interface SupervisedWorkerOutcome {
  ok: boolean;
  result: string | null;
  errorCode: string | null;
  processId: string;
  restarts: number;
  lease: Lease;
}

/**
 * Binds a lease to the existing Supervisor and produces a RESULT.
 *
 * One instance per worker. Each call to `executeLease` is a single supervised
 * run through the canonical Supervisor lifecycle — crash-aware, restart-policy-
 * governed, resource-governed, and durably checkpointed.
 */
export class SupervisedWorkerExecutor {
  private readonly supervisor: Supervisor;
  private readonly governor: ResourceGovernor;
  private readonly state: StateStore;
  private readonly eventBus?: Pick<EventBus, 'publish'>;
  private readonly defaultBudget: ResourceBudget;
  private readonly defaultCapabilities: Capability[];

  constructor(opts: SupervisedWorkerExecutorOptions) {
    this.supervisor = opts.supervisor;
    this.governor = opts.governor;
    this.state = opts.state;
    this.eventBus = opts.eventBus;
    this.defaultBudget = opts.defaultBudget;
    this.defaultCapabilities = opts.defaultCapabilities;
  }

  /**
   * Execute a single leased task through the Supervisor, producing a result.
   *
   * The Supervisor enforces:
   * - Resource governor slot acquisition (fail-closed when at ceiling)
   * - Runtime deadline enforcement (wall-clock)
   * - Cooperative cancellation
   * - Crash detection + restart policy
   * - Durable state checkpoints via StateStore
   *
   * @param assignment  The coordinator's lease assignment for this task.
   * @param runnable    The body to execute. Receives the lease for correlation.
   * @param overrides   Optional per-task budget and capability overrides.
   */
  async executeLease(
    assignment: TaskAssignment,
    runnable: TaskRunnable,
    overrides?: { budget?: ResourceBudget; capabilities?: Capability[] },
  ): Promise<SupervisedWorkerOutcome> {
    const { lease } = assignment;
    const budget = overrides?.budget ?? this.defaultBudget;
    const capabilities = overrides?.capabilities ?? this.defaultCapabilities;

    this.emit('aios.worker.execute_start', {
      taskId: lease.taskId,
      workerId: lease.workerId,
      attempt: lease.attempt,
    });

    let outcome: SuperviseOutcome<string>;
    try {
      outcome = await this.supervisor.supervised<string>({
        id: `worker_${lease.workerId}_${lease.taskId}_${lease.attempt}`,
        name: `dist-exec:${lease.taskId}`,
        capabilities,
        budget,
        maxRestarts: 0, // lease-bound tasks do NOT restart; the COORDINATOR owns retry policy
        run: async (ctx) => {
          // Cooperative cancellation checks: if the lease expired while we
          // were queued, abort immediately rather than starting work.
          if (ctx.isCancelled()) throw AppError.conflict('aios_task_cancelled', 'task was cancelled before execution started');
          const result = await runnable(lease);
          // Checkpoint the result durably (the Supervisor also does this, but
          // we do it eagerly so the coordinator can pick it up immediately).
          await ctx.checkpoint('dist-exec:result', result);
          return result;
        },
        onEvent: (ev) => {
          try {
            this.eventBus?.publish('aios.worker.lifecycle', { ...ev, taskId: lease.taskId });
          } catch { /* lifecycle events must never break execution */ }
        },
      });
    } catch (err) {
      const errorCode = err instanceof AppError ? err.errorCode : 'aios_worker_execute_error';
      this.emit('aios.worker.execute_error', {
        taskId: lease.taskId,
        workerId: lease.workerId,
        attempt: lease.attempt,
        error: errorCode,
      });
      return {
        ok: false,
        result: null,
        errorCode,
        processId: '',
        restarts: 0,
        lease,
      };
    }

    this.emit('aios.worker.execute_done', {
      taskId: lease.taskId,
      workerId: lease.workerId,
      attempt: lease.attempt,
      ok: outcome.ok,
      errorCode: outcome.errorCode,
    });

    return {
      ok: outcome.ok,
      result: outcome.result ?? null,
      errorCode: outcome.errorCode,
      processId: outcome.process.id,
      restarts: outcome.restarts,
      lease,
    };
  }

  private emit(channel: string, data: Record<string, unknown>): void {
    logger.debug(channel, data);
    try {
      this.eventBus?.publish(channel, data);
    } catch { /* events must never break execution */ }
  }
}
