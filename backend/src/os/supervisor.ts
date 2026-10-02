/**
 * CodeConClave AI OS â€” Supervisor / process lifecycle (P0.1).
 *
 * One canonical lifecycle for queued â†’ starting â†’ running â†’ (paused/cancelling)
 * â†’ completed/failed/killed â†’ recovering. Consolidates the fragmented task/agent
 * lifecycle semantics into a single supervisor WITHOUT touching the existing
 * production paths: this is a new abstraction the OS adapters can wrap the
 * existing task/agent workers with. It provides crash detection, cooperative
 * cancellation, graceful shutdown, restart policy, parent/child, and lifecycle
 * event logging.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import {
  Capability,
  OsProcess,
  OsProcessState,
  ResourceBudget,
  RestartPolicy,
} from './types.js';
import { CapabilitySet } from './capabilities.js';
import { StateStore } from './state.js';
import { ResourceGovernor } from './resource-governor.js';

export type LifecycleEvent =
  | { type: 'state'; processId: string; from: OsProcessState; to: OsProcessState }
  | { type: 'log'; processId: string; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'restart'; processId: string; attempt: number }
  | { type: 'crash'; processId: string; errorCode: string | null }
  | { type: 'recovered'; processId: string; afterMs: number }
  | { type: 'shutdown'; processId: string; escalation: 'cooperative' | 'force' };

export interface SuperviseContext {
  /** Cooperative cancellation: a runnable body should check this. */
  isCancelled(): boolean;
  /** Pause flag the runnable body can observe (suspend/resume). */
  isPaused(): boolean;
  /** Persist a checkpoint via the state store. */
  checkpoint<T>(key: string, data: T): Promise<void>;
  /** Restore a checkpoint previously persisted under `key` (P1: resume-from-checkpoint). */
  loadCheckpoint<T>(key: string): Promise<T | null>;
  /** Abort the process (throws a cancellation error inside the body). */
  cancel(): Promise<void>;
}

export interface SuperviseOptions<R> {
  id?: string;
  parentId?: string | null;
  name: string;
  capabilities: Capability[] | CapabilitySet;
  budget: ResourceBudget;
  restartPolicy?: RestartPolicy;
  /** Max total run attempts before giving up (default 5 preserves P0 cap). */
  maxRestarts?: number;
  /** Exponential backoff base (ms) between restarts (0 = immediate, P0 behavior). */
  backoffBaseMs?: number;
  /** The work to run. Receives a context for cooperative cancel/pause/checkpoint. */
  run: (ctx: SuperviseContext) => Promise<R>;
  state: StateStore;
  governor: ResourceGovernor;
  onEvent?: (ev: LifecycleEvent) => void;
  defaultRestartPolicy: RestartPolicy;
}

class SupervisedProcess {
  static readonly STATE_VERSION = 1;

  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly restartPolicy: RestartPolicy;
  state: OsProcessState = 'queued';
  attempts = 0;
  restarts = 0;
  pid: number | null = null;
  startedAt: number | null = null;
  finishedAt: number | null = null;
  errorCode: string | null = null;
  private cancelRequested = false;
  private pauseRequested = false;
  private releaseFn?: () => void;
  result: unknown = null;

  /** Whether a cooperative cancellation has been requested (P1 crash detection). */
  get wasCancelled(): boolean {
    return this.cancelRequested;
  }

  constructor(
    private opts: {
      capabilities: Capability[];
      budget: ResourceBudget;
      state: StateStore;
      governor: ResourceGovernor;
      onEvent?: (ev: LifecycleEvent) => void;
      run: (ctx: SuperviseContext) => Promise<unknown>;
      defaultRestartPolicy: RestartPolicy;
      maxRestarts: number;
      backoffBaseMs: number;
    },
    init?: { id?: string; parentId?: string | null; restartPolicy?: RestartPolicy; name: string },
  ) {
    this.id = init?.id ?? randomUUID();
    this.name = init?.name ?? 'process';
    this.parentId = init?.parentId ?? null;
    this.restartPolicy = init?.restartPolicy ?? opts.defaultRestartPolicy;
  }

  snapshot(withState = this.state): OsProcess {
    return {
      id: this.id,
      parentId: this.parentId,
      state: withState,
      restartPolicy: this.restartPolicy,
      capabilities: this.opts.capabilities,
      pid: this.pid,
      createdAt: this.startedAt ?? Date.now(),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      attempts: this.attempts,
      errorCode: this.errorCode,
      restarts: this.restarts,
    };
  }

  private emit(ev: LifecycleEvent): void {
    this.opts.onEvent?.(ev);
  }

  private async transition(to: OsProcessState): Promise<void> {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.emit({ type: 'state', processId: this.id, from, to });
    // persist lifecycle checkpoint (best-effort, never fatal)
    try {
      await this.opts.state.checkpoint(
        SupervisedProcess.STATE_VERSION,
        `os:proc:${this.id}`,
        this.snapshot(to),
      );
    } catch (err) {
      logger.warn('aios.supervisor.state_persist_failed', {
        processId: this.id,
        error: (err as Error).message,
      });
    }
  }

  ctx(): SuperviseContext {
    return {
      isCancelled: () => this.cancelRequested,
      isPaused: () => this.pauseRequested,
      checkpoint: async (key, data) => {
        await this.opts.state.checkpoint(
          SupervisedProcess.STATE_VERSION,
          `os:proc:${this.id}:${key}`,
          { parent: this.id, data },
        );
      },
      loadCheckpoint: async <T>(key: string) => {
        try {
          const rec = await this.opts.state.get<{ parent: string; data: T }>(
            `os:proc:${this.id}:${key}`,
          );
          return rec ? rec.data.data : null;
        } catch {
          return null;
        }
      },
      cancel: async () => {
        this.cancelRequested = true;
        await this.transition('cancelling');
      },
    };
  }

  async pause(): Promise<void> {
    if (this.state !== 'running' && this.state !== 'cancelling') {
      throw AppError.conflict('aios_proc_state', `cannot pause process in '${this.state}'`);
    }
    this.pauseRequested = true;
    await this.transition('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      throw AppError.conflict('aios_proc_state', `cannot resume process in '${this.state}'`);
    }
    this.pauseRequested = false;
    await this.transition('running');
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.state === 'queued' || this.state === 'starting') {
      this.finishedAt = Date.now();
      this.errorCode = 'cancelled';
      await this.transition('killed');
    } else if (this.state === 'running') {
      await this.transition('cancelling');
    }
  }

  async recover(): Promise<void> {
    await this.transition('recovering');
    await this.transition('queued');
  }

  private releaseSlot(): void {
    this.releaseFn?.();
    this.releaseFn = undefined;
  }

  async runOnce(): Promise<{ ok: boolean; errorCode: string | null }> {
    this.attempts += 1;
    const slot = await this.opts.governor.acquire();
    this.releaseFn = slot.release;
    this.startedAt = this.startedAt ?? Date.now();
    this.pid = null; // process.pid of a child is handled by sandbox; supervisor tracks lifecycle only
    try {
      await this.transition('starting');
      await this.transition('running');
      const runResult = await this.opts.run(this.ctx());
      this.result = runResult;
      // best-effort durability of the result (never fatal if not JSON-serializable)
      try {
        await this.opts.state.checkpoint(SupervisedProcess.STATE_VERSION, `os:proc:${this.id}:result`, {
          parent: this.id,
          data: runResult,
        });
      } catch {
        /* non-serializable result — keep in-memory only */
      }
      this.finishedAt = Date.now();
      await this.transition('completed');
      return { ok: true, errorCode: null };
    } catch (err) {
      this.finishedAt = Date.now();
      const code = err instanceof AppError ? err.errorCode : 'aios_proc_failed';
      if (this.cancelRequested) {
        this.errorCode = 'cancelled';
        await this.transition('killed');
        return { ok: false, errorCode: 'cancelled' };
      }
      this.errorCode = code;
      await this.transition('failed');
      return { ok: false, errorCode: code };
    } finally {
      this.releaseSlot();
    }
  }

  /** Apply restart policy: return true if a retry should be scheduled. */
  shouldRestart(result: { ok: boolean }): boolean {
    if (result.ok) return false;
    if (this.restartPolicy === 'always') return true;
    if (this.restartPolicy === 'on_failure' && this.errorCode !== 'cancelled') return true;
    return false;
  }
}

/** (internal) return marker for the public supervise() â€” resolved outcome. */
export interface SuperviseOutcome<R> {
  process: OsProcess;
  result: R | null;
  ok: boolean;
  errorCode: string | null;
  restarts: number;
}

export class Supervisor {
  constructor(
    private state: StateStore,
    private governor: ResourceGovernor,
    private defaultRestartPolicy: RestartPolicy,
    private onEvent?: (ev: LifecycleEvent) => void,
  ) {}

  /**
   * Run a supervised process to completion applying the restart policy.
   * Cooperative cancellation: the runnable must check ctx.isCancelled().
   */
  async supervised<R>(
    opts: Omit<SuperviseOptions<R>, 'state' | 'governor' | 'defaultRestartPolicy'>,
  ): Promise<SuperviseOutcome<R>> {
    const caps = opts.capabilities instanceof CapabilitySet ? opts.capabilities.list() : opts.capabilities;
    const proc = new SupervisedProcess(
      {
        capabilities: caps,
        budget: opts.budget,
        state: this.state,
        governor: this.governor,
        onEvent: opts.onEvent ?? this.onEvent,
        run: opts.run as (ctx: SuperviseContext) => Promise<unknown>,
        defaultRestartPolicy: this.defaultRestartPolicy,
        maxRestarts: opts.maxRestarts ?? 5,
        backoffBaseMs: opts.backoffBaseMs ?? 0,
      },
      { id: opts.id, parentId: opts.parentId, restartPolicy: opts.restartPolicy, name: opts.name },
    );

    let result: R | null = null;
    let ok = false;
    let errorCode: string | null = null;
    let attempts = 0;
    const maxRestarts = opts.maxRestarts ?? 5;
    const backoffBaseMs = opts.backoffBaseMs ?? 0;

    for (;;) {
      attempts += 1;
      const outcome = await proc.runOnce();
      if (outcome.ok) {
        result = proc.result as R;
        ok = true;
        break;
      }
      errorCode = outcome.errorCode;
      this.emit({ type: 'log', processId: proc.id, message: `attempt ${attempts} failed (${errorCode})`, level: 'warn' });
      if (!proc.shouldRestart(outcome)) break;
      // crash detection (P1): an unplanned failure is a crash, distinct from a
      // cooperative cancel.
      if (!proc.wasCancelled) {
        this.emit({ type: 'crash', processId: proc.id, errorCode });
      }
      if (attempts >= maxRestarts) break; // safety: bounded total attempts (default preserves P0 cap of 5)
      proc.restarts += 1;
      this.emit({ type: 'restart', processId: proc.id, attempt: attempts });
      this.emit({ type: 'state', processId: proc.id, from: 'recovering', to: 'queued' });
      if (backoffBaseMs > 0) {
        const delayMs = backoffBaseMs * Math.pow(2, Math.min(proc.restarts - 1, 6));
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
      await proc.recover();
      this.emit({ type: 'recovered', processId: proc.id, afterMs: 0 });
    }

    return {
      process: proc.snapshot(),
      result,
      ok,
      errorCode,
      restarts: proc.restarts,
    };
  }

  /** Convenience: create a standalone process handle for manual supervision. */
  create<R>(opts: Omit<SuperviseOptions<R>, 'state' | 'governor' | 'defaultRestartPolicy'>): {
    run(): Promise<{ ok: boolean; errorCode: string | null }>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    cancel(): Promise<void>;
    recover(): Promise<void>;
    snapshot(): OsProcess;
  } {
    const caps = opts.capabilities instanceof CapabilitySet ? opts.capabilities.list() : opts.capabilities;
    const proc = new SupervisedProcess(
      {
        capabilities: caps,
        budget: opts.budget,
        state: this.state,
        governor: this.governor,
        onEvent: opts.onEvent ?? this.onEvent,
        run: opts.run as (ctx: SuperviseContext) => Promise<unknown>,
        defaultRestartPolicy: this.defaultRestartPolicy,
        maxRestarts: opts.maxRestarts ?? 5,
        backoffBaseMs: opts.backoffBaseMs ?? 0,
      },
      { id: opts.id, parentId: opts.parentId, restartPolicy: opts.restartPolicy, name: opts.name },
    );
    return {
      run: () => proc.runOnce(),
      pause: () => proc.pause(),
      resume: () => proc.resume(),
      cancel: () => proc.cancel(),
      recover: () => proc.recover(),
      snapshot: () => proc.snapshot(),
    };
  }

  private emit(ev: LifecycleEvent): void {
    this.onEvent?.(ev);
  }
}


