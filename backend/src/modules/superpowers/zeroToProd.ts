/**
 * CodeConClave — Superpowers: ZERO-TO-PROD MODE (Master Feature #80).
 *
 * Type one product idea → full run: requirements, schema, code, tests,
 * security scan, preview, deploy, monitoring. Each stage approvable.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ProdStage {
  name: string;
  status: string;
}

export interface ZeroToProdRow {
  id: string;
  owner_id: string;
  idea: string;
  stages: ProdStage[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ZeroToProdRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  idea: String(r.idea),
  stages: (r.stages ?? []) as ProdStage[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export const PROD_STAGES = ['requirements', 'schema', 'code', 'tests', 'security', 'preview', 'deploy', 'monitoring'];

export async function startProdRun(userId: string, input: { idea: string }): Promise<ZeroToProdRow> {
  if (!input.idea || typeof input.idea !== 'string') throw AppError.badRequest('invalid_idea', 'a product idea is required');
  const stages: ProdStage[] = PROD_STAGES.map((name, i) => ({ name, status: i === 0 ? 'READY' : 'PENDING' }));
  const id = newId(PREFIX.PROD_RUN);
  await withTenant(userId, (q) => q.query('INSERT INTO zero_to_prod (id, owner_id, idea, stages, status) VALUES ($1,$2,$3,$4,$5)', [
    id, userId, input.idea, stages, 'RUNNING',
  ]));
  await recordAudit({
    action: AuditAction.ZERO_TO_PROD_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'zero_to_prod',
    resourceId: id,
    detail: { idea: input.idea },
  });
  return getProdRun(userId, id);
}

export async function advanceProdStage(userId: string, id: string, input: { stage: string }): Promise<ZeroToProdRow> {
  const run = await getProdRun(userId, id);
  if (run.status !== 'RUNNING') throw AppError.badRequest('zero_to_prod_shipped', 'zero-to-prod already shipped — the pipeline is closed');
  const currentIdx = run.stages.findIndex((s) => s.status === 'READY');
  if (currentIdx < 0) throw AppError.badRequest('zero_to_prod_stalled', 'no stage is ready to approve');
  if (!input.stage || input.stage !== run.stages[currentIdx]!.name) {
    throw AppError.badRequest('stage_not_current', 'stages run in order — approve them one at a time');
  }
  const stages = run.stages.map((s) => ({ ...s }));
  stages[currentIdx]!.status = 'APPROVED';
  let status = run.status;
  if (currentIdx === stages.length - 1) {
    status = 'COMPLETE';
  } else {
    stages[currentIdx + 1]!.status = 'READY';
  }
  await withTenant(userId, (q) => q.query('UPDATE zero_to_prod SET stages = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, stages, status, userId]));
  await recordAudit({
    action: AuditAction.PROD_STAGE_APPROVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'zero_to_prod',
    resourceId: id,
    detail: { stage: run.stages[currentIdx]!.name },
  });
  if (status === 'COMPLETE') {
    await recordAudit({
      action: AuditAction.ZERO_TO_PROD_SHIPPED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'zero_to_prod',
      resourceId: id,
      detail: { idea: run.idea },
    });
  }
  return getProdRun(userId, id);
}

export async function getProdRun(userId: string, id: string): Promise<ZeroToProdRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM zero_to_prod WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('zero_to_prod_not_found', 'no zero-to-prod run found for that id');
  return rowOf(row);
}

export async function listProdRuns(userId: string): Promise<ZeroToProdRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM zero_to_prod WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function prodRunReport(userId: string): Promise<{ runs: number; shipped: number; stages_done: number }> {
  const runs = await listProdRuns(userId);
  return {
    runs: runs.length,
    shipped: runs.filter((r) => r.status === 'COMPLETE').length,
    stages_done: runs.reduce((s, r) => s + r.stages.filter((st) => st.status === 'APPROVED').length, 0),
  };
}