/**
 * CodeConClave — Superpowers: AUTONOMOUS REFACTOR MARKET (Feature #160).
 *
 * Safe refactors proposed, benchmarked, queued continuously; approve
 * weekly batch in one click.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RefactorProposalRow {
  id: string;
  owner_id: string;
  description: string;
  file_path: string;
  benchmark_before: number;
  benchmark_after: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): RefactorProposalRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  description: String(r.description),
  file_path: String(r.file_path),
  benchmark_before: Number(r.benchmark_before),
  benchmark_after: Number(r.benchmark_after),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function proposeRefactor(userId: string, input: { description: string; file_path: string; benchmark_before: number; benchmark_after: number }): Promise<RefactorProposalRow> {
  if (!input.description || typeof input.description !== 'string') throw AppError.badRequest('invalid_description', 'description is required');
  if (!input.file_path || typeof input.file_path !== 'string') throw AppError.badRequest('invalid_file_path', 'file path is required');
  const id = newId(PREFIX.REFACTOR_MARKET);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO refactor_proposals (id, owner_id, description, file_path, benchmark_before, benchmark_after, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.description, input.file_path, input.benchmark_before, input.benchmark_after, 'PROPOSED'],
  ));
  await recordAudit({
    action: AuditAction.REFACTOR_PROPOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'refactor_proposals',
    resourceId: id,
    detail: { description: input.description },
  });
  return getRefactorProposal(userId, id);
}

export async function queueRefactor(userId: string, id: string): Promise<RefactorProposalRow> {
  const proposal = await getRefactorProposal(userId, id);
  if (proposal.status === 'QUEUED') throw AppError.badRequest('already_queued', 'proposal is already queued');
  await withTenant(userId, (q) => q.query(
    'UPDATE refactor_proposals SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'QUEUED', userId],
  ));
  await recordAudit({
    action: AuditAction.REFACTOR_QUEUED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'refactor_proposals',
    resourceId: id,
    detail: { description: proposal.description },
  });
  return getRefactorProposal(userId, id);
}

export async function getRefactorProposal(userId: string, id: string): Promise<RefactorProposalRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM refactor_proposals WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('refactor_proposal_not_found', 'no refactor proposal found for that id');
  return rowOf(row);
}

export async function listRefactorProposals(userId: string): Promise<RefactorProposalRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM refactor_proposals WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function refactorMarketReport(userId: string): Promise<{ proposals: number; proposed: number; queued: number }> {
  const proposals = await listRefactorProposals(userId);
  return {
    proposals: proposals.length,
    proposed: proposals.filter((p) => p.status === 'PROPOSED').length,
    queued: proposals.filter((p) => p.status === 'QUEUED').length,
  };
}
