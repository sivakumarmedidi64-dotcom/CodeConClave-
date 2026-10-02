/**
 * CodeConClave — Superpowers: ORG HEALTH DASHBOARD (#143).
 *
 * Single view: bus factor, review bottlenecks, coverage, incidents, debt, velocity trends.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface OrgHealthRow {
  id: string;
  owner_id: string;
  bus_factor_score: number;
  review_bottleneck_score: number;
  coverage_score: number;
  incident_count: number;
  debt_score: number;
  velocity_trend: string;
  status: string;
  computed_metrics: unknown;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): OrgHealthRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  bus_factor_score: Number(r.bus_factor_score),
  review_bottleneck_score: Number(r.review_bottleneck_score),
  coverage_score: Number(r.coverage_score),
  incident_count: Number(r.incident_count),
  debt_score: Number(r.debt_score),
  velocity_trend: String(r.velocity_trend),
  status: String(r.status),
  computed_metrics: r.computed_metrics ?? null,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createOrgHealthReport(userId: string, input: { bus_factor_score: number; review_bottleneck_score: number; coverage_score: number; incident_count: number; debt_score: number; velocity_trend: string }): Promise<OrgHealthRow> {
  if (typeof input.bus_factor_score !== 'number') throw AppError.badRequest('bus_factor_required', 'bus factor score is required');
  if (typeof input.review_bottleneck_score !== 'number') throw AppError.badRequest('review_bottleneck_required', 'review bottleneck score is required');
  if (typeof input.coverage_score !== 'number') throw AppError.badRequest('coverage_required', 'coverage score is required');
  if (typeof input.incident_count !== 'number') throw AppError.badRequest('incident_count_required', 'incident count is required');
  if (typeof input.debt_score !== 'number') throw AppError.badRequest('debt_score_required', 'debt score is required');
  if (!input.velocity_trend || typeof input.velocity_trend !== 'string') throw AppError.badRequest('velocity_trend_required', 'velocity trend is required');
  const id = newId(PREFIX.ORG_HEALTH);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO org_health_reports (id, owner_id, bus_factor_score, review_bottleneck_score, coverage_score, incident_count, debt_score, velocity_trend, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.bus_factor_score, input.review_bottleneck_score, input.coverage_score, input.incident_count, input.debt_score, input.velocity_trend, 'DRAFT'],
  ));
  await recordAudit({
    action: AuditAction.ORG_HEALTH_COMPUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'org_health_reports',
    resourceId: id,
    detail: {},
  });
  return getOrgHealthReport(userId, id);
}

export async function computeOrgHealth(userId: string, id: string): Promise<OrgHealthRow> {
  const report = await getOrgHealthReport(userId, id);
  if (report.status === 'COMPUTED') throw AppError.badRequest('already_computed', 'org health already computed for this report');
  const metrics = { bus_factor: report.bus_factor_score, review_bottleneck: report.review_bottleneck_score, coverage: report.coverage_score, incidents: report.incident_count, debt: report.debt_score, velocity: report.velocity_trend };
  await withTenant(userId, (q) => q.query(
    'UPDATE org_health_reports SET computed_metrics = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, metrics, 'COMPUTED', userId],
  ));
  await recordAudit({
    action: AuditAction.ORG_HEALTH_COMPUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'org_health_reports',
    resourceId: id,
    detail: metrics,
  });
  return getOrgHealthReport(userId, id);
}

export async function getOrgHealthReport(userId: string, id: string): Promise<OrgHealthRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM org_health_reports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('org_health_report_not_found', 'no org health report found for that id');
  return rowOf(row);
}

export async function listOrgHealthReports(userId: string): Promise<OrgHealthRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM org_health_reports WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function orgHealthReport(userId: string): Promise<{ reports: number; computed: number; draft: number }> {
  const reports = await listOrgHealthReports(userId);
  return {
    reports: reports.length,
    computed: reports.filter((r) => r.status === 'COMPUTED').length,
    draft: reports.filter((r) => r.status === 'DRAFT').length,
  };
}
