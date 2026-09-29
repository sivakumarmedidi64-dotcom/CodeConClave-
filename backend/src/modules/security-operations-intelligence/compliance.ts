/**
 * CodeConClave — Workspace Compliance Checker (#24, PKG-15).
 * Aggregates the existing security-intelligence posture assessment (which
 * already enforces project ownership + persistence) into a cross-cutting
 * compliance report: overall score, per-category compliance, actionable items,
 * and bounded persisted history. Deterministic and advisory.
 */
import { withTenant, queryMany, pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { assessSecurityPosture } from '../security-intelligence/securityPosture.js';
import type {
  ComplianceCategory,
  ComplianceCategorySummary,
  ComplianceItem,
  ComplianceReport,
  ComplianceRequest,
  ComplianceStatus,
  TruthfulnessState,
} from './types.js';

const MAX_HISTORY = 50;
const CATEGORY_MAP: Record<string, ComplianceCategory> = {
  AUTH: 'POSTURE',
  DATA: 'POSTURE',
  API: 'API',
  DEPENDENCIES: 'SUPPLY_CHAIN',
  SECRETS: 'SECRETS',
  INFRASTRUCTURE: 'POSTURE',
  OPERATIONS: 'POSTURE',
};
const DEFAULT_PERSIST = true;

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query(
    'SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
    [projectId, userId],
  ));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

async function persistReport(report: ComplianceReport, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO secops_compliance_reports
       (id, project_id, overall_score, overall_status, posture_score, posture_level,
        categories, items, created_by, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      report.id,
      report.projectId,
      report.overallScore,
      report.overallStatus,
      report.postureScore,
      report.postureLevel,
      JSON.stringify(report.categories),
      JSON.stringify(report.items),
      userId,
      report.generatedAt,
    ],
  );
  // Bounded history: keep the newest MAX_HISTORY reports per project.
  await pool.query(
    `DELETE FROM secops_compliance_reports
      WHERE project_id = $1 AND id NOT IN (
        SELECT id FROM secops_compliance_reports
         WHERE project_id = $1
         ORDER BY generated_at DESC
         LIMIT $2
      )`,
    [report.projectId, MAX_HISTORY],
  );
}

function statusForScore(score: number): ComplianceStatus {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 90) return 'COMPLIANT';
  if (score >= 60) return 'PARTIAL';
  if (score >= 1) return 'NON_COMPLIANT';
  return 'UNKNOWN';
}

export async function runComplianceCheck(
  userId: string,
  input: ComplianceRequest,
  options?: { persist?: boolean },
): Promise<ComplianceReport> {
  await assertProjectAccess(userId, input.projectId);
  const posture = await assessSecurityPosture(userId, input.projectId, { forceRefresh: input.forceRefresh });
  const persist = options?.persist ?? DEFAULT_PERSIST;

  const items: ComplianceItem[] = [];
  const catAgg: Record<ComplianceCategory, { scoreSum: number; n: number; failing: number; statusCounts: Record<ComplianceStatus, number> }> = {
    POSTURE: { scoreSum: 0, n: 0, failing: 0, statusCounts: emptyCounts() },
    SUPPLY_CHAIN: { scoreSum: 0, n: 0, failing: 0, statusCounts: emptyCounts() },
    SECRETS: { scoreSum: 0, n: 0, failing: 0, statusCounts: emptyCounts() },
    API: { scoreSum: 0, n: 0, failing: 0, statusCounts: emptyCounts() },
  };

  for (const cat of posture.categories) {
    const targetCat = CATEGORY_MAP[cat.category] ?? 'POSTURE';
    const state: TruthfulnessState = 'VERIFIED';
    for (const check of cat.checks) {
      const status: ComplianceStatus =
        check.status === 'PASS' ? 'COMPLIANT'
          : check.status === 'WARN' ? 'PARTIAL'
            : check.status === 'FAIL' ? 'NON_COMPLIANT'
              : 'UNKNOWN';
      catAgg[targetCat].n++;
      catAgg[targetCat].scoreSum += cat.score;
      catAgg[targetCat].statusCounts[status]++;
      if (status === 'NON_COMPLIANT') catAgg[targetCat].failing++;
      if (check.status !== 'PASS') {
        items.push({
          id: check.id,
          category: targetCat,
          status,
          title: check.name,
          details: check.description,
          evidence: check.evidence,
          remediation: check.remediation,
          severity: (check.severity as ComplianceItem['severity']) ?? 'MEDIUM',
          state,
        });
      }
    }
  }

  const categories: ComplianceCategorySummary[] = [];
  (Object.keys(catAgg) as ComplianceCategory[]).forEach((c) => {
    const agg = catAgg[c];
    const score = agg.n === 0 ? 100 : Math.round(agg.scoreSum / agg.n);
    categories.push({
      category: c,
      score,
      status: statusForScore(score),
      items: agg.n,
      failing: agg.failing,
    });
  });

  const overallScore = Math.max(0, Math.min(100, posture.overallScore));
  const report: ComplianceReport = {
    id: newId(PREFIX.COMPLIANCE_REPORT),
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    overallScore,
    overallStatus: statusForScore(overallScore),
    categories,
    items,
    postureScore: posture.overallScore,
    postureLevel: posture.overallLevel,
  };

  if (persist) {
    await persistReport(report, userId);
    await recordAudit({
      action: 'compliance.check.completed',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'compliance_report',
      resourceId: report.id,
      detail: {
        projectId: input.projectId,
        overallScore,
        overallStatus: report.overallStatus,
        categories: categories.length,
      },
    });
  }

  return report;
}

function emptyCounts(): Record<ComplianceStatus, number> {
  return { COMPLIANT: 0, PARTIAL: 0, NON_COMPLIANT: 0, UNKNOWN: 0 };
}

interface ReportRow {
  id: string;
  project_id: string;
  overall_score: number;
  overall_status: string;
  posture_score: number;
  posture_level: string;
  categories: string;
  items: string;
  generated_at: Date;
}

export async function getComplianceHistory(
  userId: string,
  projectId: string,
  limit = 20,
): Promise<ComplianceReport[]> {
  await assertProjectAccess(userId, projectId);
  const rows = await withTenant<ReportRow[]>(userId, async (q) =>
    (
      await q.query<ReportRow>(
        `SELECT * FROM secops_compliance_reports
      WHERE project_id = $1
      ORDER BY generated_at DESC
      LIMIT $2`,
        [projectId, Math.min(limit, MAX_HISTORY)],
      )
    ).rows,
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    generatedAt: new Date(r.generated_at).toISOString(),
    overallScore: r.overall_score,
    overallStatus: r.overall_status as ComplianceStatus,
    categories: parseJson<ComplianceCategorySummary[]>(r.categories, []),
    items: parseJson<ComplianceItem[]>(r.items, []),
    postureScore: r.posture_score,
    postureLevel: r.posture_level,
  }));
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
