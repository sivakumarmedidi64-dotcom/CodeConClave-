/**
 * CodeConClave — Superpowers: COST THERMOMETER (Master Feature #85).
 *
 * Every PR shows its infrastructure cost delta — performance AND price merged
 * in the review. The thermometer reads the live spend trend across the full
 * set of cost estimates: cool, warm, hot, boiling.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ThermometerRow {
  id: string;
  owner_id: string;
  total_delta: number;
  temperature: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): ThermometerRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  total_delta: Number(r.total_delta),
  temperature: String(r.temperature),
  created_at: new Date(r.created_at as string),
});

export function temperatureFor(total: number): string {
  const t = Math.abs(total);
  if (t >= 500) return 'boiling';
  if (t >= 100) return 'hot';
  if (t >= 25) return 'warm';
  return 'cool';
}

export async function takeThermometerReading(userId: string): Promise<ThermometerRow> {
  const estimates = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM cost_estimates WHERE owner_id = $1', [userId])).rows,
  );
  const total = Math.round(estimates.reduce((s, e) => s + Number(e.delta ?? 0), 0) * 100) / 100;
  const temperature = temperatureFor(total);
  const id = newId(PREFIX.COST_THERMOMETER);
  await withTenant(userId, (q) =>
    q.query('INSERT INTO cost_thermometers (id, owner_id, total_delta, temperature) VALUES ($1,$2,$3,$4)', [
      id, userId, total, temperature,
    ]),
  );
  await recordAudit({
    action: AuditAction.COST_THERMOMETER_READING,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cost_thermometers',
    resourceId: id,
    detail: { total, temperature },
  });
  return getThermometerReading(userId, id);
}

export async function getThermometerReading(userId: string, id: string): Promise<ThermometerRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    q
      .query<Record<string, unknown>>('SELECT * FROM cost_thermometers WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('cost_reading_not_found', 'no cost reading found for that id');
  return rowOf(row);
}

export async function listReadings(userId: string): Promise<ThermometerRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM cost_thermometers WHERE owner_id = $1', [userId])).rows,
  );
  return rows.map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function thermometerReport(userId: string): Promise<{ readings: number; latest: ThermometerRow | null }> {
  const readings = await listReadings(userId);
  return { readings: readings.length, latest: readings[0] ?? null };
}