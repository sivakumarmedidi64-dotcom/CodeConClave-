/**
 * CodeConClave AI OS — Execution Coordinator (distributed execution PREP).
 *
 * Orchestration layer for the future worker model. PREPARATION ONLY: nothing
 * here is wired to production execution. It defines the worker registry,
 * leases, heartbeats, task ownership, label matching, resource availability,
 * failure recovery/reassignment, deduplication, idempotency, and priority
 * ordering — and it hands the actual running to the EXISTING Supervisor (the
 * winning worker later binds the task's lease to a Supervisor process; this
 * file does not implement that binding yet). No second scheduler, no second
 * queue, no second event bus (events ride the existing EventBus), no second
 * state system.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import type { EventBus } from '../event-bus.js';
import {
  CoordinatorEvent,
  CoordinatorEventType,
  Lease,
  TaskAssignment,
  TaskExecutionRequest,
  TaskId,
  WorkerId,
  WorkerRegistration,
} from './types.js';

export interface CoordinatorOptions {
  leaseTtlMs?: number;
  heartbeatTimeoutMs?: number;
  maxAttempts?: number;
  /**
   * STRICT workspace isolation: when true, a worker with no workspaceId can
   * only serve unbound (system) tasks; bound workers still serve only their
   * own workspace. Off by default to preserve the generic-device behavior.
   */
  requireWorkspaceBinding?: boolean;
  eventBus?: Pick<EventBus, 'publish'>;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface TaskRunState {
  request: TaskExecutionRequest;
  phase: 'queued' | 'assigned' | 'completed' | 'failed';
  attempts: number;
  lease: Lease | null;
  result?: string;
  completedAt?: number;
}

export class ExecutionCoordinator {
  private workers = new Map<WorkerId, WorkerRegistration & { running: number }>();
  private queue: TaskExecutionRequest[] = [];
  private tasks = new Map<TaskId, TaskRunState>();

  private readonly leaseTtlMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly requireWorkspaceBinding: boolean;

  constructor(private opts: CoordinatorOptions = {}) {
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.requireWorkspaceBinding = opts.requireWorkspaceBinding ?? false;
  }

  // ---------------------------------------------------------------- workers

  register(worker: WorkerRegistration, now = Date.now()): WorkerRegistration {
    if (this.workers.has(worker.id)) {
      throw AppError.conflict('aios_worker_exists', `worker '${worker.id}' is already registered`);
    }
    if (worker.maxConcurrent < 1) {
      throw AppError.badRequest('aios_worker_invalid', 'maxConcurrent must be >= 1');
    }
    this.workers.set(worker.id, { ...worker, running: 0 });
    this.emit({ type: CoordinatorEventType.WORKER_REGISTERED, workerId: worker.id, at: now });
    return worker;
  }

  deregister(workerId: WorkerId, now = Date.now()): boolean {
    const removed = this.workers.delete(workerId);
    if (removed) {
      // release any running leases so their tasks can be requeued
      this.requeueForWorker(workerId, now);
      this.emit({ type: CoordinatorEventType.HEARTBEAT_LOST, workerId, at: now });
    }
    return removed;
  }

  heartbeat(workerId: WorkerId, now = Date.now()): { ok: boolean; running: number; max: number } {
    const w = this.workers.get(workerId);
    if (!w) return { ok: false, running: 0, max: 0 };
    w.lastHeartbeatAt = now;
    this.emit({ type: CoordinatorEventType.HEARTBEAT_OK, workerId, at: now });
    return { ok: true, running: w.running, max: w.maxConcurrent };
  }

  listWorkers(): Array<WorkerRegistration & { running: number }> {
    return [...this.workers.values()];
  }

  activeWorkers(): number {
    return this.workers.size;
  }

  runningTotal(): number {
    let total = 0;
    for (const w of this.workers.values()) total += w.running;
    return total;
  }

  // ---------------------------------------------------------------- tasks

  /** Priority queue with PERFECT taskId dedupe (idempotent enqueue). */
  enqueue(request: TaskExecutionRequest, now = Date.now()): { duplicated: boolean } {
    const existing = this.tasks.get(request.taskId);
    if (existing && existing.phase !== 'failed') {
      this.emit({ type: CoordinatorEventType.TASK_DEDUPED, taskId: request.taskId, at: now });
      return { duplicated: true };
    }
    this.queue = this.queue.filter((q) => q.taskId !== request.taskId);
    this.queue.push(request);
    this.queue.sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId));
    this.tasks.set(request.taskId, {
      request,
      phase: 'queued',
      attempts: 0,
      lease: null,
    });
    return { duplicated: false };
  }

  /** Pick the best available worker for a queued task at `now`. */
  assign(now = Date.now()): TaskAssignment | null {
    const idx = this.queue.findIndex((req) => this.findWorker(req, now) !== null);
    if (idx === -1) return null;
    const request = this.queue[idx]!;
    this.queue.splice(idx, 1);
    const worker = this.findWorker(request, now)!;
    worker.running += 1;
    const state = this.tasks.get(request.taskId)!;
    state.phase = 'assigned';
    state.attempts += 1;
    const lease: Lease = {
      taskId: request.taskId,
      workerId: worker.id,
      grantedAt: now,
      expiresAt: now + this.leaseTtlMs,
      attempt: state.attempts,
    };
    state.lease = lease;
    this.emit({ type: CoordinatorEventType.LEASE_GRANTED, taskId: request.taskId, workerId: worker.id, attempt: lease.attempt, at: now });
    return { taskId: request.taskId, workerId: worker.id, lease, at: now };
  }

  renewLease(taskId: TaskId, workerId: WorkerId, now = Date.now()): { ok: boolean; expiresAt: number | null } {
    const w = this.workers.get(workerId);
    const state = this.tasks.get(taskId);
    if (!w || !state?.lease || state.lease.workerId !== workerId) return { ok: false, expiresAt: null };
    if (now > state.lease.expiresAt) return { ok: false, expiresAt: null };
    state.lease.expiresAt = now + this.leaseTtlMs;
    return { ok: true, expiresAt: state.lease.expiresAt };
  }

  /** Idempotent terminal completion (dedupe by taskId + explicit key). */
  complete(taskId: TaskId, workerId: WorkerId, key: string, now = Date.now()): { duplicated: boolean } {
    const state = this.tasks.get(taskId);
    if (!state) return { duplicated: false };
    if (state.phase === 'completed' && state.result === key) {
      this.emit({ type: CoordinatorEventType.TASK_DEDUPED, taskId, at: now });
      return { duplicated: true };
    }
    if (state.phase === 'completed') {
      // different key for a completed task -> idempotency conflict, refuse to overwrite
      return { duplicated: true };
    }
    if (state.lease && state.lease.workerId !== workerId) {
      this.emit({ type: CoordinatorEventType.TASK_DEDUPED, taskId, at: now });
      return { duplicated: true };
    }
    const w = this.workers.get(workerId);
    if (state.lease) w && (w.running -= 1);
    state.phase = 'completed';
    state.result = key;
    state.completedAt = now;
    state.lease = null;
    this.emit({ type: CoordinatorEventType.TASK_COMPLETED, taskId, workerId, at: now });
    return { duplicated: false };
  }

  /** Failure: resource the attempt, requeue or fail after maxAttempts. */
  failSync(taskId: TaskId, workerId: WorkerId, now = Date.now()): void {
    const state = this.tasks.get(taskId);
    const w = this.workers.get(workerId);
    if (!state) return;
    if (state.phase === 'failed') return;
    if (state.lease) w && (w.running -= 1);
    state.lease = null;
    if (state.attempts >= this.maxAttempts) {
      state.phase = 'failed';
      this.emit({ type: CoordinatorEventType.TASK_FAILED, taskId, attempt: state.attempts, at: now });
      return;
    }
    state.phase = 'queued';
    this.queue.push(state.request);
    this.queue.sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId));
    this.emit({ type: CoordinatorEventType.LEASE_EXPIRED, taskId, workerId, attempt: state.attempts, at: now });
  }

  /**
   * Liveness sweep: requeue tasks whose leases expired, and tasks on workers
   * whose heartbeats are stale. Idempotent and bounded by maxAttempts.
   */
  tick(now = Date.now()): void {
    for (const [id, w] of this.workers) {
      if (now - w.lastHeartbeatAt > this.heartbeatTimeoutMs) {
        this.emit({ type: CoordinatorEventType.HEARTBEAT_LOST, workerId: id, at: now });
        this.requeueForWorker(id, now);
        this.workers.delete(id);
      }
    }
    for (const [taskId, state] of this.tasks) {
      if (state.phase === 'assigned' && state.lease && now > state.lease.expiresAt) {
        const workerId = state.lease.workerId;
        const nextAttempt = state.attempts + 1;
        this.failSync(taskId, workerId, now);
        this.emit({
          type: CoordinatorEventType.LEASE_REASSIGNED,
          taskId,
          workerId,
          attempt: nextAttempt,
          at: now,
        });
      }
    }
  }

  taskState(taskId: TaskId): TaskRunState | undefined {
    return this.tasks.get(taskId);
  }

  queuedCount(): number {
    return this.queue.length;
  }

  // ---------------------------------------------------------------- helpers

  private findWorker(request: TaskExecutionRequest, now: number) {
    const eligible: Array<WorkerRegistration & { running: number }> = [];
    for (const w of this.workers.values()) {
      if (now - w.lastHeartbeatAt > this.heartbeatTimeoutMs) continue; // dead worker
      if (!this.matchesWorkspace(request.workspaceId, w.workspaceId)) continue; // workspace isolation
      if (w.running >= w.maxConcurrent) continue; // capacity
      const hasLabels = request.requiredLabels.every((l) => w.labels.includes(l));
      if (!hasLabels) continue;
      const caps = w.capabilities ?? w.labels;
      const hasCaps = request.capabilities.every((c) => caps.includes(c));
      if (!hasCaps) continue; // capability ledger: task caps must be a subset
      if (!this.matchesProfile(request, w)) continue; // Phase F profile routing
      if (!this.matchesResources(request, w)) continue; // resource-aware
      eligible.push(w);
    }
    if (eligible.length === 0) return null;
    // resource+load aware: prefer the worker with the most free capacity
    // (no second scheduler — a single deterministic selection rule)
    eligible.sort((a, b) => this.load(a) - this.load(b) || a.registeredAt - b.registeredAt);
    return eligible[0]!;
  }

  /**
   * Workspace isolation binding: a worker bound to a workspace serves ONLY
   * that workspace's tasks. Unbound workers keep serving any workspace unless
   * strict mode is enabled (then they serve system/unbound tasks only).
   */
  private matchesWorkspace(taskWorkspace: string, workerWorkspace: string | undefined): boolean {
    if (workerWorkspace) return taskWorkspace === workerWorkspace;
    if (this.requireWorkspaceBinding) return taskWorkspace === '';
    return true;
  }

  /**
   * Phase F capability-profile routing. A task that constrains a dimension
   * (OS/ARCHITECTURE/GPU/NETWORK_POLICY/EXECUTION_CLASS) can ONLY be served by
   * a worker whose advertised resource profile satisfies that constraint.
   * Advisory dimension values are matched strictly, so a worker never receives
   * a task whose profile it did not explicitly advertise.
   */
  private matchesProfile(
    req: TaskExecutionRequest,
    w: WorkerRegistration & { running: number },
  ): boolean {
    const r = w.resource;
    if (!r) return true; // no advertised profile -> no profile constraints to satisfy
    if (req.requireOs && r.os !== req.requireOs) return false;
    if (req.requireArchitecture && r.architecture !== req.requireArchitecture) return false;
    if (req.requireGpu !== undefined && req.requireGpu && !r.gpu) return false;
    if (req.requireNetworkPolicy && r.networkPolicy !== req.requireNetworkPolicy) return false;
    if (req.requireExecutionClass && r.executionClass !== req.requireExecutionClass) return false;
    return true;
  }

  /** Resource-aware scheduling: request floor must fit the worker's advertised resources. */
  private matchesResources(req: TaskExecutionRequest, w: WorkerRegistration & { running: number }): boolean {
    const need = req.requires;
    if (!need) return true;
    const avail = (w.resource ?? {}) as { cpu?: number; memoryBytes?: number };
    if (need.cpu && (avail.cpu === undefined || avail.cpu < need.cpu)) return false;
    if (need.memoryBytes && (avail.memoryBytes === undefined || avail.memoryBytes < need.memoryBytes)) return false;
    if (need.memoryBytes && avail.memoryBytes !== undefined && w.running > 0) {
      // honest partial accounting: a fully-loaded worker can still take a
      // second memory-heavy task only if it advertises capacity for it.
      const perTask = avail.memoryBytes / Math.max(w.maxConcurrent, 1);
      if (perTask * (w.running + 1) > avail.memoryBytes * 1.05) return false;
    }
    return true;
  }

  /** Normalized load in [0..1] used for the deterministic selection rule. */
  private load(w: WorkerRegistration & { running: number }): number {
    return w.maxConcurrent > 0 ? w.running / w.maxConcurrent : 1;
  }

  private requeueForWorker(workerId: WorkerId, now: number): void {
    for (const state of this.tasks.values()) {
      if (state.phase === 'assigned' && state.lease?.workerId === workerId) {
        const worker = this.workers.get(workerId);
        if (worker) worker.running -= 1;
        this.failSync(state.request.taskId, workerId, now);
      }
    }
  }

  private emit(ev: CoordinatorEvent): void {
    logger.debug('aios.distexec.event', { ...ev });
    try {
      this.opts.eventBus?.publish('aios.distexec', ev);
    } catch {
      /* events never break coordination */
    }
  }
}