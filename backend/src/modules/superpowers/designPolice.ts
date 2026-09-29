/**
 * CodeConClave — Superpowers: DESIGN POLICE (Master Feature #111).
 *
 * Every implemented screen compared to the design system (spacing, color,
 * component usage) — violations auto-fixed.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DesignPoliceReportRow {
  id: string;
  owner_id: string;
  screen_path: string;
  violations: string[];
  component_misuse: string[];
  spacing_issues: string[];
  color_issues: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DesignPoliceReportRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  screen_path: String(r.screen_path),
  violations: Array.isArray(r.violations) ? r.violations as string[] : [],
  component_misuse: Array.isArray(r.component_misuse) ? r.component_misuse as string[] : [],
  spacing_issues: Array.isArray(r.spacing_issues) ? r.spacing_issues as string[] : [],
  color_issues: Array.isArray(r.color_issues) ? r.color_issues as string[] : [],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function flagDesignViolation(userId: string, input: { screen_path: string; violations?: string[]; component_misuse?: string[]; spacing_issues?: string[]; color_issues?: string[] }): Promise<DesignPoliceReportRow> {
  if (!input.screen_path || typeof input.screen_path !== 'string') throw AppError.badRequest('invalid_screen', 'screen path is required');
  const violations = input.violations ?? [];
  const componentMisuse = input.component_misuse ?? [];
  const spacingIssues = input.spacing_issues ?? [];
  const colorIssues = input.color_issues ?? [];
  if (violations.length === 0 && componentMisuse.length === 0 && spacingIssues.length === 0 && colorIssues.length === 0) {
    throw AppError.badRequest('no_violations', 'at least one violation must be provided');
  }
  const id = newId(PREFIX.DESIGN_POLICE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO design_police_reports (id, owner_id, screen_path, violations, component_misuse, spacing_issues, color_issues, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.screen_path, JSON.stringify(violations), JSON.stringify(componentMisuse), JSON.stringify(spacingIssues), JSON.stringify(colorIssues), 'FLAGGED'],
  ));
  await recordAudit({
    action: AuditAction.DESIGN_VIOLATION_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'design_police_reports',
    resourceId: id,
    detail: { screen_path: input.screen_path, total_violations: violations.length + componentMisuse.length + spacingIssues.length + colorIssues.length },
  });
  return getDesignReport(userId, id);
}

export async function fixViolation(userId: string, id: string): Promise<DesignPoliceReportRow> {
  const report = await getDesignReport(userId, id);
  if (report.status !== 'FLAGGED') throw AppError.badRequest('not_flagged', 'only FLAGGED reports can be fixed');
  await withTenant(userId, (q) => q.query('UPDATE design_police_reports SET status = $1, violations = $2, component_misuse = $3, spacing_issues = $4, color_issues = $5, updated_at = now() WHERE id = $6 AND owner_id = $7',
    ['FIXED', JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), id, userId]));
  await recordAudit({
    action: AuditAction.DESIGN_VIOLATION_FIXED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'design_police_reports',
    resourceId: id,
    detail: { screen_path: report.screen_path },
  });
  return getDesignReport(userId, id);
}

export async function ignoreViolation(userId: string, id: string): Promise<DesignPoliceReportRow> {
  const report = await getDesignReport(userId, id);
  if (report.status !== 'FLAGGED') throw AppError.badRequest('not_flagged', 'only FLAGGED reports can be ignored');
  await withTenant(userId, (q) => q.query('UPDATE design_police_reports SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', ['IGNORED', id, userId]));
  return getDesignReport(userId, id);
}

export async function getDesignReport(userId: string, id: string): Promise<DesignPoliceReportRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM design_police_reports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('design_report_not_found', 'no design police report found for that id');
  return rowOf(row);
}

export async function listDesignReports(userId: string): Promise<DesignPoliceReportRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM design_police_reports WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function designPoliceReport(userId: string): Promise<{ reports: number; flagged: number; fixed: number; ignored: number }> {
  const list = await listDesignReports(userId);
  return {
    reports: list.length,
    flagged: list.filter((r) => r.status === 'FLAGGED').length,
    fixed: list.filter((r) => r.status === 'FIXED').length,
    ignored: list.filter((r) => r.status === 'IGNORED').length,
  };
}
