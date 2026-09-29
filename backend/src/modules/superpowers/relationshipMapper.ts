/**
 * CodeConClave — Superpowers: RELATIONSHIP MAPPER (#129).
 *
 * Visualizes all data relationships in real time—foreign keys, soft refs,
 * eventual consistency patterns. Data model becomes a navigable graph.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RelationshipMapRow {
  id: string;
  owner_id: string;
  source_table: string;
  target_table: string;
  relationship_type: string;
  column_mapping: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): RelationshipMapRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_table: String(r.source_table),
  target_table: String(r.target_table),
  relationship_type: String(r.relationship_type),
  column_mapping: Array.isArray(r.column_mapping) ? (r.column_mapping as string[]) : [],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createRelationshipMap(userId: string, input: { source_table: string; target_table: string; relationship_type: string; column_mapping: string[] }): Promise<RelationshipMapRow> {
  if (!input.source_table || typeof input.source_table !== 'string') throw AppError.badRequest('invalid_source', 'a source table is required');
  if (!input.target_table || typeof input.target_table !== 'string') throw AppError.badRequest('invalid_target', 'a target table is required');
  if (!input.relationship_type || typeof input.relationship_type !== 'string') throw AppError.badRequest('invalid_type', 'a relationship type is required');
  if (!Array.isArray(input.column_mapping) || input.column_mapping.length === 0) throw AppError.badRequest('no_mapping', 'at least one column mapping is required');
  const id = newId(PREFIX.RELATIONSHIP_MAP);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO relationship_maps (id, owner_id, source_table, target_table, relationship_type, column_mapping, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.source_table, input.target_table, input.relationship_type, input.column_mapping, 'MAPPED'],
  ));
  await recordAudit({
    action: AuditAction.RELATIONSHIP_MAP_RENDERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'relationship_maps',
    resourceId: id,
    detail: { source_table: input.source_table, target_table: input.target_table },
  });
  return getRelationshipMap(userId, id);
}

export async function verifyRelationshipMap(userId: string, id: string): Promise<RelationshipMapRow> {
  const map = await getRelationshipMap(userId, id);
  if (map.status === 'VERIFIED') throw AppError.badRequest('already_verified', 'relationship map is already verified');
  await withTenant(userId, (q) => q.query(
    'UPDATE relationship_maps SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'VERIFIED', userId],
  ));
  return getRelationshipMap(userId, id);
}

export async function getRelationshipMap(userId: string, id: string): Promise<RelationshipMapRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM relationship_maps WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('relationship_map_not_found', 'no relationship map found for that id');
  return rowOf(row);
}

export async function listRelationshipMaps(userId: string): Promise<RelationshipMapRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM relationship_maps WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function relationshipMapReport(userId: string): Promise<{ total: number; mapped: number; verified: number }> {
  const rows = await listRelationshipMaps(userId);
  return {
    total: rows.length,
    mapped: rows.filter((r) => r.status === 'MAPPED').length,
    verified: rows.filter((r) => r.status === 'VERIFIED').length,
  };
}
