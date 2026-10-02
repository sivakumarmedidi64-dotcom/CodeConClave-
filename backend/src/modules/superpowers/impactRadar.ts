/**
 * CodeConClave — Superpowers: IMPACT RADAR (Master Feature #77).
 *
 * After every release, correlate code changes with product metrics. "This
 * change increased signup completion by 4% — ship more like this."
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ImpactReadingRow {
  id: string;
  owner_id: string;
  area: string;
  metric: string;
  delta: number;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): ImpactReadingRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  area: String(r.area),
  metric: String(r.metric),
  delta: Number(r.delta),
  created_at: new Date(r.created_at as string),
});

export function impactConclude(delta: number): string {
  if (delta > 0) return 'this change helped the metric — ship more like this';
  if (delta < 0) return 'this change hurt the metric — inspect and roll back';
  return 'this change was neutral on the metric';
}

export async function reportImpact(userId: string, input: { area: string; metric: string; delta: number }): Promise<ImpactReadingRow> {
  if (!input.area || typeof input.area !== 'string') throw AppError.badRequest('invalid_area', 'a change area is required');
  if (!input.metric || typeof input.metric !== 'string') throw AppError.badRequest('invalid_metric', 'a product metric is required');
  if (typeof input.delta !== 'number' || !Number.isFinite(input.delta)) throw AppError.badRequest('invalid_delta', 'the metric delta must be a number');
  const id = newId(PREFIX.IMPACT_READING);
  await withTenant(userId, (q) => q.query('INSERT INTO impact_radar (id, owner_id, area, metric, delta) VALUES ($1,$2,$3,$4,$5)', [
    id, userId, input.area, input.metric, input.delta,
  ]));
  await recordAudit({
    action: AuditAction.IMPACT_REPORTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'impact_radar',
    resourceId: id,
    detail: { area: input.area, metric: input.metric, delta: input.delta },
  });
  return getImpactReading(userId, id);
}

export async function getImpactReading(userId: string, id: string): Promise<ImpactReadingRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM impact_radar WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('impact_reading_not_found', 'no impact reading found for that id');
  return rowOf(row);
}

export async function listImpactReadings(userId: string): Promise<ImpactReadingRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM impact_radar WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function radarReport(userId: string): Promise<{ readings: number; positive: number; negative: number; strongest: ImpactReadingRow | null }> {
  const readings = await listImpactReadings(userId);
  let strongest: ImpactReadingRow | null = null;
  for (const r of readings) {
    if (strongest === null || Math.abs(r.delta) > Math.abs(strongest.delta)) strongest = r;
  }
  return {
    readings: readings.length,
    positive: readings.filter((r) => r.delta > 0).length,
    negative: readings.filter((r) => r.delta < 0).length,
    strongest,
  };
}