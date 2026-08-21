/**
 * Stage 26G — global kill switch.
 *
 * One kill_switch row per (owner, scope). GLOBAL overrides every scope.
 * Scopes: GLOBAL / AGENTS / TASKS / SCHEDULES / AUTONOMY. The gate is
 * `assertAutonomyEnabled` — it throws `autonomy_suspended` when the matching
 * scope (or GLOBAL) is active. It is called at the entry points of new work
 * (task creation, agent run start, schedule creation, automation creation).
 * It stops NEW work — running work is not force-killed (honest semantics).
 */
import { queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType, KillSwitchScope } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';

export const KILL_SWITCH_SCOPES = Object.values(KillSwitchScope) as string[];

export interface KillSwitchRow {
  id: string;
  owner_id: string;
  scope: string;
  active: boolean;
  reason: string | null;
  triggered_by: string;
  created_at: Date;
  updated_at: Date;
}

/** Is work suspended for this scope (or globally)? */
export async function killSwitchActive(userId: string, scope: string): Promise<boolean> {
  const rows = await queryMany<KillSwitchRow>(
    'SELECT * FROM kill_switch WHERE owner_id = $1 AND scope IN ($2,$3)',
    [userId, KillSwitchScope.GLOBAL, scope],
  );
  return rows.some((r) => r.active);
}

/** Throw unless work is allowed for this scope. Never throws for unknown
 * tables (no rows = allowed). */
export async function assertAutonomyEnabled(userId: string, scope: string): Promise<void> {
  const active = await killSwitchActive(userId, scope);
  if (!active) return;
  throw AppError.forbidden(
    'autonomy_suspended',
    scope === KillSwitchScope.GLOBAL
      ? 'All autonomous work is suspended by the global kill switch'
      : `Autonomous work in scope ${scope} is suspended by the kill switch`,
  );
}

/** Toggle a kill switch scope. Audits + notifies on activation. */
export async function setKillSwitch(
  userId: string,
  scope: string,
  active: boolean,
  reason?: string,
): Promise<KillSwitchRow> {
  if (!KILL_SWITCH_SCOPES.includes(scope)) {
    throw AppError.badRequest('invalid_kill_switch_scope', `Unknown scope ${scope}`);
  }
  const existing = await queryMany<KillSwitchRow>('SELECT * FROM kill_switch WHERE owner_id = $1 AND scope = $2', [
    userId,
    scope,
  ]);
  const id = existing[0]?.id ?? newId(PREFIX.KILL_SWITCH);
  await dbUpsert(userId, scope, active, reason ?? null, id, existing[0]?.active ?? false);
  await recordAudit({
    action: AuditAction.KILL_SWITCH_TOGGLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'kill_switch',
    resourceId: id,
    detail: { scope, active, reason: reason ?? null },
  });
  if (active) {
    await notify(userId, NotificationType.KILL_SWITCH_ACTIVATED, 'Kill switch activated', {
      body: `Autonomous work in scope ${scope} is now suspended${reason ? `: ${reason}` : ''}`,
      resourceType: 'kill_switch',
      resourceId: id,
      metadata: { scope },
    }).catch(() => undefined);
  }
  return (await queryMany<KillSwitchRow>('SELECT * FROM kill_switch WHERE owner_id = $1 AND scope = $2', [userId, scope]))[0]!;
}

async function dbUpsert(
  userId: string,
  scope: string,
  active: boolean,
  reason: string | null,
  id: string,
  prevActive: boolean,
): Promise<void> {
  const { pool } = await import('../../shared/db.js');
  await pool.query(
    `INSERT INTO kill_switch (id, owner_id, scope, active, reason, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_id, scope)
     DO UPDATE SET active = EXCLUDED.active, reason = EXCLUDED.reason, updated_at = now()`,
    [id, userId, scope, active, reason, userId],
  );
  void prevActive;
}

/** Status of every scope for the user (always returns all scopes). */
export async function killSwitchStatus(userId: string): Promise<Array<KillSwitchRow & { suspended: boolean }>> {
  const rows = await queryMany<KillSwitchRow>('SELECT * FROM kill_switch WHERE owner_id = $1', [userId]);
  const globalActive = rows.some((r) => r.scope === KillSwitchScope.GLOBAL && r.active);
  return KILL_SWITCH_SCOPES.map((scope) => {
    const row = rows.find((r) => r.scope === scope);
    return {
      id: row?.id ?? '',
      owner_id: userId,
      scope,
      active: Boolean(row?.active),
      reason: row?.reason ?? null,
      triggered_by: row?.triggered_by ?? '',
      created_at: row?.created_at ?? new Date(0),
      updated_at: row?.updated_at ?? new Date(0),
      suspended: globalActive || Boolean(row?.active),
    };
  });
}