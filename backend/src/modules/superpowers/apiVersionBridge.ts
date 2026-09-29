/**
 * CodeConClave — Superpowers: API VERSION BRIDGE (Master Feature #108).
 *
 * Safely evolves APIs supporting multiple versions concurrently; old API
 * proxies to new internally, deprecation windows managed.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ApiVersionBridgeRow {
  id: string;
  owner_id: string;
  old_version: string;
  new_version: string;
  endpoint: string;
  mapping: string[];
  deprecation_date: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ApiVersionBridgeRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  old_version: String(r.old_version),
  new_version: String(r.new_version),
  endpoint: String(r.endpoint),
  mapping: Array.isArray(r.mapping) ? r.mapping as string[] : [],
  deprecation_date: r.deprecation_date == null ? null : String(r.deprecation_date),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createApiBridge(userId: string, input: { old_version: string; new_version: string; endpoint: string; mapping?: string[] }): Promise<ApiVersionBridgeRow> {
  if (!input.old_version || typeof input.old_version !== 'string') throw AppError.badRequest('invalid_old_version', 'old version is required');
  if (!input.new_version || typeof input.new_version !== 'string') throw AppError.badRequest('invalid_new_version', 'new version is required');
  if (!input.endpoint || typeof input.endpoint !== 'string') throw AppError.badRequest('invalid_endpoint', 'endpoint is required');
  if (input.old_version === input.new_version) throw AppError.badRequest('same_version', 'old and new versions must differ');
  const mapping = input.mapping ?? [];
  const id = newId(PREFIX.API_VERSION_BRIDGE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO api_version_bridges (id, owner_id, old_version, new_version, endpoint, mapping, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.old_version, input.new_version, input.endpoint, JSON.stringify(mapping), 'ACTIVE'],
  ));
  await recordAudit({
    action: AuditAction.API_BRIDGE_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'api_version_bridges',
    resourceId: id,
    detail: { old_version: input.old_version, new_version: input.new_version, endpoint: input.endpoint },
  });
  return getApiBridge(userId, id);
}

export async function deprecateVersion(userId: string, id: string): Promise<ApiVersionBridgeRow> {
  const bridge = await getApiBridge(userId, id);
  if (bridge.status !== 'ACTIVE') throw AppError.badRequest('not_active', 'only ACTIVE bridges can be deprecated');
  const now = new Date().toISOString();
  await withTenant(userId, (q) => q.query('UPDATE api_version_bridges SET status = $1, deprecation_date = $2, updated_at = now() WHERE id = $3 AND owner_id = $4', ['DEPRECATED', now, id, userId]));
  await recordAudit({
    action: AuditAction.API_VERSION_DEPRECATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'api_version_bridges',
    resourceId: id,
    detail: { old_version: bridge.old_version, new_version: bridge.new_version },
  });
  return getApiBridge(userId, id);
}

export async function getApiBridge(userId: string, id: string): Promise<ApiVersionBridgeRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM api_version_bridges WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('api_bridge_not_found', 'no API bridge found for that id');
  return rowOf(row);
}

export async function listApiBridges(userId: string): Promise<ApiVersionBridgeRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM api_version_bridges WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function apiBridgeReport(userId: string): Promise<{ bridges: number; active: number; deprecated: number }> {
  const list = await listApiBridges(userId);
  return {
    bridges: list.length,
    active: list.filter((b) => b.status === 'ACTIVE').length,
    deprecated: list.filter((b) => b.status === 'DEPRECATED').length,
  };
}
