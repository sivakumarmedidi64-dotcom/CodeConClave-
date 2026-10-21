/**
 * CodeConClave — emergency stop ("Stop everything").
 *
 * One server-side control, available in every permission mode, that:
 *   1. cancels every active local-agent assignment (laptop actions);
 *   2. cancels every cancellable task in every project;
 *   3. turns on the GLOBAL kill switch (the existing Stage 26G gate), so no new
 *      task, agent run, schedule occurrence or automation starts until the
 *      user presses Resume.
 * State stays resumable: cancelled tasks keep their history and checkpoints,
 * and nothing is deleted. The stop itself is audited (and the kill switch
 * audits + notifies on its own).
 */
import { withTenant } from '../../shared/db.js';
import { killSwitchActive, killSwitchStatus, setKillSwitch } from './killSwitch.js';

/** Non-terminal task statuses (TaskStatus + the runtime's in-flight states). */
const CANCELLABLE = [
  'CREATED',
  'PLANNED',
  'QUEUED',
  'WAITING_APPROVAL',
  'WAITING_FOR_LOCAL_AGENT',
  'EXECUTING',
  'RUNNING',
  'TESTING',
  'VERIFYING',
  'BLOCKED',
];

export interface EmergencyStopResult {
  assignmentsCancelled: number;
  assignmentsFailed: number;
  tasksCancelled: number;
  tasksSkipped: number;
  heldSince: string;
}

export interface HoldStatus {
  held: boolean;
  heldSince: string | null;
  reason: string | null;
}

export interface EmergencyDeps {
  setGlobalHold?: (userId: string, active: boolean, reason?: string) => Promise<void>;
  listActiveAssignments?: (userId: string) => Promise<{ id: string }[]>;
  cancelAssignment?: (id: string, reason: string) => Promise<void>;
  listCancellableTasks?: (userId: string) => Promise<{ id: string }[]>;
  cancelTask?: (userId: string, taskId: string, reason: string) => Promise<unknown>;
  audit?: (action: string, userId: string, detail: Record<string, unknown>) => Promise<void>;
}

async function defaultAudit(action: string, userId: string, detail: Record<string, unknown>): Promise<void> {
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({ action, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'account', resourceId: userId, detail });
}

async function defaultSetGlobalHold(userId: string, active: boolean, reason?: string): Promise<void> {
  await setKillSwitch(userId, 'GLOBAL', active, reason);
}

export async function holdStatus(userId: string): Promise<HoldStatus> {
  const global = (await killSwitchStatus(userId)).find((r) => r.scope === 'GLOBAL');
  return global?.active
    ? { held: true, heldSince: new Date(global.updated_at).toISOString(), reason: global.reason }
    : { held: false, heldSince: null, reason: null };
}

export async function emergencyStop(userId: string, reason = 'emergency_stop', deps: EmergencyDeps = {}): Promise<EmergencyStopResult> {
  const why = reason.slice(0, 200) || 'emergency_stop';

  // Hold FIRST so a schedule firing mid-stop cannot start new work.
  await (deps.setGlobalHold ?? defaultSetGlobalHold)(userId, true, why);
  const heldSince = new Date().toISOString();

  const result: EmergencyStopResult = {
    assignmentsCancelled: 0,
    assignmentsFailed: 0,
    tasksCancelled: 0,
    tasksSkipped: 0,
    heldSince,
  };

  const dispatch = deps.listActiveAssignments && deps.cancelAssignment ? null : await import('../agent/dispatch.js');
  const listAssignments = deps.listActiveAssignments ?? dispatch!.listActiveAssignmentsForUser;
  const cancelAssignment = deps.cancelAssignment ?? dispatch!.cancelAssignment;
  for (const a of await listAssignments(userId)) {
    try {
      await cancelAssignment(a.id, why);
      result.assignmentsCancelled += 1;
    } catch {
      result.assignmentsFailed += 1;
    }
  }

  const listTasks =
    deps.listCancellableTasks ??
    ((uid: string) =>
      withTenant(uid, async (q) =>
        (
          await q.query<{ id: string }>(
            'SELECT id FROM tasks WHERE owner_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 200',
            [uid, CANCELLABLE],
          )
        ).rows,
      ));
  const cancelTask = deps.cancelTask ?? (await import('../execution/tasks.js')).cancelTask;
  for (const t of await listTasks(userId)) {
    try {
      await cancelTask(userId, t.id, why);
      result.tasksCancelled += 1;
    } catch {
      // Raced to a terminal state — honestly reported as skipped.
      result.tasksSkipped += 1;
    }
  }

  await (deps.audit ?? defaultAudit)('control.emergency_stop', userId, { reason: why, ...result });
  return result;
}

export async function releaseHold(userId: string, deps: Pick<EmergencyDeps, 'setGlobalHold'> = {}): Promise<HoldStatus> {
  await (deps.setGlobalHold ?? defaultSetGlobalHold)(userId, false);
  return { held: false, heldSince: null, reason: null };
}

/** Is this owner on hold (global kill switch on)? */
export function isOnHold(userId: string): Promise<boolean> {
  return killSwitchActive(userId, 'GLOBAL');
}
