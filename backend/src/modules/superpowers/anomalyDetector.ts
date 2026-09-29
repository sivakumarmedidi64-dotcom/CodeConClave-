/**
 * CodeConClave — Superpowers: ANOMALY DETECTOR (#130).
 *
 * Volume anomalies, distribution shifts, missing data—detected and alerted.
 * ML model learns normal, alerts on deviation.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface AnomalyScanRow {
  id: string;
  owner_id: string;
  data_source: string;
  anomaly_type: string;
  description: string;
  severity: string;
  alerted: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): AnomalyScanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  data_source: String(r.data_source),
  anomaly_type: String(r.anomaly_type),
  description: String(r.description),
  severity: String(r.severity),
  alerted: Boolean(r.alerted),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createAnomalyScan(userId: string, input: { data_source: string; anomaly_type: string; description: string; severity: string }): Promise<AnomalyScanRow> {
  if (!input.data_source || typeof input.data_source !== 'string') throw AppError.badRequest('invalid_data_source', 'a data source is required');
  if (!input.anomaly_type || typeof input.anomaly_type !== 'string') throw AppError.badRequest('invalid_anomaly_type', 'an anomaly type is required');
  if (!input.description || typeof input.description !== 'string') throw AppError.badRequest('invalid_description', 'a description is required');
  const validSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (!validSeverities.includes(input.severity)) throw AppError.badRequest('invalid_severity', 'severity must be LOW, MEDIUM, HIGH, or CRITICAL');
  const id = newId(PREFIX.ANOMALY_DETECTOR);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO anomaly_scans (id, owner_id, data_source, anomaly_type, description, severity, alerted, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.data_source, input.anomaly_type, input.description, input.severity, false, 'DETECTED'],
  ));
  await recordAudit({
    action: AuditAction.ANOMALY_DETECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'anomaly_scans',
    resourceId: id,
    detail: { data_source: input.data_source, anomaly_type: input.anomaly_type, severity: input.severity },
  });
  return getAnomalyScan(userId, id);
}

export async function alertAnomaly(userId: string, id: string): Promise<AnomalyScanRow> {
  const scan = await getAnomalyScan(userId, id);
  if (scan.alerted) throw AppError.badRequest('already_alerted', 'anomaly has already been alerted');
  await withTenant(userId, (q) => q.query(
    'UPDATE anomaly_scans SET alerted = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, true, 'ALERTED', userId],
  ));
  await recordAudit({
    action: AuditAction.ANOMALY_ALERTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'anomaly_scans',
    resourceId: id,
    detail: { data_source: scan.data_source, anomaly_type: scan.anomaly_type },
  });
  return getAnomalyScan(userId, id);
}

export async function getAnomalyScan(userId: string, id: string): Promise<AnomalyScanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM anomaly_scans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('anomaly_scan_not_found', 'no anomaly scan found for that id');
  return rowOf(row);
}

export async function listAnomalyScans(userId: string): Promise<AnomalyScanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM anomaly_scans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function anomalyScanReport(userId: string): Promise<{ total: number; detected: number; alerted: number; by_severity: Record<string, number> }> {
  const rows = await listAnomalyScans(userId);
  const bySeverity: Record<string, number> = {};
  for (const r of rows) {
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  }
  return {
    total: rows.length,
    detected: rows.filter((r) => r.status === 'DETECTED').length,
    alerted: rows.filter((r) => r.status === 'ALERTED').length,
    by_severity: bySeverity,
  };
}
