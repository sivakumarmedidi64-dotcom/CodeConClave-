/**
 * CodeConClave — Superpowers: SELF-PLAY ADVERSARIAL TRAINING (#157).
 *
 * Agents attack and defend your codebase continuously, generating novel failure
 * scenarios no human thought of.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface SelfPlayRunRow {
  id: string;
  owner_id: string;
  attack_vector: string;
  defense_used: string;
  vulnerability_found: string;
  severity: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SelfPlayRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  attack_vector: String(r.attack_vector),
  defense_used: String(r.defense_used ?? ''),
  vulnerability_found: String(r.vulnerability_found ?? ''),
  severity: String(r.severity),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createSelfPlayRun(userId: string, input: { attack_vector: string; defense_used: string }): Promise<SelfPlayRunRow> {
  if (!input.attack_vector || typeof input.attack_vector !== 'string') throw AppError.badRequest('invalid_attack_vector', 'attack vector is required');
  if (!input.defense_used || typeof input.defense_used !== 'string') throw AppError.badRequest('invalid_defense_used', 'defense used is required');
  const id = newId(PREFIX.SELF_PLAY_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO self_play_runs (id, owner_id, attack_vector, defense_used, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.attack_vector, input.defense_used, 'PENDING'],
  ));
  return getSelfPlayRun(userId, id);
}

export async function reportIssue(userId: string, id: string, input: { vulnerability_found: string; severity: string }): Promise<SelfPlayRunRow> {
  if (!input.vulnerability_found || typeof input.vulnerability_found !== 'string') throw AppError.badRequest('invalid_vulnerability_found', 'vulnerability description is required');
  const validSeverities = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (!validSeverities.includes(input.severity)) throw AppError.badRequest('invalid_severity', 'severity must be one of NONE, LOW, MEDIUM, HIGH, CRITICAL');
  const run = await getSelfPlayRun(userId, id);
  if (run.status !== 'PENDING') throw AppError.badRequest('already_completed', 'this run has already been completed');
  await withTenant(userId, (q) => q.query(
    'UPDATE self_play_runs SET vulnerability_found = $2, severity = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, input.vulnerability_found, input.severity, 'COMPLETED', userId],
  ));
  await recordAudit({
    action: AuditAction.SELF_PLAY_ISSUE_FOUND,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'self_play_runs',
    resourceId: id,
    detail: { attack_vector: run.attack_vector, severity: input.severity },
  });
  return getSelfPlayRun(userId, id);
}

export async function getSelfPlayRun(userId: string, id: string): Promise<SelfPlayRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM self_play_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('self_play_run_not_found', 'no self play run found for that id');
  return rowOf(row);
}

export async function listSelfPlayRuns(userId: string): Promise<SelfPlayRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM self_play_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function selfPlayReport(userId: string): Promise<{ runs: number; pending: number; completed: number; issues_found: number }> {
  const runs = await listSelfPlayRuns(userId);
  return {
    runs: runs.length,
    pending: runs.filter((r) => r.status === 'PENDING').length,
    completed: runs.filter((r) => r.status === 'COMPLETED').length,
    issues_found: runs.filter((r) => r.vulnerability_found !== '').length,
  };
}
