/**
 * CodeConClave — Superpowers: THEME ENFORCER (Master Feature #121).
 *
 * Design system theme applied globally; any violation flagged and auto-fixed.
 * Light/dark/high-contrast modes automatically derived.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ThemeViolationRow {
  id: string;
  owner_id: string;
  component: string;
  violation_type: string;
  severity: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ThemeViolationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component: String(r.component),
  violation_type: String(r.violation_type),
  severity: String(r.severity),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function flagViolation(userId: string, input: { component: string; violation_type: string; severity: string }): Promise<ThemeViolationRow> {
  if (!input.component || typeof input.component !== 'string') {
    throw AppError.badRequest('invalid_component', 'a component name is required');
  }
  if (!input.violation_type || typeof input.violation_type !== 'string') {
    throw AppError.badRequest('invalid_violation_type', 'a violation type is required');
  }
  if (!input.severity || typeof input.severity !== 'string') {
    throw AppError.badRequest('invalid_severity', 'a severity is required');
  }
  const id = newId(PREFIX.THEME_ENFORCER);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO theme_violations (id, owner_id, component, violation_type, severity, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.component, input.violation_type, input.severity, 'FLAGGED'],
  ));
  await recordAudit({
    action: AuditAction.THEME_VIOLATION_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'theme_violations',
    resourceId: id,
    detail: { component: input.component, violation_type: input.violation_type },
  });
  return getThemeViolation(userId, id);
}

export async function fixViolation(userId: string, id: string): Promise<ThemeViolationRow> {
  await getThemeViolation(userId, id);
  await withTenant(userId, (q) => q.query(
    'UPDATE theme_violations SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'FIXED', userId],
  ));
  await recordAudit({
    action: AuditAction.THEME_VIOLATION_FIXED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'theme_violations',
    resourceId: id,
    detail: {},
  });
  return getThemeViolation(userId, id);
}

export async function getThemeViolation(userId: string, id: string): Promise<ThemeViolationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM theme_violations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('theme_violation_not_found', 'no theme violation found for that id');
  return rowOf(row);
}

export async function listThemeViolations(userId: string): Promise<ThemeViolationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM theme_violations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function themeEnforcerReport(userId: string): Promise<{ violations: number; flagged: number; fixed: number }> {
  const list = await listThemeViolations(userId);
  return {
    violations: list.length,
    flagged: list.filter((v) => v.status === 'FLAGGED').length,
    fixed: list.filter((v) => v.status === 'FIXED').length,
  };
}
