/**
 * CodeConClave — Superpowers: QUERY WHISPERER (Feature #123).
 *
 * Explains any SQL/ORM query's actual execution plan in plain language;
 * rewrites it with measured improvement.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface QueryWhispererPlanRow {
  id: string;
  owner_id: string;
  query_text: string;
  execution_plan: string;
  rewritten_query: string;
  improvement_pct: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): QueryWhispererPlanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  query_text: String(r.query_text),
  execution_plan: String(r.execution_plan),
  rewritten_query: String(r.rewritten_query),
  improvement_pct: Number(r.improvement_pct ?? 0),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createQueryPlan(userId: string, input: { query_text: string }): Promise<QueryWhispererPlanRow> {
  if (!input.query_text || typeof input.query_text !== 'string') throw AppError.badRequest('invalid_query_text', 'query text is required');
  const id = newId(PREFIX.QUERY_WHISPERER);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO query_whisperer_plans (id, owner_id, query_text, status) VALUES ($1,$2,$3,$4)',
    [id, userId, input.query_text, 'EXPLAINED'],
  ));
  await recordAudit({
    action: AuditAction.QUERY_EXPLAINED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'query_whisperer_plans',
    resourceId: id,
    detail: { query_text: input.query_text },
  });
  return getQueryWhisperer(userId, id);
}

export async function explainQuery(userId: string, id: string, input: { execution_plan: string; improvement_pct: number }): Promise<QueryWhispererPlanRow> {
  await getQueryWhisperer(userId, id);
  if (!input.execution_plan || typeof input.execution_plan !== 'string') throw AppError.badRequest('invalid_execution_plan', 'execution plan is required');
  await withTenant(userId, (q) => q.query(
    'UPDATE query_whisperer_plans SET execution_plan = $2, improvement_pct = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.execution_plan, input.improvement_pct ?? 0, userId],
  ));
  await recordAudit({
    action: AuditAction.QUERY_EXPLAINED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'query_whisperer_plans',
    resourceId: id,
    detail: { execution_plan: input.execution_plan },
  });
  return getQueryWhisperer(userId, id);
}

export async function rewriteQuery(userId: string, id: string, input: { rewritten_query: string; improvement_pct: number }): Promise<QueryWhispererPlanRow> {
  await getQueryWhisperer(userId, id);
  if (!input.rewritten_query || typeof input.rewritten_query !== 'string') throw AppError.badRequest('invalid_rewritten_query', 'rewritten query is required');
  await withTenant(userId, (q) => q.query(
    'UPDATE query_whisperer_plans SET rewritten_query = $2, improvement_pct = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, input.rewritten_query, input.improvement_pct ?? 0, 'REWRITTEN', userId],
  ));
  await recordAudit({
    action: AuditAction.QUERY_REWRITTEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'query_whisperer_plans',
    resourceId: id,
    detail: { rewritten_query: input.rewritten_query },
  });
  return getQueryWhisperer(userId, id);
}

export async function getQueryWhisperer(userId: string, id: string): Promise<QueryWhispererPlanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM query_whisperer_plans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('query_whisperer_plan_not_found', 'no query whisperer plan found for that id');
  return rowOf(row);
}

export async function listQueryWhisperers(userId: string): Promise<QueryWhispererPlanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM query_whisperer_plans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function queryWhispererReport(userId: string): Promise<{ plans: number; explained: number; rewritten: number }> {
  const plans = await listQueryWhisperers(userId);
  return {
    plans: plans.length,
    explained: plans.filter((p) => p.status === 'EXPLAINED').length,
    rewritten: plans.filter((p) => p.status === 'REWRITTEN').length,
  };
}
