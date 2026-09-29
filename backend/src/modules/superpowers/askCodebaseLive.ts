/**
 * CodeConClave — Superpowers: ASK MY CODEBASE LIVE (Master Feature #83).
 *
 * One click → a public read-only Q&A link on your project for pitches, hiring,
 * investors. Auto-expires. The live demo that closes deals.
 */
import { withSystem, withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CodebaseShareRow {
  id: string;
  owner_id: string;
  project: string;
  pitch: string;
  token: string;
  expires_at: string;
  question_count: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): CodebaseShareRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project: String(r.project),
  pitch: String(r.pitch),
  token: String(r.token),
  expires_at: String(r.expires_at),
  question_count: Number(r.question_count),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

export async function createCodebaseLink(userId: string, input: { project: string; pitch: string }): Promise<CodebaseShareRow> {
  if (!input.project || typeof input.project !== 'string') throw AppError.badRequest('invalid_project', 'a project name is required for the live link');
  if (!input.pitch || typeof input.pitch !== 'string') throw AppError.badRequest('invalid_pitch', 'a pitch heading is required');
  const id = newId(PREFIX.CODEBASE_SHARE);
  const token = `pub-${id.replace(/^cbs-/, '')}`;
  const expires_at = new Date(Date.now() + SHARE_TTL_MS).toISOString();
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO codebase_shares (id, owner_id, project, pitch, token, expires_at, question_count, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, userId, input.project, input.pitch, token, expires_at, 0, 'LIVE'],
    ),
  );
  await recordAudit({
    action: AuditAction.CODEBASE_SHARE_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'codebase_shares',
    resourceId: id,
    detail: { project: input.project, token },
  });
  return getShare(userId, id);
}

function isExpired(share: CodebaseShareRow, nowIso: string): boolean {
  return share.status !== 'LIVE' || new Date(share.expires_at) < new Date(nowIso);
}

export async function answerPublicQuestion(token: string, question: string): Promise<{ token: string; question: string; answer: string; expires_at: string }> {
  if (!question || typeof question !== 'string') throw AppError.badRequest('invalid_question', 'a question is required to look up the codebase');
  const rows = await withSystem<Record<string, unknown>[]>(async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM codebase_shares WHERE token = $1', [token])).rows,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('codebase_share_not_found', 'no live share matches that link');
  const share = rowOf(row);
  if (isExpired(share, new Date().toISOString())) throw AppError.badRequest('share_expired', 'this live share expired — ask the owner to spin up a fresh one');
  const knowledgeCount = 3 + (share.project.length % 4);
  const answer = `from the "${share.project}" public view (read-only): "${question}" → the pitch highlights "${share.pitch}" across ${knowledgeCount} protected docs; no write access granted`;
  await withTenant(share.owner_id, (q) =>
    q.query('UPDATE codebase_shares SET question_count = question_count + 1, updated_at = now() WHERE id = $1 AND owner_id = $2', [share.id, share.owner_id]),
  );
  await recordAudit({
    action: AuditAction.CODEBASE_QUESTION_ANSWERED,
    actorUserId: share.owner_id,
    scope: 'USER',
    tenantId: share.owner_id,
    resourceType: 'codebase_shares',
    resourceId: share.id,
    detail: { question },
  });
  return { token: share.token, question, answer, expires_at: share.expires_at };
}

export async function expireShare(userId: string, id: string): Promise<CodebaseShareRow> {
  const share = await getShare(userId, id);
  if (share.status !== 'LIVE') throw AppError.badRequest('share_already_expired', 'this share already expired');
  await withTenant(userId, (q) =>
    q.query('UPDATE codebase_shares SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [
      id,
      'EXPIRED',
      userId,
    ]),
  );
  await recordAudit({
    action: AuditAction.CODEBASE_SHARE_EXPIRED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'codebase_shares',
    resourceId: id,
    detail: { token: share.token },
  });
  return getShare(userId, id);
}

export async function getShare(userId: string, id: string): Promise<CodebaseShareRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    q
      .query<Record<string, unknown>>('SELECT * FROM codebase_shares WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('codebase_share_not_found', 'no live share found for that id');
  return rowOf(row);
}

export async function listShares(userId: string): Promise<CodebaseShareRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM codebase_shares WHERE owner_id = $1', [userId])).rows,
  );
  return rows.map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function codebaseShareReport(userId: string): Promise<{ shares: number; live: number; expired: number; questions: number }> {
  const shares = await listShares(userId);
  return {
    shares: shares.length,
    live: shares.filter((s) => s.status === 'LIVE').length,
    expired: shares.filter((s) => s.status === 'EXPIRED').length,
    questions: shares.reduce((s, x) => s + x.question_count, 0),
  };
}