/**
 * CodeConClave — Superpowers: ORGANIZATIONAL SIMULATOR (#150).
 *
 * "What if we split this team / add 3 engineers / migrate this service?"
 * Simulated against your own historical data.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface OrgSimulatorRunRow {
  id: string;
  owner_id: string;
  scenario: string;
  baseline_metrics: Record<string, unknown>;
  simulation_result: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): OrgSimulatorRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  scenario: String(r.scenario),
  baseline_metrics: (r.baseline_metrics as Record<string, unknown>) ?? {},
  simulation_result: r.simulation_result == null ? null : String(r.simulation_result),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createSimulation(userId: string, input: { scenario: string; baseline_metrics: Record<string, unknown> }): Promise<OrgSimulatorRunRow> {
  if (!input.scenario || typeof input.scenario !== 'string') throw AppError.badRequest('invalid_scenario', 'a scenario is required');
  if (!input.baseline_metrics || typeof input.baseline_metrics !== 'object') throw AppError.badRequest('invalid_baseline_metrics', 'baseline metrics are required');
  const id = newId(PREFIX.ORG_SIMULATOR);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO org_simulator_runs (id, owner_id, scenario, baseline_metrics, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.scenario, input.baseline_metrics, 'CREATED'],
  ));
  return getRun(userId, id);
}

export async function runSimulation(userId: string, id: string, input: { simulation_result: string }): Promise<OrgSimulatorRunRow> {
  if (!input.simulation_result || typeof input.simulation_result !== 'string') throw AppError.badRequest('invalid_simulation_result', 'a simulation result is required');
  const run = await getRun(userId, id);
  if (run.status === 'COMPLETED') throw AppError.badRequest('simulation_already_completed', 'this simulation has already completed');
  await withTenant(userId, (q) => q.query(
    'UPDATE org_simulator_runs SET simulation_result = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.simulation_result, 'COMPLETED', userId],
  ));
  await recordAudit({
    action: AuditAction.ORG_SIMULATION_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'org_simulator_runs',
    resourceId: id,
    detail: { scenario: run.scenario },
  });
  return getRun(userId, id);
}

export async function getRun(userId: string, id: string): Promise<OrgSimulatorRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM org_simulator_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('org_simulator_run_not_found', 'no org simulator run found for that id');
  return rowOf(row);
}

export async function listRuns(userId: string): Promise<OrgSimulatorRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM org_simulator_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function orgSimulatorReport(userId: string): Promise<{ runs: number; created: number; running: number; completed: number }> {
  const runs = await listRuns(userId);
  return {
    runs: runs.length,
    created: runs.filter((r) => r.status === 'CREATED').length,
    running: runs.filter((r) => r.status === 'RUNNING').length,
    completed: runs.filter((r) => r.status === 'COMPLETED').length,
  };
}
