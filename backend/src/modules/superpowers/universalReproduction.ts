/**
 * CodeConClave — Superpowers: UNIVERSAL REPRODUCTION (Feature #159).
 *
 * Bug report → reconstruct customer's exact state (version, data, flags,
 * device, network) and reproduce it.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface UniversalReproRunRow {
  id: string;
  owner_id: string;
  bug_description: string;
  version: string;
  data_state: string;
  flags: string[];
  device: string;
  network: string;
  status: string;
  result: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): UniversalReproRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  bug_description: String(r.bug_description),
  version: String(r.version),
  data_state: String(r.data_state),
  flags: Array.isArray(r.flags) ? r.flags.map(String) : typeof r.flags === 'string' ? JSON.parse(r.flags) : [],
  device: String(r.device),
  network: String(r.network),
  status: String(r.status),
  result: r.result == null ? null : String(r.result),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createReproRun(userId: string, input: { bug_description: string; version: string; data_state: string; flags: string[]; device: string; network: string }): Promise<UniversalReproRunRow> {
  if (!input.bug_description || typeof input.bug_description !== 'string') throw AppError.badRequest('invalid_bug_description', 'bug description is required');
  if (!input.version || typeof input.version !== 'string') throw AppError.badRequest('invalid_version', 'version is required');
  const id = newId(PREFIX.UNIVERSAL_REPRO);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO universal_repro_runs (id, owner_id, bug_description, version, data_state, flags, device, network, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.bug_description, input.version, input.data_state, input.flags, input.device, input.network, 'ATTEMPTED'],
  ));
  await recordAudit({
    action: AuditAction.REPRODUCTION_ATTEMPTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'universal_repro_runs',
    resourceId: id,
    detail: { bug_description: input.bug_description },
  });
  return getReproRun(userId, id);
}

export async function confirmReproduction(userId: string, id: string, input: { result: string }): Promise<UniversalReproRunRow> {
  if (!input.result || typeof input.result !== 'string') throw AppError.badRequest('invalid_result', 'result is required to confirm reproduction');
  const run = await getReproRun(userId, id);
  if (run.status === 'CONFIRMED') throw AppError.badRequest('already_confirmed', 'reproduction already confirmed');
  await withTenant(userId, (q) => q.query(
    'UPDATE universal_repro_runs SET result = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.result, 'CONFIRMED', userId],
  ));
  await recordAudit({
    action: AuditAction.REPRODUCTION_CONFIRMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'universal_repro_runs',
    resourceId: id,
    detail: { result: input.result },
  });
  return getReproRun(userId, id);
}

export async function getReproRun(userId: string, id: string): Promise<UniversalReproRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM universal_repro_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('universal_repro_run_not_found', 'no repro run found for that id');
  return rowOf(row);
}

export async function listReproRuns(userId: string): Promise<UniversalReproRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM universal_repro_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function universalReproReport(userId: string): Promise<{ runs: number; attempted: number; confirmed: number }> {
  const runs = await listReproRuns(userId);
  return {
    runs: runs.length,
    attempted: runs.filter((r) => r.status === 'ATTEMPTED').length,
    confirmed: runs.filter((r) => r.status === 'CONFIRMED').length,
  };
}
