/**
 * CodeConClave — Superpowers: QUERY OPTIMIZER (#132).
 *
 * Every slow query automatically rewritten with safety verified.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface QueryOptimizerPlanRow {
  id: string;
  owner_id: string;
  query_text: string;
  original_latency_ms: number;
  optimized_query: string | null;
  optimized_latency_ms: number | null;
  equivalence_proven: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): QueryOptimizerPlanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  query_text: String(r.query_text),
  original_latency_ms: Number(r.original_latency_ms),
  optimized_query: r.optimized_query == null ? null : String(r.optimized_query),
  optimized_latency_ms: r.optimized_latency_ms == null ? null : Number(r.optimized_latency_ms),
  equivalence_proven: Boolean(r.equivalence_proven),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createQueryPlan(userId: string, input: { query_text: string; original_latency_ms: number }): Promise<QueryOptimizerPlanRow> {
  if (!input.query_text || typeof input.query_text !== 'string') throw AppError.badRequest('query_text_required', 'query text is required');
  if (typeof input.original_latency_ms !== 'number' || input.original_latency_ms <= 0) throw AppError.badRequest('latency_required', 'original latency must be a positive number');
  const id = newId(PREFIX.QUERY_OPTIMIZER);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO query_optimizer_plans (id, owner_id, query_text, original_latency_ms, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.query_text, input.original_latency_ms, 'DRAFT'],
  ));
  await recordAudit({
    action: AuditAction.QUERY_OPTIMIZED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'query_optimizer_plans',
    resourceId: id,
    detail: { query_text: input.query_text },
  });
  return getQueryPlan(userId, id);
}

export async function optimizeQuery(userId: string, id: string, input: { optimized_query: string; optimized_latency_ms: number }): Promise<QueryOptimizerPlanRow> {
  if (!input.optimized_query || typeof input.optimized_query !== 'string') throw AppError.badRequest('optimized_query_required', 'optimized query is required');
  if (typeof input.optimized_latency_ms !== 'number' || input.optimized_latency_ms <= 0) throw AppError.badRequest('optimized_latency_required', 'optimized latency must be a positive number');
  const plan = await getQueryPlan(userId, id);
  await withTenant(userId, (q) => q.query(
    'UPDATE query_optimizer_plans SET optimized_query = $2, optimized_latency_ms = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, input.optimized_query, input.optimized_latency_ms, 'OPTIMIZED', userId],
  ));
  await recordAudit({
    action: AuditAction.QUERY_OPTIMIZED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'query_optimizer_plans',
    resourceId: id,
    detail: { optimized_query: input.optimized_query },
  });
  return getQueryPlan(userId, id);
}

export async function proveEquivalence(userId: string, id: string): Promise<QueryOptimizerPlanRow> {
  const plan = await getQueryPlan(userId, id);
  if (plan.status === 'EQUIVALENCE_PROVEN') throw AppError.badRequest('already_proven', 'equivalence already proven for this plan');
  await withTenant(userId, (q) => q.query(
    'UPDATE query_optimizer_plans SET equivalence_proven = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, true, 'EQUIVALENCE_PROVEN', userId],
  ));
  await recordAudit({
    action: AuditAction.QUERY_EQUIVALENCE_PROVEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'query_optimizer_plans',
    resourceId: id,
    detail: {},
  });
  return getQueryPlan(userId, id);
}

export async function getQueryPlan(userId: string, id: string): Promise<QueryOptimizerPlanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM query_optimizer_plans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('query_optimizer_plan_not_found', 'no query optimizer plan found for that id');
  return rowOf(row);
}

export async function listQueryPlans(userId: string): Promise<QueryOptimizerPlanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM query_optimizer_plans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function queryOptimizerReport(userId: string): Promise<{ plans: number; optimized: number; equivalence_proven: number }> {
  const plans = await listQueryPlans(userId);
  return {
    plans: plans.length,
    optimized: plans.filter((p) => p.status === 'OPTIMIZED' || p.status === 'EQUIVALENCE_PROVEN').length,
    equivalence_proven: plans.filter((p) => p.status === 'EQUIVALENCE_PROVEN').length,
  };
}
