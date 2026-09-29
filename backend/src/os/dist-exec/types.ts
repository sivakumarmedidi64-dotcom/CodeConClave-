/**
 * CodeConClave AI OS — distributed execution preparation (types).
 *
 * Architecture ONLY. The future model:
 *
 *   AI OS Scheduler -> Execution Coordinator -> Worker Pool (A/B/C) -> task
 *
 * Every primitive here is a type/contract the coordinator will hand to the
 * EXISTING scheduler/supervisor/event-bus/resource-governor — nothing here is a
 * second scheduler, queue, bus, or state system.
 */

export type WorkerId = string;
export type TaskId = string;

/** Execution-class regime the worker can run under (Phase F/EXECUTION_CLASS). */
export const WorkerExecutionClass = {
  POLICY: 'policy',
  PROCESS: 'process',
  CONTAINER: 'container',
  MICROVM: 'microvm',
  REMOTE: 'remote',
} as const;
export type WorkerExecutionClass = (typeof WorkerExecutionClass)[keyof typeof WorkerExecutionClass];

/**
 * Machine-level resource availability snapshot a worker advertises.
 * CPU/MEMORY/concurrency are the honest, enforceable resources; the capability
 * dimensions below (OS/ARCHITECTURE/GPU/NETWORK_POLICY/LOCAL_TOOLS/
 * EXECUTION_CLASS) are advisory labels the scheduler routes on and the worker
 * must never be granted more authority than an individual task requires.
 */
export interface WorkerResource {
  cpu?: number;
  memoryBytes?: number;
  concurrency: number;
  /** Phase F capability routing dimensions (advisory, capability-gated). */
  os?: string;
  architecture?: string;
  gpu?: boolean;
  networkPolicy?: 'none' | 'isolated' | 'allowlist' | 'unrestricted';
  localTools?: string[];
  executionClass?: WorkerExecutionClass;
}

/** A worker ("device") that can own execution leases. */
export interface WorkerRegistration {
  id: WorkerId;
  /** Capability labels the scheduler matches tasks against (e.g. 'docker_executor', 'linux-amd64'). */
  labels: string[];
  /**
   * Workspace isolation binding: a worker with a workspaceId is scoped to that
   * workspace and MUST never receive a task from another workspace. Optional
   * so a device may serve workspace-agnostic (system) tasks only.
   */
  workspaceId?: string;
  /** Explicit capabilities this worker holds (task capabilities must be a subset). */
  capabilities?: string[];
  maxConcurrent: number;
  resource?: WorkerResource;
  lastHeartbeatAt: number;
  registeredAt: number;
  /** For the future/remote model: optional endpoint + auth hint (never a secret). */
  endpoint?: string;
}

export interface TaskResourceRequirement {
  cpu?: number;
  memoryBytes?: number;
}

export interface TaskExecutionRequest {
  taskId: TaskId;
  workspaceId: string;
  /** Higher claims first (mirrors the existing task/queue priority). */
  priority: number;
  /** Labels a worker must expose to receive this task. */
  requiredLabels: string[];
  /** Capabilities the runnable needs (enforced by the capability ledger on the worker). */
  capabilities: string[];
  /** Resource floor the winning worker must advertise (resource-aware scheduling). */
  requires?: TaskResourceRequirement;
  /**
   * Phase F routing constraints (optional). When set, only workers whose
   * advertised profile satisfies the constraint are eligible. Every constraint
   * is capability-based — a task can only select a worker that explicitly
   * advertises the matching dimension.
   */
  requireOs?: string;
  requireArchitecture?: string;
  requireGpu?: boolean;
  requireNetworkPolicy?: 'none' | 'isolated' | 'allowlist' | 'unrestricted';
  requireExecutionClass?: WorkerExecutionClass;
  runnableKind: string;
  deadlineMs?: number;
}

export interface Lease {
  taskId: TaskId;
  workerId: WorkerId;
  grantedAt: number;
  expiresAt: number;
  attempt: number;
}

export interface TaskAssignment {
  taskId: TaskId;
  workerId: WorkerId;
  lease: Lease;
  at: number;
}

export const CoordinatorEventType = {
  WORKER_REGISTERED: 'worker_registered',
  LEASE_GRANTED: 'lease_granted',
  LEASE_EXPIRED: 'lease_expired',
  LEASE_REASSIGNED: 'lease_reassigned',
  HEARTBEAT_OK: 'heartbeat_ok',
  HEARTBEAT_LOST: 'heartbeat_lost',
  TASK_DEDUPED: 'task_deduped',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
} as const;
export type CoordinatorEventType = (typeof CoordinatorEventType)[keyof typeof CoordinatorEventType];

export interface CoordinatorEvent {
  type: CoordinatorEventType;
  taskId?: TaskId;
  workerId?: WorkerId;
  attempt?: number;
  at: number;
}