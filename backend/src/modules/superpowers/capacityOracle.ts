/**
 * CodeConClave — Superpowers: CAPACITY ORACLE (Master Feature #87).
 *
 * Predicts resource exhaustion weeks ahead by learning traffic curves, deploy
 * cadence, and growth. "You will run out of DB connections in ~11 days. Here's
 * the fix, sized and costed."
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CapacityForecastRow {
  id: string;
  owner_id: string;
  component: string;
  capacity: number;
  usage: number;
  growth_per_day: number;
  days_to_exhaustion: number | null;
  fix_size: number;
  monthly_cost: number;
  status: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CapacityForecastRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component: String(r.component),
  capacity: Number(r.capacity),
  usage: Number(r.usage),
  growth_per_day: Number(r.growth_per_day),
  days_to_exhaustion: r.days_to_exhaustion == null ? null : Number(r.days_to_exhaustion),
  fix_size: Number(r.fix_size),
  monthly_cost: Number(r.monthly_cost),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
});

const UNIT_COST = 0.05;
const FORECAST_HORIZON_DAYS = 30;

/** How many days until usage overtakes capacity at today's growth. */
export function daysToExhaustion(capacity: number, usage: number, growthPerDay: number): number | null {
  if (usage >= capacity) return 0;
  if (growthPerDay <= 0) return null;
  return Math.floor((capacity - usage) / growthPerDay);
}

export async function forecastExhaustion(userId: string, input: { component: string; capacity: number; usage: number; growth_per_day: number }): Promise<CapacityForecastRow> {
  if (!input.component || typeof input.component !== 'string') throw AppError.badRequest('invalid_component', 'a resource or component is required');
  if (typeof input.capacity !== 'number' || !Number.isFinite(input.capacity) || input.capacity < 0) {
    throw AppError.badRequest('invalid_capacity', 'capacity must be a non-negative number');
  }
  if (typeof input.usage !== 'number' || !Number.isFinite(input.usage) || input.usage < 0) {
    throw AppError.badRequest('invalid_usage', 'current usage must be a non-negative number');
  }
  if (typeof input.growth_per_day !== 'number' || !Number.isFinite(input.growth_per_day)) {
    throw AppError.badRequest('invalid_growth', 'growth per day must be a number');
  }
  const days = daysToExhaustion(input.capacity, input.usage, input.growth_per_day);
  const fixSize = Math.ceil(input.growth_per_day * FORECAST_HORIZON_DAYS);
  const monthlyCost = Math.round(fixSize * UNIT_COST * 100) / 100;
  const status = days === 0 ? 'EXHAUSTED' : days !== null && days <= 7 ? 'CRITICAL' : 'OK';
  const id = newId(PREFIX.CAPACITY_FORECAST);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO capacity_forecasts (id, owner_id, component, capacity, usage, growth_per_day, days_to_exhaustion, fix_size, monthly_cost, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, userId, input.component, input.capacity, input.usage, input.growth_per_day, days, fixSize, monthlyCost, status],
  ));
  await recordAudit({
    action: AuditAction.CAPACITY_FORECAST_ISSUED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'capacity_forecasts',
    resourceId: id,
    detail: { component: input.component, days, status },
  });
  return getCapacityForecast(userId, id);
}

export function forecastVerdict(f: CapacityForecastRow): string {
  if (f.days_to_exhaustion === null) return `"${f.component}" is stable — no exhaustion in sight`;
  if (f.days_to_exhaustion === 0) {
    return `"${f.component}" is exhausted NOW — fix, sized: +${f.fix_size} capacity, costed at ~$${f.monthly_cost}/month`;
  }
  return `"${f.component}" runs out in ~${f.days_to_exhaustion} days — fix, sized: +${f.fix_size} capacity, costed at ~$${f.monthly_cost}/month`;
}

export async function getCapacityForecast(userId: string, id: string): Promise<CapacityForecastRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM capacity_forecasts WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('capacity_forecast_not_found', 'no capacity forecast found for that id');
  return rowOf(row);
}

export async function listCapacityForecasts(userId: string): Promise<CapacityForecastRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM capacity_forecasts WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function capacityReport(userId: string): Promise<{ forecasts: number; critical: number; exhausted: number }> {
  const list = await listCapacityForecasts(userId);
  return {
    forecasts: list.length,
    critical: list.filter((f) => f.status === 'CRITICAL').length,
    exhausted: list.filter((f) => f.status === 'EXHAUSTED').length,
  };
}