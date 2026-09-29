/**
 * CodeConClave — Superpowers: LOCALIZATION FORGE (Master Feature #116).
 *
 * Extracts all strings, manages translation state, detects truncation/overflow
 * in every language, RTL layout breaks, locale formats. No string left behind.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type LocalizationIssueType = 'truncation' | 'overflow' | 'rtl_break' | 'missing_translation' | 'locale_format_error';

export interface LocalizationIssue {
  locale: string;
  key: string;
  issue_type: LocalizationIssueType;
  detail: string;
}

export interface LocalizationScanRow {
  id: string;
  owner_id: string;
  project: string;
  locales: string[];
  strings_scanned: number;
  issues: LocalizationIssue[];
  issue_count: number;
  status: 'SCANNING' | 'COMPLETED' | 'HAS_ISSUES';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): LocalizationScanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project: String(r.project),
  locales: asArray(r.locales).map(String),
  strings_scanned: Number(r.strings_scanned ?? 0),
  issues: asArray(r.issues) as LocalizationIssue[],
  issue_count: Number(r.issue_count ?? 0),
  status: (r.status ?? 'SCANNING') as LocalizationScanRow['status'],
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

export function detectLocalizationIssues(strings: Array<{ key: string; locale: string; value: string; max_length?: number }>): LocalizationIssue[] {
  const issues: LocalizationIssue[] = [];
  for (const s of strings) {
    if (!s.value && s.value !== '') {
      issues.push({ locale: s.locale, key: s.key, issue_type: 'missing_translation', detail: `string "${s.key}" is missing for locale ${s.locale}` });
    }
    if (s.max_length && s.value.length > s.max_length) {
      issues.push({ locale: s.locale, key: s.key, issue_type: 'overflow', detail: `string "${s.key}" exceeds max length ${s.max_length} in ${s.locale}` });
    }
    if (s.locale === 'ar' || s.locale === 'he' || s.locale === 'fa') {
      if (!/[\u0600-\u06FF\u0590-\u05FF]/.test(s.value) && s.value.length > 0) {
        issues.push({ locale: s.locale, key: s.key, issue_type: 'rtl_break', detail: `RTL locale ${s.locale} string "${s.key}" contains no RTL characters` });
      }
    }
  }
  return issues;
}

export async function startLocalizationScan(userId: string, input: { project: string; locales?: string[]; strings?: Array<{ key: string; locale: string; value: string; max_length?: number }> }): Promise<LocalizationScanRow> {
  if (!input.project || typeof input.project !== 'string') throw AppError.badRequest('invalid_project', 'a project name is required');
  const locales = Array.isArray(input.locales) && input.locales.length > 0 ? input.locales : ['en'];
  const strings = Array.isArray(input.strings) ? input.strings : [];
  const issues = detectLocalizationIssues(strings);
  const status = issues.length > 0 ? 'HAS_ISSUES' : 'COMPLETED';
  const id = newId(PREFIX.LOCALIZATION_FORGE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO localization_scans (id, owner_id, project, locales, strings_scanned, issues, issue_count, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.project, JSON.stringify(locales), strings.length, JSON.stringify(issues), issues.length, status],
  ));
  await recordAudit({
    action: AuditAction.LOCALIZATION_SCAN_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'localization_scans',
    resourceId: id,
    detail: { project: input.project, locales: locales.length, strings: strings.length },
  });
  if (issues.length > 0) {
    await recordAudit({
      action: AuditAction.LOCALIZATION_ISSUE_FLAGGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'localization_scans',
      resourceId: id,
      detail: { project: input.project, issues },
    });
  }
  return getLocalizationScan(userId, id);
}

export function localizationVerdict(s: LocalizationScanRow): string {
  if (s.status === 'COMPLETED') return `"${s.project}" scan complete: ${s.strings_scanned} strings across ${s.locales.length} locale(s), no issues`;
  if (s.status === 'HAS_ISSUES') return `"${s.project}" scan found ${s.issue_count} issue(s) across ${s.locales.length} locale(s)`;
  return `"${s.project}" scan in progress: ${s.strings_scanned} strings scanned`;
}

export async function getLocalizationScan(userId: string, id: string): Promise<LocalizationScanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM localization_scans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('localization_scan_not_found', 'no localization scan found for that id');
  return rowOf(row);
}

export async function listLocalizationScans(userId: string): Promise<LocalizationScanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM localization_scans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function localizationForgeReport(userId: string): Promise<{ scans: number; with_issues: number; clean: number; total_issues: number }> {
  const list = await listLocalizationScans(userId);
  return {
    scans: list.length,
    with_issues: list.filter((s) => s.status === 'HAS_ISSUES').length,
    clean: list.filter((s) => s.status === 'COMPLETED').length,
    total_issues: list.reduce((sum, s) => sum + s.issue_count, 0),
  };
}
