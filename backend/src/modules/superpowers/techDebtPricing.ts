/**
 * CodeConClave — Superpowers: AUTONOMOUS TECH DEBT MARKET (#152).
 *
 * Continuously prices technical debt: "fixing this now costs 3 days;
 * ignoring it will cost ~40 days within 2 quarters."
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface TechDebtPricingItemRow {
  id: string;
  owner_id: string;
  debt_description: string;
  fix_cost_days: number;
  ignore_cost_days: number;
  urgency_score: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): TechDebtPricingItemRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  debt_description: String(r.debt_description),
  fix_cost_days: Number(r.fix_cost_days),
  ignore_cost_days: Number(r.ignore_cost_days),
  urgency_score: Number(r.urgency_score),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createDebtItem(userId: string, input: { debt_description: string; fix_cost_days: number; ignore_cost_days: number; urgency_score: number }): Promise<TechDebtPricingItemRow> {
  if (!input.debt_description || typeof input.debt_description !== 'string') throw AppError.badRequest('invalid_debt_description', 'a debt description is required');
  if (typeof input.fix_cost_days !== 'number' || input.fix_cost_days < 0) throw AppError.badRequest('invalid_fix_cost_days', 'fix cost days must be a non-negative number');
  if (typeof input.ignore_cost_days !== 'number' || input.ignore_cost_days < 0) throw AppError.badRequest('invalid_ignore_cost_days', 'ignore cost days must be a non-negative number');
  if (typeof input.urgency_score !== 'number') throw AppError.badRequest('invalid_urgency_score', 'urgency score is required');
  const id = newId(PREFIX.TECH_DEBT_PRICE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO tech_debt_pricing_items (id, owner_id, debt_description, fix_cost_days, ignore_cost_days, urgency_score, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.debt_description, input.fix_cost_days, input.ignore_cost_days, input.urgency_score, 'PRICED'],
  ));
  await recordAudit({
    action: AuditAction.DEBT_PRICED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'tech_debt_pricing_items',
    resourceId: id,
    detail: { debt_description: input.debt_description, urgency_score: input.urgency_score },
  });
  return getItem(userId, id);
}

export async function scheduleFix(userId: string, id: string): Promise<TechDebtPricingItemRow> {
  const item = await getItem(userId, id);
  if (item.status === 'FIXED') throw AppError.badRequest('debt_already_fixed', 'this debt item has already been fixed');
  await withTenant(userId, (q) => q.query(
    'UPDATE tech_debt_pricing_items SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'FIX_SCHEDULED', userId],
  ));
  await recordAudit({
    action: AuditAction.DEBT_FIX_SCHEDULED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'tech_debt_pricing_items',
    resourceId: id,
    detail: { debt_description: item.debt_description },
  });
  return getItem(userId, id);
}

export async function getItem(userId: string, id: string): Promise<TechDebtPricingItemRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM tech_debt_pricing_items WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('tech_debt_pricing_item_not_found', 'no tech debt pricing item found for that id');
  return rowOf(row);
}

export async function listItems(userId: string): Promise<TechDebtPricingItemRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM tech_debt_pricing_items WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function techDebtPricingReport(userId: string): Promise<{ items: number; priced: number; fix_scheduled: number; fixed: number }> {
  const items = await listItems(userId);
  return {
    items: items.length,
    priced: items.filter((i) => i.status === 'PRICED').length,
    fix_scheduled: items.filter((i) => i.status === 'FIX_SCHEDULED').length,
    fixed: items.filter((i) => i.status === 'FIXED').length,
  };
}
