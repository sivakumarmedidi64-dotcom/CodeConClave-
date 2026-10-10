/**
 * CodeConClave — P0 local execution fabric.
 *
 * Links a parked LOCAL task (WAITING_FOR_LOCAL_AGENT) to a paired, online
 * device through an attempt-scoped assignment lease, delivered over the
 * EXISTING /agent WebSocket hub. This is the minimum fabric that lets the
 * existing agent runtime CLAIM and REPORT a task; it is additive and does not
 * create a second execution engine.
 *
 * Honesty guarantees:
 *  - offline stays WAITING_FOR_LOCAL_AGENT — nothing is claimed or faked;
 *  - every transition is persisted (local_task_assignments + tasks) and audited;
 *  - ownership is verified twice (authenticated device ⇄ task owner, RLS);
 *  - an attempt lease is fenced by attempt_count so a superseded attempt stops.
 */
import { withSystem, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction } from '@codeconclave/shared';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';
import { wsHub } from './hub.js';
import {
  getTaskInternal,
  setTaskStatus,
  beginAttempt,
  finishAttempt,
  touchTask,
  clearTaskFailureState,
  deadLetterTask,
  type TaskRow,
} from '../execution/tasks.js';
import type { IsOnlineFn } from './service.js';
import {
  browserControlEnabled,
  browserInstructionRequiredCapabilities,
  BROWSER_NON_RETRYABLE_OPS,
  type BrowserInstruction,
} from './browser-policy.js';
import {
  desktopControlEnabled,
  desktopInstructionRequiredCapabilities,
  type DesktopInstruction,
} from './desktop-policy.js';

/** Any explicit local instruction a task may carry. */
export type LocalInstruction = BrowserInstruction | DesktopInstruction;

/** Capabilities a device must advertise to execute a LOCAL task. */
export const LOCAL_TASK_REQUIRED_CAPABILITIES = ['terminal_exec'] as const;

/** Device capabilities a LOCAL task actually requires (per instruction kind). */
export function instructionRequiredCapabilities(instruction: LocalInstruction | null): string[] {
  if (instruction?.type === 'browser') return browserInstructionRequiredCapabilities(instruction) ?? [];
  if (instruction?.type === 'desktop') return desktopInstructionRequiredCapabilities(instruction) ?? [];
  return [...LOCAL_TASK_REQUIRED_CAPABILITIES];
}

/** The master feature gate a given instruction kind depends on, if any. */
function instructionControlDisabled(instruction: LocalInstruction | null): 'browser_control_disabled' | 'desktop_control_disabled' | null {
  if (instruction?.type === 'browser' && !browserControlEnabled()) return 'browser_control_disabled';
  if (instruction?.type === 'desktop' && !desktopControlEnabled()) return 'desktop_control_disabled';
  return null;
}

export type AssignmentStatus =
  | 'ASSIGNED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'REPORTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

const TERMINAL_ASSIGNMENT: ReadonlySet<AssignmentStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const ACTIVE_ASSIGNMENT: ReadonlySet<AssignmentStatus> = new Set(['ASSIGNED', 'CLAIMED', 'RUNNING', 'REPORTED']);

export interface AssignmentRow {
  id: string;
  task_id: string;
  owner_id: string;
  project_id: string;
  device_id: string;
  attempt_id: string | null;
  attempt_number: number | null;
  status: AssignmentStatus;
  lease_expires_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_detail: string | null;
  progress: Record<string, unknown> | null;
  artifact_refs: unknown[];
  created_at: string;
  updated_at: string;
}

export interface DeviceCandidate {
  id: string;
  name: string;
  capabilities: string[];
}

export type DispatchResult =
  | { dispatched: true; assignmentId: string; deviceId: string; delivered: boolean }
  | { dispatched: false; reason: 'not_local' | 'not_parked' | 'no_eligible_device' | 'already_terminal' | 'browser_control_disabled' | 'desktop_control_disabled' };

/** Master gate — default OFF; a disabled capability must never appear enabled. */
export function localExecutionEnabled(): boolean {
  return String(env.LOCAL_EXECUTION_ENABLED).toLowerCase() === 'true';
}

/** How long an assignment stays claimable before recovery re-parks the task. */
export function localLeaseMs(): number {
  return env.LOCAL_TASK_LEASE_MS;
}

/**
 * Paired devices of the owner that are currently live AND advertise every
 * required capability. Deterministic order (most-recently-seen first) so the
 * same task lands on the same device across retries.
 */
export async function resolveEligibleDevices(
  userId: string,
  isOnline: IsOnlineFn,
  required: readonly string[] = LOCAL_TASK_REQUIRED_CAPABILITIES,
): Promise<DeviceCandidate[]> {
  const result = await withTenant(userId, (q) =>
    q.query<{ id: string; name: string; state: string; capabilities: unknown }>(
      `SELECT id, name, state, capabilities
         FROM devices
        WHERE user_id = $1 AND state = 'PAIRED'
        ORDER BY last_seen_at DESC NULLS LAST, created_at ASC`,
      [userId],
    ),
  );
  return result.rows
    .filter((row) => isOnline(userId, row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
    }))
    .filter((d) => required.every((cap) => d.capabilities.includes(cap)));
}

/**
 * Dispatch a parked LOCAL task to an eligible device. Idempotent: an existing
 * active assignment is re-delivered rather than duplicated. Never claims the
 * task — the device claims; offline simply leaves a pending assignment.
 */
export async function dispatchLocalTask(taskId: string, isOnline: IsOnlineFn): Promise<DispatchResult> {
  const task = await getTaskInternal(taskId);
  if (task.execution_mode !== 'LOCAL') return { dispatched: false, reason: 'not_local' };
  if (task.status !== 'WAITING_FOR_LOCAL_AGENT') return { dispatched: false, reason: 'not_parked' };

  // A browser/desktop instruction is a real capability: it dispatches ONLY when
  // the feature is enabled AND a device advertises the exact capabilities.
  const instruction = (task.local_instruction ?? null) as LocalInstruction | null;
  const disabled = instructionControlDisabled(instruction);
  if (disabled) return { dispatched: false, reason: disabled };
  const required = instructionRequiredCapabilities(instruction);
  if ((instruction?.type === 'browser' || instruction?.type === 'desktop') && required.length === 0) {
    return { dispatched: false, reason: 'no_eligible_device' };
  }

  const existing = await findActiveAssignmentForTask(taskId);
  if (existing) {
    const delivered = await deliverAssignment(existing.id);
    return { dispatched: true, assignmentId: existing.id, deviceId: existing.device_id, delivered };
  }

  const candidates = await resolveEligibleDevices(task.owner_id, isOnline, required);
  const pinned = instruction?.pinnedDeviceId;
  // A user-pinned device is a hard scope: never silently hop to another device.
  const device = pinned
    ? (candidates.find((c) => c.id === pinned) ?? null)
    : (candidates[0] ?? null);
  if (!device) return { dispatched: false, reason: 'no_eligible_device' };
  const id = newId(PREFIX.LOCAL_ASSIGNMENT);
  const leaseExpiresAt = new Date(Date.now() + localLeaseMs()).toISOString();
  await withSystem((q) =>
    q.query(
      `INSERT INTO local_task_assignments (id, task_id, owner_id, project_id, device_id, status, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6)`,
      [id, task.id, task.owner_id, task.project_id, device.id, leaseExpiresAt],
    ),
  );
  await withSystem((q) =>
    q.query('UPDATE tasks SET assigned_device_id = $2, local_assignment_at = now(), updated_at = now() WHERE id = $1', [
      task.id,
      device.id,
    ]),
  );
  await recordAudit({
    action: AuditAction.LOCAL_TASK_ASSIGNED,
    actorUserId: task.owner_id,
    scope: 'USER',
    tenantId: task.owner_id,
    resourceType: 'task',
    resourceId: task.id,
    detail: { assignmentId: id, deviceId: device.id, projectId: task.project_id },
  });
  const delivered = await deliverAssignment(id);
  return { dispatched: true, assignmentId: id, deviceId: device.id, delivered };
}

/** Re-send an assignment frame to its device (best-effort; false when offline). */
export async function deliverAssignment(assignmentId: string): Promise<boolean> {
  const assignment = await getAssignmentInternal(assignmentId);
  if (!assignment || TERMINAL_ASSIGNMENT.has(assignment.status)) return false;
  const task = await getTaskInternal(assignment.task_id);
  return wsHub().sendToDevice(assignment.owner_id, assignment.device_id, assignmentFrame(assignment, task));
}

function assignmentFrame(assignment: AssignmentRow, task: TaskRow): Record<string, unknown> {
  const instruction = (task.local_instruction as LocalInstruction | null) ?? null;
  const required = instructionRequiredCapabilities(instruction);
  return {
    type: 'task_assign',
    assignmentId: assignment.id,
    leaseExpiresAt: assignment.lease_expires_at,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      projectId: task.project_id,
      executionMode: task.execution_mode,
      timeoutMs: task.timeout_ms,
      requiredCapabilities: required,
      instruction,
    },
  };
}

/**
 * Reconnect handler: when a device (re)connects, re-deliver its live
 * assignments and dispatch any parked LOCAL tasks that now have a device.
 */
export async function onAgentReady(userId: string, deviceId: string): Promise<number> {
  let delivered = 0;
  const pending = await withSystem<{ rows: { id: string }[] }>((q) =>
    q.query<{ id: string }>(
      `SELECT id FROM local_task_assignments
        WHERE owner_id = $1 AND device_id = $2 AND status IN ('ASSIGNED','CLAIMED','RUNNING','REPORTED')
        ORDER BY created_at`,
      [userId, deviceId],
    ),
  );
  for (const row of pending.rows) {
    if (await deliverAssignment(row.id)) delivered += 1;
  }
  await dispatchParkedTasks(userId, (u, d) => wsHub().isOnline(u, d)).catch(() => undefined);
  return delivered;
}

/** Dispatch every parked LOCAL task of a user (called on device ready/recovery). */
export async function dispatchParkedTasks(userId: string, isOnline: IsOnlineFn): Promise<number> {
  const parked = await withSystem<{ rows: { id: string }[] }>((q) =>
    q.query<{ id: string }>(
      `SELECT id FROM tasks
        WHERE owner_id = $1 AND execution_mode = 'LOCAL' AND status = 'WAITING_FOR_LOCAL_AGENT'
        ORDER BY created_at`,
      [userId],
    ),
  );
  let count = 0;
  for (const row of parked.rows) {
    // A task that already has a live assignment was handled by the pending
    // re-delivery pass; dispatching it again would duplicate the frame.
    if (await findActiveAssignmentForTask(row.id)) continue;
    const result = await dispatchLocalTask(row.id, isOnline).catch(() => ({ dispatched: false as const, reason: 'no_eligible_device' as const }));
    if (result.dispatched) count += 1;
  }
  return count;
}

/**
 * Device claims an assignment. Ownership is verified (device ⇄ owner), the
 * lease must be live, the task must still be parked, and an attempt is opened
 * through the existing beginAttempt (which fences the generation via
 * attempt_count). The task moves to EXECUTING (legal from WAITING_FOR_LOCAL_AGENT).
 */
export async function claimAssignment(input: {
  assignmentId: string;
  userId: string;
  deviceId: string;
}): Promise<{ assignmentId: string; attemptId: string; attemptNumber: number }> {
  const assignment = await requireOwnedAssignment(input);
  if (assignment.status !== 'ASSIGNED' && assignment.status !== 'CLAIMED') {
    throw AppError.conflict('assignment_not_claimable', `Assignment is ${assignment.status.toLowerCase()}`);
  }
  if (isLeaseExpired(assignment)) {
    await expireAssignment(assignment, 'lease_expired_before_claim');
    throw AppError.conflict('assignment_lease_expired', 'Assignment lease expired before claim');
  }
  const task = await getTaskInternal(assignment.task_id);
  if (task.status !== 'WAITING_FOR_LOCAL_AGENT') {
    throw AppError.conflict('task_not_waiting_local', `Task is ${task.status.toLowerCase()}, not awaiting a local agent`);
  }
  const attempt = await beginAttempt(task.id);
  await setTaskStatus(task.id, 'EXECUTING');
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments
          SET status = 'RUNNING', attempt_id = $2, attempt_number = $3,
              claimed_at = now(), last_heartbeat_at = now(),
              lease_expires_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
        WHERE id = $1`,
      [assignment.id, attempt.id, attempt.attempt_number, localLeaseMs()],
    ),
  );
  await recordAudit({
    action: AuditAction.LOCAL_TASK_CLAIMED,
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.userId,
    resourceType: 'task',
    resourceId: task.id,
    detail: { assignmentId: assignment.id, deviceId: input.deviceId, attemptNumber: attempt.attempt_number },
  });
  return { assignmentId: assignment.id, attemptId: attempt.id, attemptNumber: attempt.attempt_number };
}

/** Fenced liveness: only the owning attempt generation may refresh the lease. */
export async function heartbeatAssignment(input: {
  assignmentId: string;
  userId: string;
  deviceId: string;
  attemptNumber?: number;
}): Promise<{ ok: true }> {
  const assignment = await requireOwnedAssignment(input);
  if (!ACTIVE_ASSIGNMENT.has(assignment.status)) {
    throw AppError.conflict('assignment_not_active', `Assignment is ${assignment.status.toLowerCase()}`);
  }
  await assertAttemptOwns(assignment, input.attemptNumber);
  const generation = input.attemptNumber ?? assignment.attempt_number ?? undefined;
  await touchTask(assignment.task_id, generation);
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments
          SET last_heartbeat_at = now(),
              lease_expires_at = now() + ($3 || ' milliseconds')::interval,
              status = CASE WHEN status = 'CLAIMED' THEN 'RUNNING' ELSE status END,
              updated_at = now()
        WHERE id = $1 AND (attempt_number IS NULL OR attempt_number = $2)`,
      [assignment.id, generation ?? null, localLeaseMs()],
    ),
  );
  return { ok: true };
}

/** Persist streamed progress (no per-line audit — reports, not actions). */
export async function recordAssignmentProgress(input: {
  assignmentId: string;
  userId: string;
  deviceId: string;
  progress: Record<string, unknown>;
}): Promise<{ ok: true }> {
  const assignment = await requireOwnedAssignment(input);
  if (!ACTIVE_ASSIGNMENT.has(assignment.status)) {
    throw AppError.conflict('assignment_not_active', `Assignment is ${assignment.status.toLowerCase()}`);
  }
  await withSystem((q) =>
    q.query('UPDATE local_task_assignments SET progress = $2::jsonb, updated_at = now() WHERE id = $1', [
      assignment.id,
      JSON.stringify(input.progress),
    ]),
  );
  try {
    // Live workbench refresh: push the real progress event onto the project bus.
    const { broadcastRuntime } = await import('../runtime/events.js');
    broadcastRuntime(assignment.project_id, {
      type: 'task',
      id: assignment.task_id,
      projectId: assignment.project_id,
      status: 'RUNNING',
      progress: input.progress,
      ts: new Date().toISOString(),
    });
  } catch {
    /* best-effort — the persisted assignment remains the source of truth */
  }
  return { ok: true };
}

/** Record a real artifact reference produced by the local run (never fabricated). */
export async function reportAssignmentArtifact(input: {
  assignmentId: string;
  userId: string;
  deviceId: string;
  artifact: Record<string, unknown>;
}): Promise<{ ok: true; count: number }> {
  const assignment = await requireOwnedAssignment(input);
  if (!ACTIVE_ASSIGNMENT.has(assignment.status)) {
    throw AppError.conflict('assignment_not_active', `Assignment is ${assignment.status.toLowerCase()}`);
  }
  const refs = Array.isArray(assignment.artifact_refs) ? [...assignment.artifact_refs, input.artifact] : [input.artifact];
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments
          SET artifact_refs = $2::jsonb, status = CASE WHEN status = 'CLAIMED' THEN 'RUNNING' ELSE status END, updated_at = now()
        WHERE id = $1`,
      [assignment.id, JSON.stringify(refs)],
    ),
  );
  await recordAudit({
    action: AuditAction.LOCAL_TASK_ARTIFACT,
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.userId,
    resourceType: 'task',
    resourceId: assignment.task_id,
    detail: { assignmentId: assignment.id, artifact: input.artifact },
  });
  return { ok: true, count: refs.length };
}

/** Successful completion: finish the attempt, clear failure markers, COMPLETE. */
export async function completeAssignment(input: {
  assignmentId: string;
  userId: string;
  deviceId: string;
  attemptNumber?: number;
  result?: Record<string, unknown>;
  artifacts?: Record<string, unknown>[];
}): Promise<void> {
  const assignment = await requireOwnedAssignment(input);
  if (assignment.status === 'COMPLETED') return;
  if (!['CLAIMED', 'RUNNING', 'REPORTED'].includes(assignment.status)) {
    throw AppError.conflict('assignment_not_active', `Assignment is ${assignment.status.toLowerCase()}`);
  }
  await assertAttemptOwns(assignment, input.attemptNumber);
  if (assignment.attempt_id) {
    await finishAttempt(assignment.attempt_id, 'SUCCESS', undefined, typeof input.result?.summary === 'string' ? (input.result.summary as string) : undefined);
  }
  const refs = input.artifacts?.length ? input.artifacts : assignment.artifact_refs;
  await clearTaskFailureState(assignment.task_id);
  await setTaskStatus(assignment.task_id, 'COMPLETED');
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments
          SET status = 'COMPLETED', result = $2::jsonb, artifact_refs = $3::jsonb,
              completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [assignment.id, JSON.stringify(input.result ?? {}), JSON.stringify(refs ?? [])],
    ),
  );
  await recordAudit({
    action: AuditAction.LOCAL_TASK_COMPLETED,
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.userId,
    resourceType: 'task',
    resourceId: assignment.task_id,
    detail: { assignmentId: assignment.id, deviceId: input.deviceId, artifacts: Array.isArray(refs) ? refs.length : 0 },
  });
}

/**
 * Failed execution. Retries are re-parked as WAITING_FOR_LOCAL_AGENT (a LOCAL
 * task can only run on a device) while budget remains; exhausted budget
 * dead-letters through the existing DLQ path. Never fabricates a PASS.
 */
export async function failAssignment(input: {
  assignmentId: string;
  userId: string;
  deviceId: string;
  attemptNumber?: number;
  errorCode?: string;
  error: string;
}): Promise<{ decision: 'REPARKED' | 'DEAD_LETTERED' }> {
  const assignment = await requireOwnedAssignment(input);
  if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(assignment.status)) {
    return { decision: 'DEAD_LETTERED' };
  }
  await assertAttemptOwns(assignment, input.attemptNumber);
  const task = await getTaskInternal(assignment.task_id);
  if (assignment.attempt_id) {
    await finishAttempt(assignment.attempt_id, 'FAILURE', input.errorCode ?? 'local_execution_failed', input.error.slice(0, 1000));
  }
  // A browser action whose outcome is uncertain must never be replayed blindly:
  // a failed non-idempotent op (submit/download/click/type/select/back/forward
  // or one we cannot identify) is dead-lettered immediately, budget or not.
  const instruction = (task.local_instruction as BrowserInstruction | null) ?? null;
  let nonRetryableBrowserFailure = false;
  if (instruction?.type === 'browser' && input.errorCode === 'browser_action_failed') {
    try {
      const parsed = JSON.parse(input.error) as { actionIndex?: number; op?: string };
      const op = typeof parsed.op === 'string' ? (parsed.op as keyof typeof BROWSER_NON_RETRYABLE_OPS & string) : undefined;
      nonRetryableBrowserFailure = op === undefined || (BROWSER_NON_RETRYABLE_OPS as ReadonlySet<string>).has(op);
    } catch {
      nonRetryableBrowserFailure = true; // unidentifiable → never blindly replay
    }
  }
  const retriesLeft = nonRetryableBrowserFailure ? 0 : task.max_attempts - 1 - task.retry_count;
  if (retriesLeft > 0) {
    await withSystem((q) =>
      q.query(
        `UPDATE local_task_assignments SET status = 'FAILED', error_code = $2, error_detail = $3, completed_at = now(), updated_at = now() WHERE id = $1`,
        [assignment.id, input.errorCode ?? 'local_execution_failed', input.error.slice(0, 2000)],
      ),
    );
    // Re-park: bump the retry counter and return the task to the dispatchable
    // state. A fresh assignment is created by the next dispatch/recovery pass.
    await withSystem((q) =>
      q.query(
        `UPDATE tasks SET status = 'WAITING_FOR_LOCAL_AGENT', retry_count = retry_count + 1,
                 recovery_status = 'RETRYING', failure_reason = $2, error_code = $3,
                 assigned_device_id = NULL, updated_at = now()
           WHERE id = $1`,
        [task.id, input.error.slice(0, 2000), input.errorCode ?? 'local_execution_failed'],
      ),
    );
    await recordAudit({
      action: AuditAction.LOCAL_TASK_FAILED,
      actorUserId: input.userId,
      scope: 'USER',
      tenantId: input.userId,
      resourceType: 'task',
      resourceId: task.id,
      detail: { assignmentId: assignment.id, errorCode: input.errorCode ?? null, decision: 'RETRY' },
    });
    await dispatchLocalTask(task.id, (u, d) => wsHub().isOnline(u, d)).catch(() => undefined);
    return { decision: 'REPARKED' };
  }
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments SET status = 'FAILED', error_code = $2, error_detail = $3, completed_at = now(), updated_at = now() WHERE id = $1`,
      [assignment.id, input.errorCode ?? 'local_execution_failed', input.error.slice(0, 2000)],
    ),
  );
  await deadLetterTask(task.id, input.errorCode ?? 'local_execution_failed', input.error.slice(0, 2000));
  await recordAudit({
    action: AuditAction.LOCAL_TASK_FAILED,
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.userId,
    resourceType: 'task',
    resourceId: task.id,
    detail: { assignmentId: assignment.id, errorCode: input.errorCode ?? null, decision: 'DEAD_LETTER' },
  });
  return { decision: 'DEAD_LETTERED' };
}

/**
 * Active (non-terminal) assignments owned by a user, oldest first.
 * Owner-scoped in SQL so one user can never enumerate another's ledger.
 * Used by the unified stop-all control; bounded by `limit`.
 */
export async function listActiveAssignmentsForUser(userId: string, limit = 50): Promise<AssignmentRow[]> {
  const rows = await withSystem<{ rows: AssignmentRow[] }>((q) =>
    q.query<AssignmentRow>(
      `SELECT * FROM local_task_assignments
        WHERE owner_id = $1 AND status IN ('ASSIGNED','CLAIMED','RUNNING','REPORTED')
        ORDER BY created_at ASC LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 200))],
    ),
  );
  return rows.rows;
}

/** User/owner cancellation: mark the assignment and cancel the task. */
export async function cancelAssignment(assignmentId: string, reason = 'cancelled_by_user'): Promise<void> {  const assignment = await getAssignmentInternal(assignmentId);
  if (!assignment || TERMINAL_ASSIGNMENT.has(assignment.status)) return;
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments SET status = 'CANCELLED', error_detail = $2, completed_at = now(), updated_at = now() WHERE id = $1`,
      [assignmentId, reason],
    ),
  );
  const task = await getTaskInternal(assignment.task_id);
  if (!['COMPLETED', 'CANCELLED', 'FAILED', 'TIMED_OUT'].includes(task.status)) {
    await setTaskStatus(task.id, 'CANCELLED', reason);
  }
  await recordAudit({
    action: AuditAction.LOCAL_TASK_CANCELLED,
    actorUserId: assignment.owner_id,
    scope: 'USER',
    tenantId: assignment.owner_id,
    resourceType: 'task',
    resourceId: assignment.task_id,
    detail: { assignmentId, reason },
  });
}

/**
 * Recovery sweep (watchdog-shaped, non-frozen): expire assignments whose lease
 * lapsed. A never-claimed task simply stays parked; a claimed/running task is
 * re-parked (budget remains) or re-dispatched. Counts the assignments expired.
 */
export async function recoverExpiredAssignments(now = new Date()): Promise<number> {
  const expired = await withSystem<{ rows: AssignmentRow[] }>((q) =>
    q.query<AssignmentRow>(
      `SELECT * FROM local_task_assignments
        WHERE status IN ('ASSIGNED','CLAIMED','RUNNING')
          AND lease_expires_at < $1
        ORDER BY lease_expires_at`,
      [now.toISOString()],
    ),
  );
  let recovered = 0;
  for (const assignment of expired.rows) {
    await expireAssignment(assignment, 'lease_expired');
    recovered += 1;
  }
  return recovered;
}

/**
 * Start the lease-expiry recovery sweep. Idempotent and unref'd so it never
 * keeps the process alive; disabled entirely unless LOCAL_EXECUTION_ENABLED.
 */
let recoveryTimer: NodeJS.Timeout | null = null;
export function startLocalRecoverySweep(intervalMs = 60_000): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    if (!localExecutionEnabled()) return;
    void recoverExpiredAssignments().catch(() => undefined);
  }, intervalMs);
  recoveryTimer.unref?.();
}

async function expireAssignment(assignment: AssignmentRow, reason: string): Promise<void> {
  if (TERMINAL_ASSIGNMENT.has(assignment.status)) return;
  await withSystem((q) =>
    q.query(
      `UPDATE local_task_assignments SET status = 'EXPIRED', error_detail = $2, completed_at = now(), updated_at = now() WHERE id = $1`,
      [assignment.id, reason],
    ),
  );
  if (assignment.attempt_id) {
    await finishAttempt(assignment.attempt_id, 'TIMEOUT', 'local_lease_expired', reason).catch(() => undefined);
  }
  const task = await getTaskInternal(assignment.task_id);
  if (task.status === 'EXECUTING' || task.status === 'WAITING_FOR_DEVICE') {
    const retriesLeft = task.max_attempts - 1 - task.retry_count;
    if (retriesLeft > 0) {
      await withSystem((q) =>
        q.query(
          `UPDATE tasks SET status = 'WAITING_FOR_LOCAL_AGENT', recovery_status = 'RETRYING', retry_count = retry_count + 1,
                   failure_reason = $2, assigned_device_id = NULL, updated_at = now() WHERE id = $1`,
          [task.id, reason],
        ),
      );
      await dispatchLocalTask(task.id, (u, d) => wsHub().isOnline(u, d)).catch(() => undefined);
    } else {
      await deadLetterTask(task.id, 'local_lease_expired', reason).catch(() => undefined);
    }
  }
  await recordAudit({
    action: AuditAction.LOCAL_TASK_EXPIRED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'task',
    resourceId: assignment.task_id,
    detail: { assignmentId: assignment.id, deviceId: assignment.device_id, reason },
  });
}

/**
 * Latest owner-scoped assignment + instruction for the Workbench /local view.
 * Never leaks another user's device or task state.
 */
export async function getAssignmentForUser(userId: string, taskId: string): Promise<{
  assignment: (Omit<AssignmentRow, 'result'> & { result: Record<string, unknown> | null }) | null;
  instruction: LocalInstruction | null;
} | null> {
  const rows = await withSystem<{ rows: AssignmentRow[] }>((q) =>
    q.query<AssignmentRow>(
      `SELECT * FROM local_task_assignments
        WHERE task_id = $1 AND owner_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [taskId, userId],
    ),
  );
  const assignment = rows.rows[0] ?? null;
  if (!assignment) return null;
  let task: TaskRow | null = null;
  try {
    task = await getTaskInternal(taskId);
  } catch {
    task = null;
  }
  const instruction = task && (task.local_instruction as LocalInstruction | null);
  return {
    assignment: assignment ? { ...assignment, result: (assignment.result ?? null) as Record<string, unknown> | null } : null,
    instruction: instruction?.type === 'browser' || instruction?.type === 'desktop' ? instruction : null,
  };
}

// -------------------------------------------------------------------- helpers

async function getAssignmentInternal(assignmentId: string): Promise<AssignmentRow | null> {
  const rows = await withSystem<{ rows: AssignmentRow[] }>((q) =>
    q.query<AssignmentRow>('SELECT * FROM local_task_assignments WHERE id = $1', [assignmentId]),
  );
  return rows.rows[0] ?? null;
}

async function findActiveAssignmentForTask(taskId: string): Promise<AssignmentRow | null> {
  const rows = await withSystem<{ rows: AssignmentRow[] }>((q) =>
    q.query<AssignmentRow>(
      `SELECT * FROM local_task_assignments
        WHERE task_id = $1 AND status IN ('ASSIGNED','CLAIMED','RUNNING','REPORTED')
        ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    ),
  );
  return rows.rows[0] ?? null;
}

/** Load an assignment and prove the authenticated device owns it. */
async function requireOwnedAssignment(input: { assignmentId: string; userId: string; deviceId: string }): Promise<AssignmentRow> {
  const assignment = await getAssignmentInternal(input.assignmentId);
  if (!assignment) throw AppError.notFound('Assignment');
  if (assignment.owner_id !== input.userId || assignment.device_id !== input.deviceId) {
    throw AppError.forbidden('assignment_not_owned', 'Assignment does not belong to this device');
  }
  return assignment;
}

function isLeaseExpired(assignment: AssignmentRow): boolean {
  return new Date(assignment.lease_expires_at).getTime() < Date.now();
}

/** Fence: a heartbeat/result from a stale generation must not advance the task. */
async function assertAttemptOwns(assignment: AssignmentRow, attemptNumber?: number): Promise<void> {
  if (attemptNumber === undefined || assignment.attempt_number === null) return;
  if (attemptNumber !== assignment.attempt_number) {
    throw AppError.conflict('attempt_superseded', 'A newer attempt owns this assignment; this attempt stops');
  }
}
