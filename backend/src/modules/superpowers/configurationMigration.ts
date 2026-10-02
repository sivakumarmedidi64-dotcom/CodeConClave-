/**
 * CodeConClave — Superpowers: CONFIGURATION MIGRATION (Master Feature #110).
 *
 * Refactors config systems (env vars → secrets manager → config service)
 * incrementally, traffic split gradually.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ConfigMigrationRow {
  id: string;
  owner_id: string;
  source_type: string;
  target_type: string;
  config_keys: string[];
  traffic_split_pct: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ConfigMigrationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_type: String(r.source_type),
  target_type: String(r.target_type),
  config_keys: Array.isArray(r.config_keys) ? r.config_keys as string[] : [],
  traffic_split_pct: Number(r.traffic_split_pct),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function startConfigMigration(userId: string, input: { source_type: string; target_type: string; config_keys?: string[] }): Promise<ConfigMigrationRow> {
  if (!input.source_type || typeof input.source_type !== 'string') throw AppError.badRequest('invalid_source', 'source type is required');
  if (!input.target_type || typeof input.target_type !== 'string') throw AppError.badRequest('invalid_target', 'target type is required');
  if (input.source_type === input.target_type) throw AppError.badRequest('same_type', 'source and target types must differ');
  const keys = input.config_keys ?? [];
  const id = newId(PREFIX.CONFIG_MIGRATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO config_migrations (id, owner_id, source_type, target_type, config_keys, traffic_split_pct, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.source_type, input.target_type, JSON.stringify(keys), 0, 'MIGRATING'],
  ));
  await recordAudit({
    action: AuditAction.CONFIG_MIGRATION_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'config_migrations',
    resourceId: id,
    detail: { source_type: input.source_type, target_type: input.target_type },
  });
  return getConfigMigration(userId, id);
}

export async function advanceTrafficSplit(userId: string, id: string, pct: number): Promise<ConfigMigrationRow> {
  const migration = await getConfigMigration(userId, id);
  if (migration.status !== 'MIGRATING') throw AppError.badRequest('not_migrating', 'only MIGRATING migrations can advance traffic');
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw AppError.badRequest('invalid_pct', 'traffic split must be between 0 and 100');
  }
  await withTenant(userId, (q) => q.query('UPDATE config_migrations SET traffic_split_pct = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', [pct, id, userId]));
  return getConfigMigration(userId, id);
}

export async function completeConfigMigration(userId: string, id: string): Promise<ConfigMigrationRow> {
  const migration = await getConfigMigration(userId, id);
  if (migration.status !== 'MIGRATING') throw AppError.badRequest('not_migrating', 'only MIGRATING migrations can be completed');
  if (migration.traffic_split_pct < 100) throw AppError.badRequest('traffic_not_full', 'traffic split must be 100% before completing');
  await withTenant(userId, (q) => q.query('UPDATE config_migrations SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', ['COMPLETED', id, userId]));
  await recordAudit({
    action: AuditAction.CONFIG_MIGRATION_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'config_migrations',
    resourceId: id,
    detail: { source_type: migration.source_type, target_type: migration.target_type },
  });
  return getConfigMigration(userId, id);
}

export async function getConfigMigration(userId: string, id: string): Promise<ConfigMigrationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM config_migrations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('config_migration_not_found', 'no config migration found for that id');
  return rowOf(row);
}

export async function listConfigMigrations(userId: string): Promise<ConfigMigrationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM config_migrations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function configMigrationReport(userId: string): Promise<{ migrations: number; migrating: number; completed: number }> {
  const list = await listConfigMigrations(userId);
  return {
    migrations: list.length,
    migrating: list.filter((m) => m.status === 'MIGRATING').length,
    completed: list.filter((m) => m.status === 'COMPLETED').length,
  };
}
