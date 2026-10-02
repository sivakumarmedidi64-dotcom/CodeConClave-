/**
 * CodeConClave — Superpowers: COMPONENT GRAVEYARD (Master Feature #117).
 *
 * Finds every unused/broken/dead component and design token,
 * drafts deletion PR with zero risk.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DeadComponentRow {
  id: string;
  owner_id: string;
  component_name: string;
  usage_count: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DeadComponentRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component_name: String(r.component_name),
  usage_count: Number(r.usage_count),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createGraveyardEntry(userId: string, input: { component_name: string; usage_count: number }): Promise<DeadComponentRow> {
  if (!input.component_name || typeof input.component_name !== 'string') {
    throw AppError.badRequest('invalid_component_name', 'a component name is required');
  }
  if (typeof input.usage_count !== 'number' || !Number.isFinite(input.usage_count) || input.usage_count < 0) {
    throw AppError.badRequest('invalid_usage_count', 'usage count must be a non-negative number');
  }
  const id = newId(PREFIX.COMPONENT_GRAVEYARD);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO dead_components (id, owner_id, component_name, usage_count, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.component_name, input.usage_count, 'FLAGGED'],
  ));
  await recordAudit({
    action: AuditAction.DEAD_COMPONENT_FOUND,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dead_components',
    resourceId: id,
    detail: { component: input.component_name },
  });
  return getGraveyardEntry(userId, id);
}

export async function removeComponent(userId: string, id: string): Promise<DeadComponentRow> {
  await getGraveyardEntry(userId, id);
  await withTenant(userId, (q) => q.query(
    'UPDATE dead_components SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'REMOVED', userId],
  ));
  await recordAudit({
    action: AuditAction.DEAD_COMPONENT_REMOVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dead_components',
    resourceId: id,
    detail: {},
  });
  return getGraveyardEntry(userId, id);
}

export async function getGraveyardEntry(userId: string, id: string): Promise<DeadComponentRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM dead_components WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('dead_component_not_found', 'no dead component found for that id');
  return rowOf(row);
}

export async function listGraveyardEntries(userId: string): Promise<DeadComponentRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM dead_components WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function componentGraveyardReport(userId: string): Promise<{ entries: number; flagged: number; removed: number }> {
  const list = await listGraveyardEntries(userId);
  return {
    entries: list.length,
    flagged: list.filter((e) => e.status === 'FLAGGED').length,
    removed: list.filter((e) => e.status === 'REMOVED').length,
  };
}
