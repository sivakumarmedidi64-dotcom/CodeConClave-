/**
 * CodeConClave — Superpowers: COVERAGE SENTINEL (Master Feature #31).
 *
 * Diffs new/changed code against coverage, generates tests for the uncovered
 * branches, and — critically — rejects its own hollow tests. Any candidate that
 * contains no assertion, never touches the target function, or is a placeholder
 * is thrown out rather than shipped. Padding coverage numbers is forbidden.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CoverageReportRow {
  file: string;
  location: string;
  function_name: string;
  uncovered_branches: number;
  total_branches?: number;
}

export type CoverageVerdict = 'SOUND' | 'HOLLOW';

export interface CoverageScanRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  files_scanned: number;
  gap_count: number;
  generated_targets: string[];
  accepted_tests: Array<{ function_name?: string | null; body: string }>;
  rejected_targets: number;
  status: 'GENERATED' | 'ACCEPTED' | 'REJECTED';
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CoverageScanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  files_scanned: Number(r.files_scanned ?? 0),
  gap_count: Number(r.gap_count ?? 0),
  generated_targets: asArray(r.generated_targets).map(String),
  accepted_tests: asArray(r.accepted_tests) as CoverageScanRow['accepted_tests'],
  rejected_targets: Number(r.rejected_targets ?? 0),
  status: (r.status ?? 'GENERATED') as CoverageScanRow['status'],
  created_at: new Date(r.created_at as string),
});

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

export const buildTestTarget = (functionName: string, file?: string, location?: string): string => {
  const fn = (functionName ?? '').trim();
  const describe = file ? `describe(${JSON.stringify(`${file}${location ? ` — ${location}` : ''}`)}, () => {\n  ` : '';
  const close = file ? '\n});' : '';
  return `${describe}it('exercises the uncovered branch(es) in ${fn}', () => {\n  const out = ${fn}();\n  expect(out).toBeDefined();\n});${close}`;
};

export function analyzeTestQuality(body: string, targetFunction?: string | null): { verdict: CoverageVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const text = (body ?? '').trim();
  if (!text) reasons.push('empty test body');
  else if (!/[A-Za-z_$]/.test(text)) reasons.push('test body is a blank placeholder');
  else {
    if (!/(expect|assert|should|expect\(|assert\.)/i.test(text)) reasons.push('contains no assertion');
    if (targetFunction && !text.includes(targetFunction)) reasons.push('does not exercise the target function');
    if (/(TODO|FIXME|not implemented|throw new Error\(['"]todo)/i.test(text)) reasons.push('contains a placeholder');
  }
  if (!reasons.includes('test body is a blank placeholder') && !reasons.includes('empty test body') && text.length < 20) reasons.push('too short to exercise anything');
  return { verdict: reasons.length === 0 ? 'SOUND' : 'HOLLOW', reasons };
}

export interface CoverageScanReport {
  id: string;
  files_scanned: number;
  gap_count: number;
  generated_targets: string[];
  accepted_tests: Array<{ function_name?: string | null; body: string }>;
  hollow_rejected: number;
  verdict: 'GAPS_TARGETED';
}

export async function runCoverageScan(userId: string, input: { projectId?: string | null; report: CoverageReportRow[]; candidateTests?: Array<{ function_name?: string | null; body: string }> }): Promise<CoverageScanReport> {
  const report = Array.isArray(input.report) ? input.report : [];
  if (report.length === 0) throw AppError.badRequest('empty_report', 'a coverage report with at least one file is required');
  let files = 0;
  const gaps: Array<{ file: string; location: string; function_name: string; uncovered_branches: number }> = [];
  for (const row of report) {
    if (typeof row.file !== 'string' || typeof row.function_name !== 'string') throw AppError.badRequest('invalid_report_row', 'each report row needs a file and function_name');
    if (row.uncovered_branches !== undefined && !Number.isFinite(Number(row.uncovered_branches))) throw AppError.badRequest('invalid_report_row', 'uncovered_branches must be a number');
    files += 1;
    if (Number(row.uncovered_branches) > 0) gaps.push({ file: row.file, location: row.location ?? '', function_name: row.function_name, uncovered_branches: Number(row.uncovered_branches) });
  }
  const generatedTargets = gaps.map((g) => buildTestTarget(g.function_name, g.file, g.location));
  const accepted: Array<{ function_name?: string | null; body: string }> = [];
  let rejected = 0;
  const candidates = Array.isArray(input.candidateTests) ? input.candidateTests : [];
  for (const candidate of candidates) {
    const body = typeof candidate?.body === 'string' ? candidate.body : '';
    const focus = candidate?.function_name;
    const quality = analyzeTestQuality(body, focus);
    if (quality.verdict === 'HOLLOW') {
      rejected += 1;
      await recordAudit({
        action: AuditAction.HOLLOW_TEST_REJECTED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'coverage_scans',
        resourceId: null,
        detail: { function_name: focus ?? null, reasons: quality.reasons },
      });
    } else {
      accepted.push({ function_name: focus ?? null, body });
    }
  }
  const id = newId(PREFIX.COVERAGE_SCAN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO coverage_scans (id, owner_id, project_id, files_scanned, gap_count, generated_targets, accepted_tests, rejected_targets, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.projectId ?? null, files, gaps.length, generatedTargets, accepted, rejected, 'GENERATED'],
  ));
  await recordAudit({
    action: AuditAction.COVERAGE_SCANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'coverage_scans',
    resourceId: id,
    detail: { files_scanned: files, gap_count: gaps.length, generated_targets: generatedTargets.length, hollow_rejected: rejected },
  });
  return { id, files_scanned: files, gap_count: gaps.length, generated_targets: generatedTargets, accepted_tests: accepted, hollow_rejected: rejected, verdict: 'GAPS_TARGETED' };
}

export async function listCoverageScans(userId: string, filter: { status?: string } = {}): Promise<CoverageScanRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM coverage_scans WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.status) rows = rows.filter((s) => s.status === filter.status);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function getCoverageScan(userId: string, id: string): Promise<CoverageScanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM coverage_scans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('coverage_scan_not_found', 'no coverage scan found for that id');
  return rowOf(row);
}