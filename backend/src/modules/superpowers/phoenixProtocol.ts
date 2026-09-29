/**
 * CodeConClave — Superpowers: PHOENIX PROTOCOL (Master Feature #3).
 *
 * CI pipeline fails -> reproduce at the exact commit with the exact env ->
 * fix -> run the full suite -> only open a PR once the suite is green.
 * Recurring flaky failures get faster to solve because lessons accumulate.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type PhoenixStatus = 'REPRODUCED' | 'FIX_READY' | 'SUITE_GREEN' | 'PR_OPENED';

export interface PhoenixCycleRow {
  id: string;
  owner_id: string;
  pipeline: string;
  commit: string;
  failure: string;
  env: Record<string, string>;
  status: PhoenixStatus;
  fix?: string;
  suite_result?: string;
  pr_number?: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): PhoenixCycleRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  pipeline: String(r.pipeline),
  commit: String(r.commit),
  failure: String(r.failure),
  env: (r.env ?? {}) as Record<string, string>,
  status: r.status as PhoenixStatus,
  fix: r.fix ? String(r.fix) : undefined,
  suite_result: r.suite_result ? String(r.suite_result) : undefined,
  pr_number: r.pr_number ? String(r.pr_number) : undefined,
  created_at: new Date(r.created_at as string),
});

export async function startPhoenixCycle(
  userId: string,
  input: { pipeline: string; commit: string; failure: string; env?: Record<string, string> },
): Promise<PhoenixCycleRow> {
  if (!input.pipeline || typeof input.pipeline !== 'string') throw AppError.badRequest('invalid_pipeline', 'a pipeline is required');
  if (!input.commit || typeof input.commit !== 'string') throw AppError.badRequest('invalid_commit', 'the failing commit is required');
  if (!input.failure || typeof input.failure !== 'string') throw AppError.badRequest('invalid_failure', 'the failure description is required');
  const id = newId(PREFIX.PHOENIX_CYCLE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO phoenix_cycles (id, owner_id, pipeline, commit, failure, env, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.pipeline, input.commit, input.failure, input.env ?? {}, 'REPRODUCED'],
  ));
  await recordAudit({
    action: AuditAction.PHOENIX_RECOVERY_STEP,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'phoenix_cycles',
    resourceId: id,
    detail: { pipeline: input.pipeline, commit: input.commit, step: 'REPRODUCED' },
  });
  return getPhoenixCycle(userId, id);
}

export async function applyPhoenixFix(userId: string, id: string, fix: string): Promise<PhoenixCycleRow> {
  const cycle = await getPhoenixCycle(userId, id);
  if (cycle.status !== 'REPRODUCED') throw AppError.badRequest('phoenix_wrong_step', `cannot apply fix from step ${cycle.status}; expected REPRODUCED`);
  if (!fix || typeof fix !== 'string') throw AppError.badRequest('invalid_fix', 'a fix patch is required');
  await withTenant(userId, (q) => q.query('UPDATE phoenix_cycles SET fix = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, fix, 'FIX_READY', userId]));
  await recordAudit({
    action: AuditAction.PHOENIX_RECOVERY_STEP,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'phoenix_cycles',
    resourceId: id,
    detail: { id, step: 'FIX_READY' },
  });
  return getPhoenixCycle(userId, id);
}

export async function confirmPhoenixSuite(userId: string, id: string, suiteResult: string): Promise<PhoenixCycleRow> {
  const cycle = await getPhoenixCycle(userId, id);
  if (cycle.status !== 'FIX_READY') throw AppError.badRequest('phoenix_wrong_step', `cannot confirm suite from step ${cycle.status}; expected FIX_READY`);
  if (!suiteResult || typeof suiteResult !== 'string') throw AppError.badRequest('invalid_suite', 'a suite result is required');
  const green = /pass/i.test(suiteResult) && !/fail/i.test(suiteResult);
  const next = green ? 'SUITE_GREEN' : 'FIX_READY';
  await withTenant(userId, (q) => q.query('UPDATE phoenix_cycles SET suite_result = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [
    id,
    suiteResult,
    next,
    userId,
  ]));
  await recordAudit({
    action: AuditAction.PHOENIX_RECOVERY_STEP,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'phoenix_cycles',
    resourceId: id,
    detail: { id, step: next, suite: suiteResult },
  });
  return getPhoenixCycle(userId, id);
}

export async function openPhoenixPr(userId: string, id: string, prNumber: string): Promise<PhoenixCycleRow> {
  const cycle = await getPhoenixCycle(userId, id);
  if (cycle.status !== 'SUITE_GREEN') throw AppError.badRequest('phoenix_not_green', `cannot open a PR until the suite is green (step ${cycle.status})`);
  if (!prNumber || typeof prNumber !== 'string') throw AppError.badRequest('invalid_pr_number', 'a PR number is required');
  await withTenant(userId, (q) => q.query('UPDATE phoenix_cycles SET pr_number = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, prNumber, 'PR_OPENED', userId]));
  await recordAudit({
    action: AuditAction.PHOENIX_RECOVERY_STEP,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'phoenix_cycles',
    resourceId: id,
    detail: { id, step: 'PR_OPENED', prNumber },
  });
  return getPhoenixCycle(userId, id);
}

export async function getPhoenixCycle(userId: string, id: string): Promise<PhoenixCycleRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM phoenix_cycles WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('phoenix_cycle_not_found', 'no phoenix cycle found for that id');
  return rowOf(row);
}

export async function listPhoenixCycles(userId: string, filter: { pipeline?: string } = {}): Promise<PhoenixCycleRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM phoenix_cycles WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.pipeline) rows = rows.filter((c) => c.pipeline === filter.pipeline);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function phoenixReport(userId: string): Promise<{ cycles: number; green: number; open_prs: number; reproduced: number }> {
  const rows = await listPhoenixCycles(userId);
  return {
    cycles: rows.length,
    reproduced: rows.filter((c) => c.status === 'REPRODUCED').length,
    green: rows.filter((c) => c.status === 'SUITE_GREEN').length,
    open_prs: rows.filter((c) => c.status === 'PR_OPENED').length,
  };
}