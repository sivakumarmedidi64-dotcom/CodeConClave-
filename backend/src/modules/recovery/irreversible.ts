/**
 * CodeConClave — irreversible actions (Stage 26E).
 * Actions a task performed that CANNOT be undone (external payments, destructive
 * deploys, data deletion, credentials rotation, …). Rewind never claims undo:
 * rewinding past an irreversible action is BLOCKED — the branch is created from
 * the newest checkpoint that precedes the irreversible action, or not at all.
 */
import { withTenant, pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, RecoveryEventType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { getTask } from '../execution/tasks.js';
import { recordRecoveryHistory } from './history.js';

export interface IrreversibleActionRow {
  id: string;
  task_id: string;
  owner_id: string;
  action_type: string;
  description: string;
  detail: unknown;
  acknowledged: boolean;
  created_at: Date;
}

export interface IrreversibleActionInput {
  actionType: string;
  description: string;
  detail?: Record<string, unknown>;
}

/**
 * Record an action that cannot be undone. The record itself is immutable;
 * it exists so recovery features (rewind/branch) can prove what cannot be
 * rolled back and never claim otherwise.
 */
export async function recordIrreversibleAction(
  userId: string,
  taskId: string,
  input: IrreversibleActionInput,
): Promise<IrreversibleActionRow> {
  const task = await getTask(userId, taskId);
  const id = newId(PREFIX.IRREVERSIBLE_ACTION);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO irreversible_actions (id, task_id, owner_id, action_type, description, detail)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [id, taskId, userId, input.actionType, input.description, JSON.stringify(input.detail ?? {})],
  ));
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.IRREVERSIBLE_ACTION, {
    irreversibleActionId: id,
    actionType: input.actionType,
    description: input.description,
  });
  await recordAudit({
    action: AuditAction.TASK_IRREVERSIBLE_ACTION,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { irreversibleActionId: id, actionType: input.actionType, taskTitle: task.title },
  });
  return {
    id,
    task_id: taskId,
    owner_id: userId,
    action_type: input.actionType,
    description: input.description,
    detail: input.detail ?? {},
    acknowledged: false,
    created_at: new Date(),
  };
}

/** List all irreversible actions recorded for a task (newest first). */
export async function listIrreversibleActions(userId: string, taskId: string): Promise<IrreversibleActionRow[]> {
  const rows = await withTenant<IrreversibleActionRow[]>(userId, async (q) =>
    (
      await q.query<IrreversibleActionRow>(
        `SELECT * FROM irreversible_actions WHERE task_id = $1 AND owner_id = $2 ORDER BY created_at`,
        [taskId, userId],
      )
    ).rows,
  );
  return rows;
}

/** Irreversible actions recorded AFTER a point in time (rewind guard). */
export async function irreversibleAfter(userId: string, taskId: string, since: Date): Promise<IrreversibleActionRow[]> {
  const rows = await listIrreversibleActions(userId, taskId);
  return rows.filter((r) => new Date(r.created_at).getTime() > since.getTime());
}