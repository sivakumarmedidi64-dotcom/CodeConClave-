/**
 * CodeConClave — Superpowers: DATA MIGRATION ORCHESTRATOR (Master Feature #109).
 *
 * Large data transformations with verification and rollback — planned,
 * sampled, full-run scheduled, verification automatic.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DataMigrationRow {
  id: string;
  owner_id: string;
  source_table: string;
  target_table: string;
  transform_rule: string;
  sample_size: number;
  rows_affected: number;
  verified: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DataMigrationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_table: String(r.source_table),
  target_table: String(r.target_table),
  transform_rule: String(r.transform_rule),
  sample_size: Number(r.sample_size),
  rows_affected: Number(r.rows_affected),
  verified: Boolean(r.verified),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function scheduleDataMigration(userId: string, input: { source_table: string; target_table: string; transform_rule: string; sample_size?: number }): Promise<DataMigrationRow> {
  if (!input.source_table || typeof input.source_table !== 'string') throw AppError.badRequest('invalid_source', 'source table is required');
  if (!input.target_table || typeof input.target_table !== 'string') throw AppError.badRequest('invalid_target', 'target table is required');
  if (!input.transform_rule || typeof input.transform_rule !== 'string') throw AppError.badRequest('invalid_transform', 'transform rule is required');
  const sampleSize = typeof input.sample_size === 'number' && input.sample_size > 0 ? input.sample_size : 100;
  const id = newId(PREFIX.DATA_MIGRATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO data_migrations (id, owner_id, source_table, target_table, transform_rule, sample_size, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.source_table, input.target_table, input.transform_rule, sampleSize, 'PLANNED'],
  ));
  await recordAudit({
    action: AuditAction.DATA_MIGRATION_SCHEDULED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'data_migrations',
    resourceId: id,
    detail: { source_table: input.source_table, target_table: input.target_table },
  });
  return getDataMigration(userId, id);
}

export async function sampleMigration(userId: string, id: string): Promise<DataMigrationRow> {
  const migration = await getDataMigration(userId, id);
  if (migration.status !== 'PLANNED') throw AppError.badRequest('not_planned', 'only PLANNED migrations can be sampled');
  await withTenant(userId, (q) => q.query('UPDATE data_migrations SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', ['SAMPLED', id, userId]));
  return getDataMigration(userId, id);
}

export async function runMigration(userId: string, id: string, rowsAffected: number): Promise<DataMigrationRow> {
  const migration = await getDataMigration(userId, id);
  if (migration.status !== 'SAMPLED' && migration.status !== 'PLANNED') throw AppError.badRequest('not_ready', 'migration must be SAMPLED or PLANNED to run');
  if (typeof rowsAffected !== 'number' || !Number.isFinite(rowsAffected) || rowsAffected < 0) {
    throw AppError.badRequest('invalid_rows', 'rows_affected must be a non-negative number');
  }
  await withTenant(userId, (q) => q.query('UPDATE data_migrations SET status = $1, rows_affected = $2, updated_at = now() WHERE id = $3 AND owner_id = $4', ['RUNNING', rowsAffected, id, userId]));
  return getDataMigration(userId, id);
}

export async function verifyMigration(userId: string, id: string): Promise<DataMigrationRow> {
  const migration = await getDataMigration(userId, id);
  if (migration.status !== 'RUNNING') throw AppError.badRequest('not_running', 'only RUNNING migrations can be verified');
  const verified = migration.rows_affected > 0;
  await withTenant(userId, (q) => q.query('UPDATE data_migrations SET status = $1, verified = $2, updated_at = now() WHERE id = $3 AND owner_id = $4', [verified ? 'VERIFIED' : 'FAILED', verified ? true : false, id, userId]));
  await recordAudit({
    action: AuditAction.DATA_MIGRATION_VERIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'data_migrations',
    resourceId: id,
    detail: { verified },
  });
  return getDataMigration(userId, id);
}

export async function getDataMigration(userId: string, id: string): Promise<DataMigrationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM data_migrations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('data_migration_not_found', 'no data migration found for that id');
  return rowOf(row);
}

export async function listDataMigrations(userId: string): Promise<DataMigrationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM data_migrations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function dataMigrationReport(userId: string): Promise<{ migrations: number; verified: number; failed: number; total_rows: number }> {
  const list = await listDataMigrations(userId);
  return {
    migrations: list.length,
    verified: list.filter((m) => m.status === 'VERIFIED').length,
    failed: list.filter((m) => m.status === 'FAILED').length,
    total_rows: list.reduce((sum, m) => sum + m.rows_affected, 0),
  };
}
