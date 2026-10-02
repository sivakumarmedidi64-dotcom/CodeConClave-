/**
 * CodeConClave — Superpowers: SCOPE BOUNCER (Master Feature #75).
 *
 * Detects scope creep mid-implementation and flags it with cost — "this adds
 * 2 migrations and a permission model — separate PR?" Keeps PRs atomic.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ScopeBounceRow {
  id: string;
  owner_id: string;
  title: string;
  planned_files: number;
  planned_migrations: number;
  flagged: number;
  cost: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ScopeBounceRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  title: String(r.title),
  planned_files: Number(r.planned_files),
  planned_migrations: Number(r.planned_migrations),
  flagged: Number(r.flagged),
  cost: String(r.cost),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

export async function openPrScope(userId: string, input: { title: string; planned_files?: number; planned_migrations?: number }): Promise<ScopeBounceRow> {
  if (!input.title || typeof input.title !== 'string') throw AppError.badRequest('invalid_title', 'a PR title is required');
  const id = newId(PREFIX.SCOPE_SESSION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO scope_bounces (id, owner_id, title, planned_files, planned_migrations, flagged, cost, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.title, n(input.planned_files), n(input.planned_migrations), 0, '', 'OPEN'],
  ));
  await recordAudit({
    action: AuditAction.SCOPE_OPENED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'scope_bounces',
    resourceId: id,
    detail: { title: input.title },
  });
  return getScopeSession(userId, id);
}

export async function checkScope(userId: string, id: string, input: { added_files?: number; added_migrations?: number; added_permissions?: number }): Promise<ScopeBounceRow> {
  const session = await getScopeSession(userId, id);
  if (session.status !== 'OPEN') throw AppError.badRequest('scope_settled', 'this PR scope is already settled');
  const addedFiles = n(input.added_files);
  const addedMigrations = n(input.added_migrations);
  const addedPermissions = n(input.added_permissions);
  if (addedFiles + addedMigrations + addedPermissions > 0) {
    const cost = `this adds ${addedMigrations} migration(s) and ${addedPermissions} permission model(s) across +${addedFiles} extra file(s) — separate PR?`;
    await withTenant(userId, (q) => q.query('UPDATE scope_bounces SET flagged = $2, cost = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, session.flagged + 1, cost, userId]));
    await recordAudit({
      action: AuditAction.SCOPE_CREEP_FLAGGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'scope_bounces',
      resourceId: id,
      detail: { added_files: addedFiles, added_migrations: addedMigrations, added_permissions: addedPermissions },
    });
  }
  return getScopeSession(userId, id);
}

export async function settleScope(userId: string, id: string): Promise<ScopeBounceRow> {
  const session = await getScopeSession(userId, id);
  if (session.status !== 'OPEN') throw AppError.badRequest('scope_settled', 'this PR scope is already settled');
  await withTenant(userId, (q) => q.query('UPDATE scope_bounces SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'SETTLED', userId]));
  await recordAudit({
    action: AuditAction.SCOPE_BOUNCE_SETTLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'scope_bounces',
    resourceId: id,
    detail: { flagged: session.flagged },
  });
  return getScopeSession(userId, id);
}

export async function getScopeSession(userId: string, id: string): Promise<ScopeBounceRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM scope_bounces WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('scope_bounce_not_found', 'no scope bounce session found for that id');
  return rowOf(row);
}

export async function listScopeSessions(userId: string): Promise<ScopeBounceRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM scope_bounces WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function scopeBouncerReport(userId: string): Promise<{ sessions: number; flagged: number; settled: number }> {
  const sessions = await listScopeSessions(userId);
  return {
    sessions: sessions.length,
    flagged: sessions.filter((s) => s.cost && s.flagged > 0).length,
    settled: sessions.filter((s) => s.status === 'SETTLED').length,
  };
}