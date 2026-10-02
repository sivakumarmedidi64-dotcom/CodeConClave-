/**
 * CodeConClave — recovery history (Stage 26E).
 * Append-only, tenant-scoped timeline of every recovery event for a task:
 * checkpoints, pauses, resumes, rewinds, branches, autopsies, remediations,
 * irreversible actions, retries. Never mutated after write — historical events
 * are immutable; time travel always produces NEW events and NEW state.
 */
import { withTenant, withSystem, queryMany, pool } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { RecoveryEventType } from '@codeconclave/shared';

export interface RecoveryHistoryRow {
  id: string;
  task_id: string;
  owner_id: string;
  event: string;
  detail: unknown;
  actor: string | null;
  created_at: Date;
}

export type RecoveryEvent = (typeof RecoveryEventType)[keyof typeof RecoveryEventType];

/** Write one immutable recovery event. Never throws into callers (best-effort). */
export async function recordRecoveryHistory(
  taskId: string,
  ownerId: string,
  event: RecoveryEvent,
  detail: Record<string, unknown> = {},
  actor: string | null = null,
): Promise<RecoveryHistoryRow> {
  const row: RecoveryHistoryRow = {
    id: newId(PREFIX.RECOVERY_HISTORY),
    task_id: taskId,
    owner_id: ownerId,
    event,
    detail,
    actor,
    created_at: new Date(),
  };
  await withTenant(ownerId, (q) => q.query(
    `INSERT INTO recovery_history (id, task_id, owner_id, event, detail, actor)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [row.id, taskId, ownerId, event, JSON.stringify(detail), actor],
  ));
  return row;
}

/** Tenant-scoped timeline for the recovery-aware history UI / API. */
export async function listRecoveryHistory(userId: string, taskId: string): Promise<RecoveryHistoryRow[]> {
  return withTenant<RecoveryHistoryRow[]>(userId, async (q) =>
    (
      await q.query<RecoveryHistoryRow>(
        `SELECT * FROM recovery_history WHERE task_id = $1 AND owner_id = $2 ORDER BY created_at`,
        [taskId, userId],
      )
    ).rows,
  );
}

/** Internal (unscoped) timeline used by autopsies and audits. */
export async function listRecoveryHistoryInternal(taskId: string): Promise<RecoveryHistoryRow[]> {
  return withSystem<RecoveryHistoryRow[]>(async (q) =>
    (
      await q.query<RecoveryHistoryRow>(
        `SELECT * FROM recovery_history WHERE task_id = $1 ORDER BY created_at`,
        [taskId],
      )
    ).rows,
  );
}

export { RecoveryEventType };