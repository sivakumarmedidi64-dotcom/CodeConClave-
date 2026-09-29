/**
 * CodeConClave — Superpowers: DATA DOCTOR (Feature #124).
 *
 * Continuously validates data integrity: orphaned rows, impossible states,
 * constraint drift, silent corruption.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DataDoctorScanRow {
  id: string;
  owner_id: string;
  scan_name: string;
  target_table: string;
  issues_found: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DataDoctorScanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  scan_name: String(r.scan_name),
  target_table: String(r.target_table),
  issues_found: Array.isArray(r.issues_found) ? (r.issues_found as string[]) : [],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createDataDoctorScan(userId: string, input: { scan_name: string; target_table: string }): Promise<DataDoctorScanRow> {
  if (!input.scan_name || typeof input.scan_name !== 'string') throw AppError.badRequest('invalid_scan_name', 'scan name is required');
  if (!input.target_table || typeof input.target_table !== 'string') throw AppError.badRequest('invalid_target_table', 'target table is required');
  const id = newId(PREFIX.DATA_DOCTOR);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO data_doctor_scans (id, owner_id, scan_name, target_table, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.scan_name, input.target_table, 'SCAN_RUN'],
  ));
  await recordAudit({
    action: AuditAction.DATA_DOCTOR_SCAN_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'data_doctor_scans',
    resourceId: id,
    detail: { scan_name: input.scan_name },
  });
  return getDataDoctorScan(userId, id);
}

export async function runDataDoctorScan(userId: string, id: string, input: { issues_found: string[] }): Promise<DataDoctorScanRow> {
  await getDataDoctorScan(userId, id);
  const status = input.issues_found && input.issues_found.length > 0 ? 'ISSUES_FLAGGED' : 'SCAN_RUN';
  await withTenant(userId, (q) => q.query(
    'UPDATE data_doctor_scans SET issues_found = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.issues_found ?? [], status, userId],
  ));
  await recordAudit({
    action: AuditAction.DATA_DOCTOR_SCAN_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'data_doctor_scans',
    resourceId: id,
    detail: { issues_count: (input.issues_found ?? []).length },
  });
  return getDataDoctorScan(userId, id);
}

export async function flagDataIssue(userId: string, id: string, input: { issues: string[] }): Promise<DataDoctorScanRow> {
  await getDataDoctorScan(userId, id);
  if (!input.issues || input.issues.length === 0) throw AppError.badRequest('invalid_issues', 'at least one issue is required to flag');
  await withTenant(userId, (q) => q.query(
    'UPDATE data_doctor_scans SET issues_found = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.issues, 'ISSUES_FLAGGED', userId],
  ));
  await recordAudit({
    action: AuditAction.DATA_ISSUE_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'data_doctor_scans',
    resourceId: id,
    detail: { issues: input.issues },
  });
  return getDataDoctorScan(userId, id);
}

export async function getDataDoctorScan(userId: string, id: string): Promise<DataDoctorScanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM data_doctor_scans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('data_doctor_scan_not_found', 'no data doctor scan found for that id');
  return rowOf(row);
}

export async function listDataDoctorScans(userId: string): Promise<DataDoctorScanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM data_doctor_scans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function dataDoctorReport(userId: string): Promise<{ scans: number; scan_run: number; issues_flagged: number }> {
  const scans = await listDataDoctorScans(userId);
  return {
    scans: scans.length,
    scan_run: scans.filter((s) => s.status === 'SCAN_RUN').length,
    issues_flagged: scans.filter((s) => s.status === 'ISSUES_FLAGGED').length,
  };
}
