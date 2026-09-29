/**
 * CodeConClave — Superpowers: DRIFT POLICE (Master Feature #86).
 *
 * Continuously diffs actual cloud state against IaC state; either reconciles
 * or files a precise fix. "Someone changed something in the console" → never a
 * mystery. IaC stays truthful.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type DriftKind = 'modified' | 'added' | 'removed';

export interface DriftEntry {
  resource: string;
  expected: string | null;
  actual: string | null;
  kind: DriftKind;
  resolution: string;
  fix: string | null;
}

export interface DriftReportRow {
  id: string;
  owner_id: string;
  drifts: DriftEntry[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DriftReportRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  drifts: (r.drifts ?? []) as DriftEntry[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const KIND_ORDER: Record<DriftKind, number> = { removed: 0, modified: 1, added: 2 };

export function diffStates(iac: Record<string, string>, actual: Record<string, string>): DriftEntry[] {
  const entries: DriftEntry[] = [];
  for (const [resource, fingerprint] of Object.entries(iac)) {
    if (!(resource in actual)) {
      entries.push({ resource, expected: fingerprint, actual: null, kind: 'removed', resolution: 'OPEN', fix: null });
    } else if (actual[resource] !== fingerprint) {
      entries.push({ resource, expected: fingerprint, actual: actual[resource]!, kind: 'modified', resolution: 'OPEN', fix: null });
    }
  }
  for (const [resource, fingerprint] of Object.entries(actual)) {
    if (!(resource in iac)) {
      entries.push({ resource, expected: null, actual: fingerprint, kind: 'added', resolution: 'OPEN', fix: null });
    }
  }
  return entries.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.resource.localeCompare(b.resource));
}

export async function diffState(userId: string, input: { iac: Record<string, string>; actual: Record<string, string> }): Promise<DriftReportRow> {
  if (!input.iac || typeof input.iac !== 'object') throw AppError.badRequest('invalid_iac', 'the declared IaC state is required');
  if (!input.actual || typeof input.actual !== 'object') throw AppError.badRequest('invalid_actual', 'the live cloud state is required');
  const drifts = diffStates(input.iac, input.actual);
  const id = newId(PREFIX.DRIFT_REPORT);
  await withTenant(userId, (q) => q.query('INSERT INTO drift_reports (id, owner_id, drifts, status) VALUES ($1,$2,$3,$4)', [
    id, userId, drifts, drifts.length === 0 ? 'CLEAN' : 'OPEN',
  ]));
  await recordAudit({
    action: AuditAction.DRIFT_STATE_DIFFED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'drift_reports',
    resourceId: id,
    detail: { drifts: drifts.length },
  });
  return getDriftReport(userId, id);
}

export async function reconcileDrift(userId: string, id: string, input: { resource: string }): Promise<DriftReportRow> {
  return resolveDrift(userId, id, input.resource, 'RECONCILED', null, AuditAction.DRIFT_RECONCILED);
}

export async function fileDriftFix(userId: string, id: string, input: { resource: string }): Promise<DriftReportRow> {
  const report = await getDriftReport(userId, id);
  const entry = report.drifts.find((e) => e.resource === input.resource);
  if (!entry) throw AppError.badRequest('drift_not_found', 'that resource is not part of this drift report');
  if (entry.resolution !== 'OPEN') throw AppError.badRequest('drift_resolved', 'that drift is already resolved');
  const fix = `terraform_plan_fix: "${entry.resource}" drifted (expected ${entry.expected ?? 'nothing'}, actual ${entry.actual ?? 'nothing'}) — encode actual state into IaC and re-plan`;
  return resolveDrift(userId, id, input.resource, 'FIX_FILED', fix, AuditAction.DRIFT_FIX_FILED);
}

async function resolveDrift(userId: string, id: string, resource: string, resolution: string, fix: string | null, action: AuditAction): Promise<DriftReportRow> {
  const report = await getDriftReport(userId, id);
  const entry = report.drifts.find((e) => e.resource === resource);
  if (!entry) throw AppError.badRequest('drift_not_found', 'that resource is not part of this drift report');
  if (entry.resolution !== 'OPEN') throw AppError.badRequest('drift_resolved', 'that drift is already resolved');
  const drifts = report.drifts.map((e) => (e.resource === resource ? { ...e, resolution, fix } : e));
  await withTenant(userId, (q) => q.query('UPDATE drift_reports SET drifts = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, drifts, userId]));
  await recordAudit({
    action,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'drift_reports',
    resourceId: id,
    detail: { resource, resolution },
  });
  return getDriftReport(userId, id);
}

export async function getDriftReport(userId: string, id: string): Promise<DriftReportRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM drift_reports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('drift_report_not_found', 'no drift report found for that id');
  return rowOf(row);
}

export async function listDriftReports(userId: string): Promise<DriftReportRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM drift_reports WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function driftReportSummary(userId: string): Promise<{ reports: number; clean: number; open_drifts: number; reconciled: number; fixes_filed: number }> {
  const reports = await listDriftReports(userId);
  return {
    reports: reports.length,
    clean: reports.filter((r) => r.status === 'CLEAN').length,
    open_drifts: reports.reduce((s, r) => s + r.drifts.filter((e) => e.resolution === 'OPEN').length, 0),
    reconciled: reports.reduce((s, r) => s + r.drifts.filter((e) => e.resolution === 'RECONCILED').length, 0),
    fixes_filed: reports.reduce((s, r) => s + r.drifts.filter((e) => e.resolution === 'FIX_FILED').length, 0),
  };
}