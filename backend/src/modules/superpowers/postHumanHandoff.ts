/**
 * CodeConClave — Superpowers: POST-HUMAN HANDOFF (#156).
 *
 * When a human's context is exhausted at 2am, an agent continues the exact
 * thread — same branch, same thought process, logged for morning review.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PostHumanHandoffRow {
  id: string;
  owner_id: string;
  branch_name: string;
  last_thought: string;
  agent_continuation: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PostHumanHandoffRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  branch_name: String(r.branch_name),
  last_thought: String(r.last_thought),
  agent_continuation: String(r.agent_continuation ?? ''),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createPostHumanHandoff(userId: string, input: { branch_name: string; last_thought: string }): Promise<PostHumanHandoffRow> {
  if (!input.branch_name || typeof input.branch_name !== 'string') throw AppError.badRequest('invalid_branch_name', 'branch name is required');
  if (!input.last_thought || typeof input.last_thought !== 'string') throw AppError.badRequest('invalid_last_thought', 'last thought is required');
  const id = newId(PREFIX.POST_HUMAN_HANDOFF);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO post_human_handoffs (id, owner_id, branch_name, last_thought, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.branch_name, input.last_thought, 'PENDING'],
  ));
  return getPostHumanHandoff(userId, id);
}

export async function continueHandoff(userId: string, id: string, input: { agent_continuation: string }): Promise<PostHumanHandoffRow> {
  if (!input.agent_continuation || typeof input.agent_continuation !== 'string') throw AppError.badRequest('invalid_agent_continuation', 'agent continuation is required');
  const handoff = await getPostHumanHandoff(userId, id);
  if (handoff.status !== 'PENDING') throw AppError.badRequest('already_continued', 'this handoff has already been continued');
  await withTenant(userId, (q) => q.query(
    'UPDATE post_human_handoffs SET agent_continuation = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.agent_continuation, 'CONTINUED', userId],
  ));
  await recordAudit({
    action: AuditAction.HANDOFF_CONTINUED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'post_human_handoffs',
    resourceId: id,
    detail: { branch_name: handoff.branch_name },
  });
  return getPostHumanHandoff(userId, id);
}

export async function getPostHumanHandoff(userId: string, id: string): Promise<PostHumanHandoffRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM post_human_handoffs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('post_human_handoff_not_found', 'no post human handoff found for that id');
  return rowOf(row);
}

export async function listPostHumanHandoffs(userId: string): Promise<PostHumanHandoffRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM post_human_handoffs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function postHumanHandoffReport(userId: string): Promise<{ handoffs: number; pending: number; continued: number; reviewed: number }> {
  const handoffs = await listPostHumanHandoffs(userId);
  return {
    handoffs: handoffs.length,
    pending: handoffs.filter((h) => h.status === 'PENDING').length,
    continued: handoffs.filter((h) => h.status === 'CONTINUED').length,
    reviewed: handoffs.filter((h) => h.status === 'REVIEWED').length,
  };
}
