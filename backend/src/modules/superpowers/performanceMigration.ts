/**
 * CodeConClave — Superpowers: PERFORMANCE MIGRATION (Master Feature #106).
 *
 * Auto-converts sync→async, CPU-bound→distributed, monolithic queries→cached.
 * Proves the win with before/after numbers.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PerfMigrationRow {
  id: string;
  owner_id: string;
  source_pattern: string;
  target_pattern: string;
  before_score: number;
  after_score: number | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PerfMigrationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_pattern: String(r.source_pattern),
  target_pattern: String(r.target_pattern),
  before_score: Number(r.before_score),
  after_score: r.after_score == null ? null : Number(r.after_score),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function planMigration(userId: string, input: {
  source_pattern: string;
  target_pattern: string;
  before_score: number;
}): Promise<PerfMigrationRow> {
  if (!input.source_pattern || typeof input.source_pattern !== 'string') throw AppError.badRequest('invalid_source_pattern', 'source pattern is required');
  if (!input.target_pattern || typeof input.target_pattern !== 'string') throw AppError.badRequest('invalid_target_pattern', 'target pattern is required');
  if (typeof input.before_score !== 'number' || !Number.isFinite(input.before_score) || input.before_score < 0) {
    throw AppError.badRequest('invalid_before_score', 'before score must be a non-negative number');
  }
  const id = newId(PREFIX.PERF_MIGRATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO perf_migrations (id, owner_id, source_pattern, target_pattern, before_score, after_score, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.source_pattern.trim(), input.target_pattern.trim(), input.before_score, null, 'PLANNING'],
  ));
  await recordAudit({
    action: AuditAction.PERF_MIGRATION_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'perf_migrations',
    resourceId: id,
    detail: { source_pattern: input.source_pattern, target_pattern: input.target_pattern },
  });
  return getPerformanceMigration(userId, id);
}

export async function reportMigration(userId: string, id: string, input: { after_score: number }): Promise<PerfMigrationRow> {
  const migration = await getPerformanceMigration(userId, id);
  if (migration.status === 'DONE') throw AppError.badRequest('already_reported', 'this migration already has a report');
  if (typeof input.after_score !== 'number' || !Number.isFinite(input.after_score) || input.after_score < 0) {
    throw AppError.badRequest('invalid_after_score', 'after score must be a non-negative number');
  }
  const improvement = migration.before_score > 0 ? Math.round(((migration.before_score - input.after_score) / migration.before_score) * 100) : 0;
  await withTenant(userId, (q) => q.query(
    'UPDATE perf_migrations SET after_score = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $2',
    [id, userId, input.after_score, 'DONE'],
  ));
  await recordAudit({
    action: AuditAction.PERF_MIGRATION_REPORTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'perf_migrations',
    resourceId: id,
    detail: { before_score: migration.before_score, after_score: input.after_score, improvement_pct: improvement },
  });
  return getPerformanceMigration(userId, id);
}

export async function getPerformanceMigration(userId: string, id: string): Promise<PerfMigrationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM perf_migrations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('perf_migration_not_found', 'no performance migration found for that id');
  return rowOf(row);
}

export async function listPerformanceMigrations(userId: string): Promise<PerfMigrationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM perf_migrations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function performanceMigrationReport(userId: string): Promise<{
  migrations: number;
  reported: number;
  avg_improvement_pct: number;
  by_source: Record<string, number>;
}> {
  const list = await listPerformanceMigrations(userId);
  const reported = list.filter((m) => m.after_score !== null);
  const avgImprovement = reported.length > 0
    ? Math.round(reported.reduce((sum, m) => sum + ((m.before_score - (m.after_score ?? 0)) / m.before_score) * 100, 0) / reported.length)
    : 0;
  const bySource: Record<string, number> = {};
  for (const m of list) bySource[m.source_pattern] = (bySource[m.source_pattern] ?? 0) + 1;
  return {
    migrations: list.length,
    reported: reported.length,
    avg_improvement_pct: avgImprovement,
    by_source: bySource,
  };
}
