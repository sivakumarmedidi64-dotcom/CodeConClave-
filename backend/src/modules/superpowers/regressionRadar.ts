/**
 * CodeConClave — Superpowers: REGRESSION RADAR (Master Feature #96).
 *
 * "Show me every regression this file ever caused and the fix that worked."
 * Historical data: all issues linked to a module, fixes that worked.
 * Debugging becomes lookup.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RegressionRadarEntryRow {
  id: string;
  owner_id: string;
  module: string;
  issue_description: string;
  root_cause: string;
  fix_description: string;
  fix_worked: boolean;
  severity: string;
  reported_at: Date;
  fixed_at: Date | null;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): RegressionRadarEntryRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  module: String(r.module),
  issue_description: String(r.issue_description),
  root_cause: String(r.root_cause ?? ''),
  fix_description: String(r.fix_description ?? ''),
  fix_worked: Boolean(r.fix_worked),
  severity: String(r.severity),
  reported_at: new Date(r.reported_at as string),
  fixed_at: r.fixed_at ? new Date(r.fixed_at as string) : null,
  created_at: new Date(r.created_at as string),
});

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export async function logRegression(userId: string, input: {
  module: string;
  issue_description: string;
  root_cause?: string;
  fix_description?: string;
  fix_worked?: boolean;
  severity?: string;
  reported_at?: string;
  fixed_at?: string;
}): Promise<RegressionRadarEntryRow> {
  if (!input.module || typeof input.module !== 'string') throw AppError.badRequest('invalid_module', 'module name is required');
  if (!input.issue_description || typeof input.issue_description !== 'string') throw AppError.badRequest('invalid_issue', 'issue description is required');
  const severity = SEVERITIES.includes(input.severity as typeof SEVERITIES[number]) ? input.severity! : 'MEDIUM';
  const id = newId(PREFIX.REGRESSION_RADAR_ENTRY);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO regression_radar_entries (id, owner_id, module, issue_description, root_cause, fix_description, fix_worked, severity, reported_at, fixed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, userId, input.module.trim(), input.issue_description.trim(), input.root_cause ?? '', input.fix_description ?? '', input.fix_worked ?? false, severity, input.reported_at ? new Date(input.reported_at) : new Date(), input.fixed_at ? new Date(input.fixed_at) : null],
    ),
  );
  await recordAudit({
    action: AuditAction.REGRESSION_RADAR_LOGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'regression_radar_entries',
    resourceId: id,
    detail: { module: input.module, severity },
  });
  return getRegressionEntry(userId, id);
}

export async function markFixWorked(userId: string, id: string, fixDescription: string): Promise<RegressionRadarEntryRow> {
  const entry = await getRegressionEntry(userId, id);
  if (entry.fix_worked) throw AppError.badRequest('fix_already_marked', 'this fix is already marked as working');
  if (!fixDescription || typeof fixDescription !== 'string') throw AppError.badRequest('fix_description_required', 'a fix description is required');
  await withTenant(userId, (q) =>
    q.query(
      'UPDATE regression_radar_entries SET fix_worked = $4, fix_description = $1, fixed_at = now(), updated_at = now() WHERE id = $2 AND owner_id = $3',
      [fixDescription.trim(), id, userId, true],
    ),
  );
  await recordAudit({
    action: AuditAction.REGRESSION_FIX_CONFIRMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'regression_radar_entries',
    resourceId: id,
  });
  return getRegressionEntry(userId, id);
}

export async function getRegressionEntry(userId: string, id: string): Promise<RegressionRadarEntryRow> {
  const row = await withTenant(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM regression_radar_entries WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('regression_entry_not_found', 'no regression entry found for that id');
  return rowOf(row);
}

export async function getRegressionsForModule(userId: string, module: string): Promise<RegressionRadarEntryRow[]> {
  if (!module) throw AppError.badRequest('invalid_module', 'module name is required');
  return (
    await withTenant(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM regression_radar_entries WHERE owner_id = $1 AND module = $2', [userId, module])).rows,
    )
  ).map(rowOf).sort(
    (a, b) => b.reported_at.getTime() - a.reported_at.getTime(),
  );
}

export async function listRegressionEntries(userId: string): Promise<RegressionRadarEntryRow[]> {
  return (
    await withTenant(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM regression_radar_entries WHERE owner_id = $1', [userId])).rows,
    )
  ).map(rowOf).sort(
    (a, b) => b.reported_at.getTime() - a.reported_at.getTime(),
  );
}

export async function regressionRadarReport(userId: string): Promise<{
  entries: number;
  modules: number;
  fixes_worked: number;
  fixes_pending: number;
  by_severity: Record<string, number>;
}> {
  const list = await listRegressionEntries(userId);
  const modules = new Set(list.map((e) => e.module));
  const bySev: Record<string, number> = {};
  for (const e of list) bySev[e.severity] = (bySev[e.severity] ?? 0) + 1;
  return {
    entries: list.length,
    modules: modules.size,
    fixes_worked: list.filter((e) => e.fix_worked).length,
    fixes_pending: list.filter((e) => !e.fix_worked).length,
    by_severity: bySev,
  };
}
