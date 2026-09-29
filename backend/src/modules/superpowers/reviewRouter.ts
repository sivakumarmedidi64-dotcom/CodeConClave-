/**
 * CodeConClave — Superpowers: REVIEW ROUTER (Master Feature #134).
 *
 * Every PR auto-routed to the reviewer with the deepest knowledge of the
 * module under change — expertise weighted first, live review load second,
 * name as the final deterministic tie-breaker. No more review roulette.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ReviewAssignmentRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  module: string;
  selected_reviewer: string;
  expertise_score: number;
  open_load: number;
  ranking: { reviewer: string; score: number; open_reviews: number; reason: string }[];
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): ReviewAssignmentRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  module: String(r.module),
  selected_reviewer: String(r.selected_reviewer),
  expertise_score: Number(r.expertise_score),
  open_load: Number(r.open_load),
  ranking: (r.ranking ?? []) as ReviewAssignmentRow['ranking'],
  created_at: new Date(r.created_at as string),
});

export interface ReviewerExpertise {
  reviewer: string;
  score: number;
}

export function rankReviewers(
  module: string,
  expertise: ReviewerExpertise[],
  availability: string[],
  loads: { reviewer: string; open_reviews: number }[] = [],
): { reviewers: string[]; ranking: ReviewAssignmentRow['ranking']; selected: ReviewAssignmentRow['ranking'][number] | undefined } {
  const available = new Set(availability);
  const loadMap = new Map(loads.map((l) => [l.reviewer, l.open_reviews]));
  const candidates = expertise
    .filter((e) => available.has(e.reviewer))
    .map((e) => {
      const open = loadMap.get(e.reviewer) ?? 0;
      return { reviewer: String(e.reviewer), score: e.score, open_reviews: open, reason: `expertise ${e.score}` };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.open_reviews !== b.open_reviews) return a.open_reviews - b.open_reviews;
      return a.reviewer.localeCompare(b.reviewer);
    });
  const selected = candidates[0];
  if (selected) selected.reason = buildReason(module, selected, candidates);
  return { reviewers: candidates.map((c) => c.reviewer), ranking: candidates, selected };
}

function buildReason(
  module: string,
  selected: ReviewAssignmentRow['ranking'][number],
  candidates: ReviewAssignmentRow['ranking'][number][],
): string {
  const prev = candidates.find((c) => c.reviewer !== selected.reviewer);
  if (!prev || selected.score > prev.score) return `highest expertise score ${selected.score} for ${module}`;
  if (selected.open_reviews !== prev.open_reviews) return `expertise tie broken by load (${selected.open_reviews} vs ${prev.open_reviews})`;
  return `score and load tied; chosen alphabetically`;
}

export async function routeCodeReview(
  userId: string,
  input: {
    projectId?: string | null;
    module: string;
    expertise: ReviewerExpertise[];
    availability: string[];
    loads?: { reviewer: string; open_reviews: number }[];
  },
): Promise<ReviewAssignmentRow> {
  if (!input.module || typeof input.module !== 'string') throw AppError.badRequest('invalid_module', 'a module is required to route a review');
  const expertise = Array.isArray(input.expertise) ? input.expertise : [];
  const availability = Array.isArray(input.availability) ? input.availability : [];
  if (expertise.length === 0) throw AppError.badRequest('empty_expertise', 'expertise map cannot be empty');
  if (availability.length === 0) throw AppError.badRequest('empty_availability', 'no reviewers available to route to');
  for (const e of expertise) {
    if (!e.reviewer || typeof e.reviewer !== 'string') throw AppError.badRequest('invalid_reviewer', 'each expertise entry needs a reviewer');
    if (!Number.isFinite(e.score) || e.score < 0) throw AppError.badRequest('invalid_score', `score for ${e.reviewer} must be a non-negative number`);
  }
  const decision = rankReviewers(input.module, expertise, availability, input.loads ?? []);
  if (!decision.selected) throw AppError.badRequest('no_available_reviewer', `no reviewer in the expertise map is available for ${input.module}`);
  const selected = decision.selected;
  const id = newId(PREFIX.REVIEW_ASSIGNMENT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO review_assignments (id, owner_id, project_id, module, selected_reviewer, expertise_score, open_load, ranking) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.projectId ?? null, input.module, selected.reviewer, selected.score, selected.open_reviews, decision.ranking],
  ));
  await recordAudit({
    action: AuditAction.REVIEW_ROUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'review_assignments',
    resourceId: id,
    detail: { module: input.module, reviewer: decision.selected.reviewer, score: decision.selected.score },
  });
  return getReviewAssignment(userId, id);
}

export async function getReviewAssignment(userId: string, id: string): Promise<ReviewAssignmentRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM review_assignments WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('review_assignment_not_found', 'no review assignment found for that id');
  return rowOf(row);
}

export async function listReviewAssignments(userId: string, filter: { module?: string } = {}): Promise<ReviewAssignmentRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM review_assignments WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.module) rows = rows.filter((r) => r.module === filter.module);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function reviewRouteReport(userId: string): Promise<{
  total: number;
  by_reviewer: Record<string, number>;
}> {
  const rows = await listReviewAssignments(userId);
  const by_reviewer: Record<string, number> = {};
  for (const r of rows) by_reviewer[r.selected_reviewer] = (by_reviewer[r.selected_reviewer] ?? 0) + 1;
  return { total: rows.length, by_reviewer };
}