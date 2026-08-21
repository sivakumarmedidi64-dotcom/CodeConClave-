/**
 * Stage 26G — undo, but only for genuinely reversible operations.
 *
 * An undo entry is created ONLY by subsystems that can prove the operation is
 * reversible: they pass a payload describing exactly how to revert. Unknown or
 * non-reversible action types are refused at record time (`undo_not_reversible`).
 * Supported reversible kinds:
 *   - kill_switch_toggle  (payload: scope, prevActive, reason)
 *   - policy_toggle       (payload: scope, action, riskLevel, requirement, prevEnabled)
 *   - plugin_scope_change  (payload: connectionId, prevScopes)
 */
import { queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';

export const UNDOABLE_KINDS = ['kill_switch_toggle', 'policy_toggle', 'plugin_scope_change'] as const;
export type UndoableKind = (typeof UNDOABLE_KINDS)[number];

export interface UndoLogRow {
  id: string;
  owner_id: string;
  action_type: string;
  description: string;
  undo_payload: Record<string, unknown>;
  status: 'AVAILABLE' | 'UNDONE' | 'EXPIRED';
  undone_at: string | null;
  created_at: Date;
}

export async function listUndoable(userId: string): Promise<UndoLogRow[]> {
  return queryMany<UndoLogRow>('SELECT * FROM undo_log WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100', [
    userId,
  ]);
}

export async function recordUndoable(
  userId: string,
  input: { actionType: UndoableKind; description: string; payload: Record<string, unknown> },
): Promise<UndoLogRow> {
  if (!UNDOABLE_KINDS.includes(input.actionType)) {
    throw AppError.badRequest('undo_not_reversible', `"${input.actionType}" is not a reversible operation`);
  }
  if (!input.description?.trim()) {
    throw AppError.badRequest('undo_description_required', 'A description is required');
  }
  const id = newId(PREFIX.UNDO);
  const { pool } = await import('../../shared/db.js');
  await pool.query(
    `INSERT INTO undo_log (id, owner_id, action_type, description, undo_payload, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,'AVAILABLE')`,
    [id, userId, input.actionType, input.description.trim(), JSON.stringify(input.payload)],
  );
  await recordAudit({
    action: AuditAction.UNDO_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'undo_log',
    resourceId: id,
    detail: { actionType: input.actionType },
  });
  return (await queryMany<UndoLogRow>('SELECT * FROM undo_log WHERE id = $1', [id]))[0]!;
}

/** Revert an undoable action. Only AVAILABLE entries can be undone. */
export async function undoAction(userId: string, undoId: string): Promise<UndoLogRow> {
  const rows = await queryMany<UndoLogRow>('SELECT * FROM undo_log WHERE id = $1 AND owner_id = $2', [undoId, userId]);
  const entry = rows[0];
  if (!entry) throw AppError.notFound('Undo entry');
  if (entry.status !== 'AVAILABLE') {
    throw AppError.conflict('undo_not_available', `Undo entry is ${entry.status}`);
  }
  const payload = entry.undo_payload;
  try {
    await revert(entry.action_type, payload, userId);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.conflict('undo_failed', `Could not revert: ${(err as Error).message}`);
  }
  const { pool } = await import('../../shared/db.js');
  await pool.query(
    `UPDATE undo_log SET status = 'UNDONE', undone_at = now() WHERE id = $1 AND owner_id = $2`,
    [undoId, userId],
  );
  await recordAudit({
    action: AuditAction.UNDO_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'undo_log',
    resourceId: undoId,
    detail: { actionType: entry.action_type },
  });
  return (await queryMany<UndoLogRow>('SELECT * FROM undo_log WHERE id = $1', [undoId]))[0]!;
}

async function revert(kind: string, payload: Record<string, unknown>, userId: string): Promise<void> {
  switch (kind) {
    case 'kill_switch_toggle': {
      const { setKillSwitch } = await import('./killSwitch.js');
      const scope = String(payload.scope ?? '');
      const prevActive = Boolean(payload.prevActive);
      await setKillSwitch(userId, scope, prevActive, String(payload.reason ?? null));
      return;
    }
    case 'policy_toggle': {
      const { upsertControlPolicy } = await import('./policies.js');
      await upsertControlPolicy(userId, {
        scope: String(payload.scope ?? ''),
        action: String(payload.action ?? ''),
        riskLevel: String(payload.riskLevel ?? 'MEDIUM'),
        requirement: String(payload.requirement ?? 'require_approval'),
        enabled: Boolean(payload.prevEnabled),
      });
      return;
    }
    case 'plugin_scope_change': {
      const { updateConnectionScopes } = await import('../plugins/health.js');
      await updateConnectionScopes(userId, String(payload.connectionId ?? ''), (payload.prevScopes as string[]) ?? []);
      return;
    }
    default:
      throw AppError.conflict('undo_not_reversible', `"${kind}" is not a reversible operation`);
  }
}