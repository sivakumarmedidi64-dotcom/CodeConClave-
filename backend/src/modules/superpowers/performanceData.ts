/**
 * CodeConClave — Superpowers: PERFORMANCE REVIEW DATA (Master Feature #141).
 *
 * Generates evidence-based 360 feedback from real activity — deliveries,
 * authored lines, review count, mentoring and ops work. Reviews become
 * data-driven; nobody argues with the repository.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PerformanceMetrics {
  delivered: number;
  authored_lines: number;
  review_count: number;
  review_comments: number;
  mentoring: number;
  ops_hours: number;
  missed_deadlines: number;
  comments_per_review: number;
}

export type PerformanceTier = 'EXCELLENT' | 'STRONG' | 'STEADY' | 'RISING';

export interface PerformanceDigestRow {
  id: string;
  owner_id: string;
  person: string;
  period: string;
  metrics: PerformanceMetrics;
  score: number;
  tier: PerformanceTier;
  narrative: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): PerformanceDigestRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  person: String(r.person),
  period: String(r.period),
  metrics: (r.metrics ?? {}) as PerformanceMetrics,
  score: Number(r.score),
  tier: r.tier as PerformanceTier,
  narrative: String(r.narrative),
  created_at: new Date(r.created_at as string),
});

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function computePerformanceScore(metrics: PerformanceMetrics): { score: number; tier: PerformanceTier } {
  const delivered = clampScore((metrics.delivered ?? 0) * 10);
  const authored = clampScore(Math.round((metrics.authored_lines ?? 0) / 50));
  const reviews = clampScore((metrics.review_count ?? 0) * 5);
  const mentoring = clampScore((metrics.mentoring ?? 0) * 20);
  const score = clampScore(Math.round(0.4 * delivered + 0.25 * authored + 0.2 * reviews + 0.15 * mentoring));
  const tier: PerformanceTier = score >= 85 ? 'EXCELLENT' : score >= 70 ? 'STRONG' : score >= 50 ? 'STEADY' : 'RISING';
  return { score, tier };
}

export async function generatePerformanceDigest(
  userId: string,
  input: { person: string; period: string; delivered?: number; authored_lines?: number; review_count?: number; review_comments?: number; mentoring?: number; ops_hours?: number; missed_deadlines?: number },
): Promise<PerformanceDigestRow> {
  if (!input.person || typeof input.person !== 'string') throw AppError.badRequest('invalid_person', 'a person is required');
  if (!input.period || typeof input.period !== 'string') throw AppError.badRequest('invalid_period', 'a period is required');
  const delivered = input.delivered ?? 0;
  const authoredLines = input.authored_lines ?? 0;
  const reviewCount = input.review_count ?? 0;
  const reviewComments = input.review_comments ?? 0;
  const mentoring = input.mentoring ?? 0;
  const opsHours = input.ops_hours ?? 0;
  const missedDeadlines = input.missed_deadlines ?? 0;
  if ([delivered, authoredLines, reviewCount, reviewComments, mentoring, opsHours, missedDeadlines].some((n) => !Number.isFinite(n) || n < 0)) {
    throw AppError.badRequest('invalid_metrics', 'all performance metrics must be non-negative numbers');
  }
  const commentsPerReview = reviewCount > 0 ? Math.round((reviewComments / reviewCount) * 10) / 10 : 0;
  const metrics: PerformanceMetrics = {
    delivered,
    authored_lines: authoredLines,
    review_count: reviewCount,
    review_comments: reviewComments,
    mentoring,
    ops_hours: opsHours,
    missed_deadlines: missedDeadlines,
    comments_per_review: commentsPerReview,
  };
  const { score, tier } = computePerformanceScore(metrics);
  const reliabilityNote =
    missedDeadlines > delivered ? 'Reliability flag: missed deadlines exceed completed deliveries — investigate blockers.' : 'Reliability: deadlines met consistently.';
  const narrative = [
    `PERFORMANCE DIGEST: ${input.person} (${input.period})`,
    `Delivered ${delivered} items, ${authoredLines} authored lines, reviewed ${reviewCount} PRs.`,
    `Mentoring signal: ${mentoring} peer-mentoring events; ops contribution ${opsHours} hours.`,
    reliabilityNote,
    `Score: ${score}/100 (${tier}).`,
  ].join('\n');
  const id = newId(PREFIX.PERFORMANCE_DIGEST);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO performance_digests (id, owner_id, person, period, metrics, score, tier, narrative) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.person, input.period, metrics, score, tier, narrative],
  ));
  await recordAudit({
    action: AuditAction.PERFORMANCE_DIGEST_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'performance_digests',
    resourceId: id,
    detail: { person: input.person, period: input.period, score },
  });
  return getPerformanceDigest(userId, id);
}

export async function getPerformanceDigest(userId: string, id: string): Promise<PerformanceDigestRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM performance_digests WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('performance_digest_not_found', 'no performance digest found for that id');
  return rowOf(row);
}

export async function listPerformanceDigests(userId: string, filter: { person?: string } = {}): Promise<PerformanceDigestRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM performance_digests WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.person) rows = rows.filter((r) => r.person === filter.person);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function performanceDigestReport(userId: string): Promise<{
  total: number;
  avg_score: number;
  by_tier: Record<PerformanceTier, number>;
}> {
  const rows = await listPerformanceDigests(userId);
  const by_tier: Record<PerformanceTier, number> = { EXCELLENT: 0, STRONG: 0, STEADY: 0, RISING: 0 };
  for (const r of rows) by_tier[r.tier] += 1;
  const avg = rows.length === 0 ? 0 : Math.round((rows.reduce((acc, r) => acc + r.score, 0) / rows.length) * 10) / 10;
  return { total: rows.length, avg_score: avg, by_tier };
}