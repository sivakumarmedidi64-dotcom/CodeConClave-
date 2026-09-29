/**
 * CodeConClave — Superpowers: COST BADGE (Master Feature #84).
 *
 * Every PR shows infra cost delta: "+~$120/month at current traffic." FinOps
 * inside the review flow, automatic.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type CostComponent = 'feature' | 'scale' | 'storage';

export interface CostEstimateRow {
  id: string;
  owner_id: string;
  context: string;
  component: CostComponent;
  units: number;
  traffic: string;
  delta: number;
  badge: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CostEstimateRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  context: String(r.context),
  component: String(r.component) as CostComponent,
  units: Number(r.units),
  traffic: String(r.traffic),
  delta: Number(r.delta),
  badge: String(r.badge),
  created_at: new Date(r.created_at as string),
});

/** Monthly rate per component: feature → per 10k requests, scale → per replica, storage → per GB. */
export const RATE_FOR: Record<CostComponent, number> = {
  feature: 0.5,
  scale: 30,
  storage: 0.2,
};

export function costDeltaFor(component: CostComponent, units: number): number {
  const divisor = component === 'feature' ? 10000 : 1;
  const raw = (units / divisor) * RATE_FOR[component];
  return Math.round(raw * 100) / 100;
}

export async function estimateCost(userId: string, input: { context: string; component: CostComponent; units: number; traffic: string }): Promise<CostEstimateRow> {
  if (!input.context || typeof input.context !== 'string') throw AppError.badRequest('invalid_context', 'a PR or context label is required');
  if (!['feature', 'scale', 'storage'].includes(input.component)) {
    throw AppError.badRequest('invalid_component', 'components: feature, scale, storage');
  }
  if (typeof input.units !== 'number' || !Number.isFinite(input.units)) throw AppError.badRequest('invalid_units', 'the number of units must be numeric');
  const traffic = typeof input.traffic === 'string' && input.traffic.length > 0 ? input.traffic : 'current traffic';
  const delta = costDeltaFor(input.component, input.units);
  const abs = Math.abs(delta);
  const badge = delta < 0 ? `~$${abs}/month saved at current traffic` : `+~$${delta}/month at current traffic`;
  const id = newId(PREFIX.COST_ESTIMATE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO cost_estimates (id, owner_id, context, component, units, traffic, delta, badge) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.context, input.component, input.units, traffic, delta, badge],
  ));
  await recordAudit({
    action: AuditAction.COST_BADGE_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cost_estimates',
    resourceId: id,
    detail: { context: input.context, delta },
  });
  return getCostEstimate(userId, id);
}

export async function getCostEstimate(userId: string, id: string): Promise<CostEstimateRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM cost_estimates WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('cost_estimate_not_found', 'no cost estimate found for that id');
  return rowOf(row);
}

export async function listCostEstimates(userId: string): Promise<CostEstimateRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM cost_estimates WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function costBadgeReport(userId: string): Promise<{ estimates: number; monthly_delta_total: number }> {
  const list = await listCostEstimates(userId);
  return {
    estimates: list.length,
    monthly_delta_total: Math.round(list.reduce((s, e) => s + e.delta, 0) * 100) / 100,
  };
}