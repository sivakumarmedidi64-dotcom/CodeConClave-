/**
 * CodeConClave — Superpowers: SCHEMA MIGRATION WIZARD (Master Feature #107).
 *
 * Database schema evolution made safe and reversible — expand, backfill,
 * contract cycles, all independently reversible.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface SchemaMigrationRow {
  id: string;
  owner_id: string;
  table_name: string;
  direction: string;
  sql_up: string;
  sql_down: string;
  status: string;
  rolled_back_at: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SchemaMigrationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  table_name: String(r.table_name),
  direction: String(r.direction),
  sql_up: String(r.sql_up),
  sql_down: String(r.sql_down),
  status: String(r.status),
  rolled_back_at: r.rolled_back_at == null ? null : String(r.rolled_back_at),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const DIRECTIONS = ['expand', 'backfill', 'contract'] as const;

export async function createSchemaMigration(userId: string, input: { table_name: string; direction: string; sql_up: string; sql_down: string }): Promise<SchemaMigrationRow> {
  if (!input.table_name || typeof input.table_name !== 'string') throw AppError.badRequest('invalid_table', 'table name is required');
  if (!DIRECTIONS.includes(input.direction as typeof DIRECTIONS[number])) throw AppError.badRequest('invalid_direction', 'direction must be expand, backfill, or contract');
  if (!input.sql_up || typeof input.sql_up !== 'string') throw AppError.badRequest('invalid_sql_up', 'sql_up is required');
  if (!input.sql_down || typeof input.sql_down !== 'string') throw AppError.badRequest('invalid_sql_down', 'sql_down is required');
  const id = newId(PREFIX.SCHEMA_MIGRATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO schema_migration_plans (id, owner_id, table_name, direction, sql_up, sql_down, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.table_name, input.direction, input.sql_up, input.sql_down, 'PLANNED'],
  ));
  await recordAudit({
    action: AuditAction.SCHEMA_MIGRATION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schema_migration_plans',
    resourceId: id,
    detail: { table_name: input.table_name, direction: input.direction },
  });
  return getSchemaMigration(userId, id);
}

export async function startExpansion(userId: string, id: string): Promise<SchemaMigrationRow> {
  const migration = await getSchemaMigration(userId, id);
  if (migration.status !== 'PLANNED') throw AppError.badRequest('not_planned', 'only PLANNED migrations can be started');
  await withTenant(userId, (q) => q.query('UPDATE schema_migration_plans SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', ['EXPANDING', id, userId]));
  return getSchemaMigration(userId, id);
}

export async function completeStep(userId: string, id: string): Promise<SchemaMigrationRow> {
  const migration = await getSchemaMigration(userId, id);
  if (migration.status === 'COMPLETED') throw AppError.badRequest('already_completed', 'migration is already completed');
  if (migration.status === 'ROLLED_BACK') throw AppError.badRequest('already_rolled_back', 'migration has been rolled back');
  const nextStatus: Record<string, string> = { EXPANDING: 'BACKFILLING', BACKFILLING: 'CONTRACTING', CONTRACTING: 'COMPLETED', PLANNED: 'EXPANDING' };
  const next = nextStatus[migration.status] ?? 'COMPLETED';
  await withTenant(userId, (q) => q.query('UPDATE schema_migration_plans SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', [next, id, userId]));
  return getSchemaMigration(userId, id);
}

export async function rollbackMigration(userId: string, id: string): Promise<SchemaMigrationRow> {
  const migration = await getSchemaMigration(userId, id);
  if (migration.status === 'COMPLETED') throw AppError.badRequest('already_completed', 'completed migrations cannot be rolled back');
  if (migration.status === 'ROLLED_BACK') throw AppError.badRequest('already_rolled_back', 'migration is already rolled back');
  await withTenant(userId, (q) => q.query('UPDATE schema_migration_plans SET status = $1, rolled_back_at = now(), updated_at = now() WHERE id = $2 AND owner_id = $3', ['ROLLED_BACK', id, userId]));
  await recordAudit({
    action: AuditAction.SCHEMA_MIGRATION_ROLLED_BACK,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schema_migration_plans',
    resourceId: id,
  });
  return getSchemaMigration(userId, id);
}

export async function getSchemaMigration(userId: string, id: string): Promise<SchemaMigrationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM schema_migration_plans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('schema_migration_not_found', 'no schema migration found for that id');
  return rowOf(row);
}

export async function listSchemaMigrations(userId: string): Promise<SchemaMigrationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM schema_migration_plans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function schemaMigrationReport(userId: string): Promise<{ migrations: number; planned: number; completed: number; rolled_back: number }> {
  const list = await listSchemaMigrations(userId);
  return {
    migrations: list.length,
    planned: list.filter((m) => m.status === 'PLANNED').length,
    completed: list.filter((m) => m.status === 'COMPLETED').length,
    rolled_back: list.filter((m) => m.status === 'ROLLED_BACK').length,
  };
}
