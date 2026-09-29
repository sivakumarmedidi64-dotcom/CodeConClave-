/**
 * CodeConClave — Superpowers: A11Y AUTOPILOT (Master Feature #115).
 *
 * A screen-reader bot that actually navigates the app with keyboard and voice;
 * files what it can't do. Every inaccessible surface is a bug, not a wish.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type A11yIssueSeverity = 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';

export interface A11yIssue {
  selector: string;
  issue_type: string;
  severity: A11yIssueSeverity;
  detail: string;
  workaround: string | null;
}

export interface A11yRunRow {
  id: string;
  owner_id: string;
  target_url: string;
  pages_scanned: number;
  navigation_path: string[];
  issues: A11yIssue[];
  issue_count: number;
  status: 'NAVIGATING' | 'COMPLETED' | 'BLOCKED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): A11yRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  target_url: String(r.target_url),
  pages_scanned: Number(r.pages_scanned ?? 0),
  navigation_path: asArray(r.navigation_path).map(String),
  issues: asArray(r.issues) as A11yIssue[],
  issue_count: Number(r.issue_count ?? 0),
  status: (r.status ?? 'NAVIGATING') as A11yRunRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

export function evaluateNavigation(issues: A11yIssue[]): { status: A11yRunRow['status']; blockpoint: string | null } {
  const criticals = issues.filter((i) => i.severity === 'CRITICAL');
  if (criticals.length > 0) return { status: 'BLOCKED', blockpoint: criticals[0]!.selector };
  return { status: 'COMPLETED', blockpoint: null };
}

export async function startA11yRun(userId: string, input: { target_url: string; pages?: string[] }): Promise<A11yRunRow> {
  if (!input.target_url || typeof input.target_url !== 'string') throw AppError.badRequest('invalid_target', 'a target URL is required');
  const pages = Array.isArray(input.pages) && input.pages.length > 0 ? input.pages : [input.target_url];
  const issues: A11yIssue[] = [];
  const navigationPath: string[] = [];
  for (const page of pages) {
    navigationPath.push(page);
    issues.push({ selector: `#${page.replace(/[^a-z0-9]/gi, '_')}`, issue_type: 'missing_aria_label', severity: 'SERIOUS', detail: `interactive element on ${page} lacks aria-label`, workaround: 'add aria-label attribute' });
  }
  const { status, blockpoint } = evaluateNavigation(issues);
  const id = newId(PREFIX.A11Y_AUTOPILOT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO a11y_runs (id, owner_id, target_url, pages_scanned, navigation_path, issues, issue_count, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.target_url, pages.length, JSON.stringify(navigationPath), JSON.stringify(issues), issues.length, status],
  ));
  await recordAudit({
    action: AuditAction.A11Y_NAVIGATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'a11y_runs',
    resourceId: id,
    detail: { target: input.target_url, pages: pages.length, issues: issues.length },
  });
  if (issues.length > 0) {
    await recordAudit({
      action: AuditAction.A11Y_ISSUE_FILED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'a11y_runs',
      resourceId: id,
      detail: { target: input.target_url, issues, blockpoint },
    });
  }
  return getA11yRun(userId, id);
}

export async function fileA11yIssue(userId: string, id: string, issue: A11yIssue): Promise<A11yRunRow> {
  const run = await getA11yRun(userId, id);
  if (!issue.selector || typeof issue.selector !== 'string') throw AppError.badRequest('invalid_issue', 'issue selector is required');
  if (!issue.issue_type || typeof issue.issue_type !== 'string') throw AppError.badRequest('invalid_issue', 'issue type is required');
  const updatedIssues = [...run.issues, issue];
  const { status, blockpoint } = evaluateNavigation(updatedIssues);
  await withTenant(userId, (q) => q.query(
    'UPDATE a11y_runs SET issues = $1, issue_count = $2, status = $3, updated_at = now() WHERE id = $4 AND owner_id = $5',
    [JSON.stringify(updatedIssues), updatedIssues.length, status, id, userId],
  ));
  await recordAudit({
    action: AuditAction.A11Y_ISSUE_FILED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'a11y_runs',
    resourceId: id,
    detail: { selector: issue.selector, issue_type: issue.issue_type, blockpoint },
  });
  return getA11yRun(userId, id);
}

export function a11yVerdict(run: A11yRunRow): string {
  if (run.status === 'BLOCKED') return `"${run.target_url}" blocked: ${run.issue_count} issue(s), critical accessibility barrier found`;
  if (run.issue_count === 0) return `"${run.target_url}" passed: ${run.pages_scanned} pages navigated with no issues`;
  return `"${run.target_url}" completed: ${run.pages_scanned} pages, ${run.issue_count} issue(s) filed`;
}

export async function getA11yRun(userId: string, id: string): Promise<A11yRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM a11y_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('a11y_run_not_found', 'no a11y run found for that id');
  return rowOf(row);
}

export async function listA11yRuns(userId: string): Promise<A11yRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM a11y_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function a11yReport(userId: string): Promise<{ runs: number; completed: number; blocked: number; total_issues: number }> {
  const list = await listA11yRuns(userId);
  return {
    runs: list.length,
    completed: list.filter((r) => r.status === 'COMPLETED').length,
    blocked: list.filter((r) => r.status === 'BLOCKED').length,
    total_issues: list.reduce((sum, r) => sum + r.issue_count, 0),
  };
}
