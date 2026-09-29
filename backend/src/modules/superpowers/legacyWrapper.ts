/**
 * CodeConClave — Superpowers: LEGACY WRAPPER (Master Feature #104).
 *
 * Wraps legacy systems (COBOL, old APIs, mainframes) with modern
 * interfaces. Clean REST/GraphQL on top, old cruft underneath.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface LegacyWrapperRow {
  id: string;
  owner_id: string;
  legacy_system: string;
  interface_type: string;
  endpoint: string;
  status: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): LegacyWrapperRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  legacy_system: String(r.legacy_system),
  interface_type: String(r.interface_type),
  endpoint: String(r.endpoint),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
});

export async function createLegacyWrapper(userId: string, input: {
  legacy_system: string;
  interface_type: string;
  endpoint: string;
}): Promise<LegacyWrapperRow> {
  if (!input.legacy_system || typeof input.legacy_system !== 'string') throw AppError.badRequest('invalid_legacy_system', 'legacy system name is required');
  if (!input.interface_type || typeof input.interface_type !== 'string') throw AppError.badRequest('invalid_interface_type', 'interface type is required');
  if (!input.endpoint || typeof input.endpoint !== 'string') throw AppError.badRequest('invalid_endpoint', 'endpoint is required');
  const id = newId(PREFIX.LEGACY_WRAPPER);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO legacy_wrappers (id, owner_id, legacy_system, interface_type, endpoint, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.legacy_system.trim(), input.interface_type.trim(), input.endpoint.trim(), 'ACTIVE'],
  ));
  await recordAudit({
    action: AuditAction.LEGACY_WRAPPER_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'legacy_wrappers',
    resourceId: id,
    detail: { legacy_system: input.legacy_system, interface_type: input.interface_type },
  });
  return getLegacyWrapper(userId, id);
}

export async function getLegacyWrapper(userId: string, id: string): Promise<LegacyWrapperRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM legacy_wrappers WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('legacy_wrapper_not_found', 'no legacy wrapper found for that id');
  return rowOf(row);
}

export async function listLegacyWrappers(userId: string): Promise<LegacyWrapperRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM legacy_wrappers WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function legacyWrapperReport(userId: string): Promise<{
  wrappers: number;
  active: number;
  by_interface: Record<string, number>;
}> {
  const list = await listLegacyWrappers(userId);
  const byInterface: Record<string, number> = {};
  for (const w of list) byInterface[w.interface_type] = (byInterface[w.interface_type] ?? 0) + 1;
  return {
    wrappers: list.length,
    active: list.filter((w) => w.status === 'ACTIVE').length,
    by_interface: byInterface,
  };
}
