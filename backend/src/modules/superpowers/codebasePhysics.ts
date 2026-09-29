/**
 * CodeConClave — Superpowers: CODEBASE PHYSICS ENGINE (#151).
 *
 * A living digital twin of your system: change anything, see simulated effects
 * on latency, cost, reliability, team velocity.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CodebasePhysicsRunRow {
  id: string;
  owner_id: string;
  change_description: string;
  impact_metrics: Record<string, unknown>;
  simulation_result: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): CodebasePhysicsRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  change_description: String(r.change_description),
  impact_metrics: (r.impact_metrics as Record<string, unknown>) ?? {},
  simulation_result: r.simulation_result == null ? null : String(r.simulation_result),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createPhysicsRun(userId: string, input: { change_description: string; impact_metrics: Record<string, unknown> }): Promise<CodebasePhysicsRunRow> {
  if (!input.change_description || typeof input.change_description !== 'string') throw AppError.badRequest('invalid_change_description', 'a change description is required');
  if (!input.impact_metrics || typeof input.impact_metrics !== 'object') throw AppError.badRequest('invalid_impact_metrics', 'impact metrics are required');
  const id = newId(PREFIX.CODEBASE_PHYSICS);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO codebase_physics_runs (id, owner_id, change_description, impact_metrics, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.change_description, input.impact_metrics, 'CREATED'],
  ));
  return getRun(userId, id);
}

export async function simulatePhysics(userId: string, id: string, input: { simulation_result: string }): Promise<CodebasePhysicsRunRow> {
  if (!input.simulation_result || typeof input.simulation_result !== 'string') throw AppError.badRequest('invalid_simulation_result', 'a simulation result is required');
  const run = await getRun(userId, id);
  if (run.status === 'COMPLETED') throw AppError.badRequest('simulation_already_completed', 'this simulation has already completed');
  await withTenant(userId, (q) => q.query(
    'UPDATE codebase_physics_runs SET simulation_result = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.simulation_result, 'COMPLETED', userId],
  ));
  await recordAudit({
    action: AuditAction.PHYSICS_SIMULATION_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'codebase_physics_runs',
    resourceId: id,
    detail: { change_description: run.change_description },
  });
  return getRun(userId, id);
}

export async function getRun(userId: string, id: string): Promise<CodebasePhysicsRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM codebase_physics_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('codebase_physics_run_not_found', 'no codebase physics run found for that id');
  return rowOf(row);
}

export async function listRuns(userId: string): Promise<CodebasePhysicsRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM codebase_physics_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function codebasePhysicsReport(userId: string): Promise<{ runs: number; created: number; running: number; completed: number }> {
  const runs = await listRuns(userId);
  return {
    runs: runs.length,
    created: runs.filter((r) => r.status === 'CREATED').length,
    running: runs.filter((r) => r.status === 'RUNNING').length,
    completed: runs.filter((r) => r.status === 'COMPLETED').length,
  };
}
