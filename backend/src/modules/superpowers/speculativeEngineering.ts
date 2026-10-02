/**
 * CodeConClave — Superpowers: SPECULATIVE ENGINEERING (#148).
 *
 * Explores 3-5 futures of the codebase in parallel: all measured, all discardable.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface SpeculativeEngineeringLaneRow {
  id: string;
  owner_id: string;
  hypothesis: string;
  alternatives: string[];
  measured_result: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SpeculativeEngineeringLaneRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  hypothesis: String(r.hypothesis),
  alternatives: Array.isArray(r.alternatives) ? (r.alternatives as string[]) : [],
  measured_result: r.measured_result == null ? null : String(r.measured_result),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function openLane(userId: string, input: { hypothesis: string; alternatives: string[] }): Promise<SpeculativeEngineeringLaneRow> {
  if (!input.hypothesis || typeof input.hypothesis !== 'string') throw AppError.badRequest('invalid_hypothesis', 'a hypothesis is required');
  if (!input.alternatives || !Array.isArray(input.alternatives) || input.alternatives.length === 0) throw AppError.badRequest('invalid_alternatives', 'at least one alternative is required');
  const id = newId(PREFIX.SPECULATIVE_ENGINEERING);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO speculative_engineering_lanes (id, owner_id, hypothesis, alternatives, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.hypothesis, input.alternatives, 'OPEN'],
  ));
  await recordAudit({
    action: AuditAction.SPECULATION_LANE_OPENED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'speculative_engineering_lanes',
    resourceId: id,
    detail: { hypothesis: input.hypothesis },
  });
  return getLane(userId, id);
}

export async function measureLane(userId: string, id: string, input: { measured_result: string }): Promise<SpeculativeEngineeringLaneRow> {
  if (!input.measured_result || typeof input.measured_result !== 'string') throw AppError.badRequest('invalid_measured_result', 'measured result is required');
  const lane = await getLane(userId, id);
  if (lane.status !== 'OPEN') throw AppError.badRequest('lane_not_open', 'only open lanes can be measured');
  await withTenant(userId, (q) => q.query(
    'UPDATE speculative_engineering_lanes SET measured_result = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.measured_result, 'MEASURED', userId],
  ));
  await recordAudit({
    action: AuditAction.SPECULATION_LANE_MEASURED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'speculative_engineering_lanes',
    resourceId: id,
    detail: { measured_result: input.measured_result },
  });
  return getLane(userId, id);
}

export async function getLane(userId: string, id: string): Promise<SpeculativeEngineeringLaneRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM speculative_engineering_lanes WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('speculative_engineering_lane_not_found', 'no speculative engineering lane found for that id');
  return rowOf(row);
}

export async function listLanes(userId: string): Promise<SpeculativeEngineeringLaneRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM speculative_engineering_lanes WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function speculativeEngineeringReport(userId: string): Promise<{ lanes: number; open: number; measured: number; discarded: number }> {
  const lanes = await listLanes(userId);
  return {
    lanes: lanes.length,
    open: lanes.filter((l) => l.status === 'OPEN').length,
    measured: lanes.filter((l) => l.status === 'MEASURED').length,
    discarded: lanes.filter((l) => l.status === 'DISCARDED').length,
  };
}
