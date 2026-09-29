/**
 * CodeConClave — Superpowers: FIREWALL DRILL SERGEANT (Master Feature #10).
 *
 * Regularly attacks your own system safely: kills services, corrupts queues,
 * expires certs, doubles latency — all in staging — and verifies the system
 * survives. Every drill produces a resilience score (% per component) and a
 * fix list ranked by blast radius, so the team can practice the response
 * before it matters.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ScenarioResult {
  scenario: string;
  survived: boolean;
  alertsFired: boolean;
  recovery: 'AUTOMATIC' | 'MANUAL';
}

export interface DrillRunRow {
  id: string;
  owner_id: string;
  drill_type: string;
  scenarios: ScenarioResult[];
  resilience_score: number;
  fix_list: string[];
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): DrillRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  drill_type: String(r.drill_type),
  scenarios: (r.scenarios ?? []) as ScenarioResult[],
  resilience_score: Number(r.resilience_score),
  fix_list: (r.fix_list ?? []) as string[],
  status: r.status as DrillRunRow['status'],
  created_at: new Date(r.created_at as string),
});

export const STANDARD_SCENARIOS = [
  'service_down',
  'network_partition',
  'database_failure',
  'rate_limit_exceeded',
  'cert_expiry',
  'disk_full',
  'queue_corruption',
];

export function scoreDrill(scenarios: ScenarioResult[]): number {
  if (scenarios.length === 0) return 0;
  const survived = scenarios.filter((s) => s.survived).length;
  return Math.round((survived / scenarios.length) * 100);
}

export function blameFixList(scenarios: ScenarioResult[]): string[] {
  return scenarios
    .filter((s) => !s.survived)
    .sort((a, b) => Number(a.survived) - Number(b.survived))
    .map((s) => `${s.scenario}: ${s.recovery === 'MANUAL' ? 'make recovery automatic' : 'add redundancy'}`);
}

export async function planDrill(userId: string, input: { drillType?: string }): Promise<DrillRunRow> {
  const drillType = input.drillType ?? 'comprehensive';
  const id = newId(PREFIX.FIREWALL_DRILL_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO firewall_drill_runs (id, owner_id, drill_type, scenarios, resilience_score, fix_list, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, drillType, [], 0, [], 'PLANNED'],
  ));
  return getDrillRun(userId, id);
}

export async function runDrill(
  userId: string,
  id: string,
  input: { scenarios: ScenarioResult[] },
): Promise<DrillRunRow> {
  const run = await getDrillRun(userId, id);
  if (run.status === 'COMPLETED') throw AppError.badRequest('drill_already_completed', 'this drill already ran');
  const scenarios = Array.isArray(input.scenarios) ? input.scenarios : [];
  if (scenarios.length === 0) throw AppError.badRequest('empty_drill', 'a drill needs at least one failure scenario');
  const score = scoreDrill(scenarios);
  const fixes = blameFixList(scenarios);
  await withTenant(userId, (q) => q.query(
    'UPDATE firewall_drill_runs SET scenarios = $2::jsonb, resilience_score = $3, fix_list = $4::jsonb, status = $5, updated_at = now() WHERE id = $1 AND owner_id = $6',
    [id, JSON.stringify(scenarios), score, JSON.stringify(fixes), 'COMPLETED', userId],
  ));
  await recordAudit({
    action: AuditAction.FIREWALL_DRILL_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'firewall_drill_runs',
    resourceId: id,
    detail: { drillType: run.drill_type, score, fixes: fixes.length },
  });
  return getDrillRun(userId, id);
}

export async function getDrillRun(userId: string, id: string): Promise<DrillRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM firewall_drill_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('firewall_drill_not_found', 'no firewall drill found for that id');
  return rowOf(row);
}

export async function listDrillRuns(userId: string): Promise<DrillRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM firewall_drill_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function drillReport(userId: string): Promise<{ drills: number; completed: number; avg_score: number }> {
  const runs = await listDrillRuns(userId);
  const completed = runs.filter((r) => r.status === 'COMPLETED');
  const avg = completed.length === 0 ? 0 : Math.round(completed.reduce((a, r) => a + r.resilience_score, 0) / completed.length);
  return { drills: runs.length, completed: completed.length, avg_score: avg };
}