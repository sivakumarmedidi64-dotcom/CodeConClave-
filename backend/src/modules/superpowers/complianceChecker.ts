/**
 * CodeConClave — Superpowers: COMPLIANCE CHECKER (#131).
 *
 * Every record audited for compliance: PII handling, retention policies,
 * consent tracking. Violations flagged with evidence.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ComplianceReportRow {
  id: string;
  owner_id: string;
  resource_type: string;
  violation_type: string;
  evidence: string;
  severity: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ComplianceReportRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  resource_type: String(r.resource_type),
  violation_type: String(r.violation_type),
  evidence: String(r.evidence),
  severity: String(r.severity),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createComplianceReport(userId: string, input: { resource_type: string; violation_type: string; evidence: string; severity: string }): Promise<ComplianceReportRow> {
  if (!input.resource_type || typeof input.resource_type !== 'string') throw AppError.badRequest('invalid_resource_type', 'a resource type is required');
  if (!input.violation_type || typeof input.violation_type !== 'string') throw AppError.badRequest('invalid_violation_type', 'a violation type is required');
  if (!input.evidence || typeof input.evidence !== 'string') throw AppError.badRequest('invalid_evidence', 'evidence is required');
  const validSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (!validSeverities.includes(input.severity)) throw AppError.badRequest('invalid_severity', 'severity must be LOW, MEDIUM, HIGH, or CRITICAL');
  const id = newId(PREFIX.COMPLIANCE_CHECK);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO compliance_reports (id, owner_id, resource_type, violation_type, evidence, severity, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.resource_type, input.violation_type, input.evidence, input.severity, 'FLAGGED'],
  ));
  await recordAudit({
    action: AuditAction.COMPLIANCE_VIOLATION_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'compliance_reports',
    resourceId: id,
    detail: { resource_type: input.resource_type, violation_type: input.violation_type, severity: input.severity },
  });
  return getComplianceReport(userId, id);
}

export async function resolveComplianceReport(userId: string, id: string): Promise<ComplianceReportRow> {
  const report = await getComplianceReport(userId, id);
  if (report.status === 'RESOLVED') throw AppError.badRequest('already_resolved', 'compliance report is already resolved');
  await withTenant(userId, (q) => q.query(
    'UPDATE compliance_reports SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'RESOLVED', userId],
  ));
  return getComplianceReport(userId, id);
}

export async function getComplianceReport(userId: string, id: string): Promise<ComplianceReportRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM compliance_reports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('compliance_report_not_found', 'no compliance report found for that id');
  return rowOf(row);
}

export async function listComplianceReports(userId: string): Promise<ComplianceReportRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM compliance_reports WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function complianceReport(userId: string): Promise<{ total: number; flagged: number; resolved: number; by_severity: Record<string, number> }> {
  const rows = await listComplianceReports(userId);
  const bySeverity: Record<string, number> = {};
  for (const r of rows) {
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  }
  return {
    total: rows.length,
    flagged: rows.filter((r) => r.status === 'FLAGGED').length,
    resolved: rows.filter((r) => r.status === 'RESOLVED').length,
    by_severity: bySeverity,
  };
}
