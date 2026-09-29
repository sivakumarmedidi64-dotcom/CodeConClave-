/**
 * CodeConClave — Superpowers: REVIEW LOAD BALANCER (Master Feature #137).
 *
 * Distributes PR reviews across reviewers by expertise, availability, current
 * load and past review quality — so one person never drowns in reviews and
 * no PR starves for a reviewer.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ReviewLoadItem {
  pr: string;
  module: string;
}

export interface LoadReviewer {
  name: string;
  modules: string[];
  availability: boolean;
  max_open: number;
  quality: number;
}

export interface LoadPlanEntry {
  pr: string;
  module: string;
  reviewer: string | null;
  reason: string;
}

export interface ReviewLoadPlanRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  item_count: number;
  assigned: number;
  plan: LoadPlanEntry[];
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): ReviewLoadPlanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  item_count: Number(r.item_count),
  assigned: Number(r.assigned),
  plan: (r.plan ?? []) as LoadPlanEntry[],
  created_at: new Date(r.created_at as string),
});

export function balanceReviewLoad(items: ReviewLoadItem[], reviewers: LoadReviewer[]): LoadPlanEntry[] {
  const loads = new Map(reviewers.map((rv) => [rv.name, 0]));
  const entries: LoadPlanEntry[] = [];
  for (const item of items) {
    const eligible = reviewers
      .filter((rv) => rv.availability && rv.modules.includes(item.module))
      .map((rv) => ({ name: rv.name, quality: rv.quality, current: loads.get(rv.name) ?? 0, max: rv.max_open }))
      .filter((rv) => rv.current < rv.max)
      .sort((a, b) => b.quality - a.quality || a.current - b.current || a.name.localeCompare(b.name));
    const chosen = eligible[0];
    if (!chosen) {
      entries.push({ pr: item.pr, module: item.module, reviewer: null, reason: `no available reviewer for ${item.module} with spare capacity` });
      continue;
    }
    loads.set(chosen.name, chosen.current + 1);
    entries.push({ pr: item.pr, module: item.module, reviewer: chosen.name, reason: `quality ${chosen.quality}, load ${chosen.current} of ${chosen.max}` });
  }
  return entries;
}

export async function balanceReviews(
  userId: string,
  input: { projectId?: string | null; items: ReviewLoadItem[]; reviewers: LoadReviewer[] },
): Promise<ReviewLoadPlanRow> {
  const items = Array.isArray(input.items) ? input.items : [];
  const reviewers = Array.isArray(input.reviewers) ? input.reviewers : [];
  if (items.length === 0) throw AppError.badRequest('empty_items', 'a review batch needs at least one PR');
  if (reviewers.length === 0) throw AppError.badRequest('empty_reviewers', 'at least one reviewer is needed to balance load');
  for (const item of items) {
    if (!item.pr || typeof item.pr !== 'string') throw AppError.badRequest('invalid_pr', 'each item needs a pr reference');
    if (!item.module || typeof item.module !== 'string') throw AppError.badRequest('invalid_module', `each item for ${item.pr} needs a module`);
  }
  for (const rv of reviewers) {
    if (!rv.name || typeof rv.name !== 'string') throw AppError.badRequest('invalid_reviewer', 'each reviewer needs a name');
    if (!Array.isArray(rv.modules)) throw AppError.badRequest('invalid_reviewer_modules', `reviewer ${rv.name} needs a module list`);
    if (!Number.isFinite(rv.max_open) || rv.max_open < 0) throw AppError.badRequest('invalid_capacity', `max_open for ${rv.name} must be a non-negative number`);
    if (!Number.isFinite(rv.quality) || rv.quality < 0 || rv.quality > 1) throw AppError.badRequest('invalid_quality', `quality for ${rv.name} must be between 0 and 1`);
  }
  const plan = balanceReviewLoad(items, reviewers);
  const assigned = plan.filter((p) => p.reviewer !== null).length;
  const id = newId(PREFIX.REVIEW_LOAD_PLAN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO review_load_plans (id, owner_id, project_id, item_count, assigned, plan) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.projectId ?? null, items.length, assigned, plan],
  ));
  await recordAudit({
    action: AuditAction.REVIEW_LOAD_BALANCED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'review_load_plans',
    resourceId: id,
    detail: { items: items.length, assigned },
  });
  return getReviewLoadPlan(userId, id);
}

export async function getReviewLoadPlan(userId: string, id: string): Promise<ReviewLoadPlanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM review_load_plans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('review_load_plan_not_found', 'no review load plan found for that id');
  return rowOf(row);
}

export async function listReviewLoadPlans(userId: string): Promise<ReviewLoadPlanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM review_load_plans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function reviewLoadReport(userId: string): Promise<{
  plans: number;
  items: number;
  assigned: number;
  unassigned: number;
}> {
  const rows = await listReviewLoadPlans(userId);
  const items = rows.reduce((acc, r) => acc + r.item_count, 0);
  const assigned = rows.reduce((acc, r) => acc + r.assigned, 0);
  return { plans: rows.length, items, assigned, unassigned: items - assigned };
}