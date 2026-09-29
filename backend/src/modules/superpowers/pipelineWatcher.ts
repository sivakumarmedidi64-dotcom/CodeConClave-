/**
 * CodeConClave — Superpowers: PIPELINE WATCHER (Feature #126).
 *
 * Every ETL/data job: freshness SLAs, silent failures, schema changes upstream,
 * volume anomalies.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PipelineWatcherRunRow {
  id: string;
  owner_id: string;
  pipeline_name: string;
  sla_minutes: number;
  anomalies: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PipelineWatcherRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  pipeline_name: String(r.pipeline_name),
  sla_minutes: Number(r.sla_minutes ?? 0),
  anomalies: Array.isArray(r.anomalies) ? (r.anomalies as string[]) : [],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createPipelineWatcherRun(userId: string, input: { pipeline_name: string; sla_minutes: number }): Promise<PipelineWatcherRunRow> {
  if (!input.pipeline_name || typeof input.pipeline_name !== 'string') throw AppError.badRequest('invalid_pipeline_name', 'pipeline name is required');
  if (typeof input.sla_minutes !== 'number' || input.sla_minutes <= 0) throw AppError.badRequest('invalid_sla_minutes', 'SLA minutes must be a positive number');
  const id = newId(PREFIX.PIPELINE_WATCHER);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO pipeline_watcher_runs (id, owner_id, pipeline_name, sla_minutes, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.pipeline_name, input.sla_minutes, 'RUNNING'],
  ));
  await recordAudit({
    action: AuditAction.PIPELINE_ANOMALY_DETECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pipeline_watcher_runs',
    resourceId: id,
    detail: { pipeline_name: input.pipeline_name },
  });
  return getPipelineWatcherRun(userId, id);
}

export async function detectPipelineAnomaly(userId: string, id: string, input: { anomalies: string[] }): Promise<PipelineWatcherRunRow> {
  await getPipelineWatcherRun(userId, id);
  if (!input.anomalies || input.anomalies.length === 0) throw AppError.badRequest('invalid_anomalies', 'at least one anomaly is required');
  await withTenant(userId, (q) => q.query(
    'UPDATE pipeline_watcher_runs SET anomalies = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.anomalies, 'ANOMALY_DETECTED', userId],
  ));
  await recordAudit({
    action: AuditAction.PIPELINE_ANOMALY_DETECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pipeline_watcher_runs',
    resourceId: id,
    detail: { anomalies: input.anomalies },
  });
  return getPipelineWatcherRun(userId, id);
}

export async function flagSlaViolation(userId: string, id: string, input: { anomalies: string[] }): Promise<PipelineWatcherRunRow> {
  await getPipelineWatcherRun(userId, id);
  if (!input.anomalies || input.anomalies.length === 0) throw AppError.badRequest('invalid_anomalies', 'at least one anomaly is required for SLA flag');
  await withTenant(userId, (q) => q.query(
    'UPDATE pipeline_watcher_runs SET anomalies = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.anomalies, 'SLA_FLAGGED', userId],
  ));
  await recordAudit({
    action: AuditAction.PIPELINE_SLA_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pipeline_watcher_runs',
    resourceId: id,
    detail: { anomalies: input.anomalies },
  });
  return getPipelineWatcherRun(userId, id);
}

export async function getPipelineWatcherRun(userId: string, id: string): Promise<PipelineWatcherRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pipeline_watcher_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('pipeline_watcher_run_not_found', 'no pipeline watcher run found for that id');
  return rowOf(row);
}

export async function listPipelineWatcherRuns(userId: string): Promise<PipelineWatcherRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pipeline_watcher_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function pipelineWatcherReport(userId: string): Promise<{ runs: number; running: number; anomaly_detected: number; sla_flagged: number }> {
  const runs = await listPipelineWatcherRuns(userId);
  return {
    runs: runs.length,
    running: runs.filter((r) => r.status === 'RUNNING').length,
    anomaly_detected: runs.filter((r) => r.status === 'ANOMALY_DETECTED').length,
    sla_flagged: runs.filter((r) => r.status === 'SLA_FLAGGED').length,
  };
}
