/**
 * CodeConClave — Superpowers: AMBIENT CODING (#153).
 *
 * No app, no chat box. Capability present everywhere: paste an error anywhere,
 * it answers; frown at a function, it explains.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface AmbientSessionRow {
  id: string;
  owner_id: string;
  trigger_text: string;
  context_path: string;
  response: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): AmbientSessionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  trigger_text: String(r.trigger_text),
  context_path: String(r.context_path ?? ''),
  response: String(r.response ?? ''),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createAmbientSession(userId: string, input: { trigger_text: string; context_path?: string }): Promise<AmbientSessionRow> {
  if (!input.trigger_text || typeof input.trigger_text !== 'string') throw AppError.badRequest('invalid_trigger_text', 'trigger text is required');
  const id = newId(PREFIX.AMBIENT_SESSION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO ambient_sessions (id, owner_id, trigger_text, context_path, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.trigger_text, input.context_path ?? '', 'PENDING'],
  ));
  return getAmbientSession(userId, id);
}

export async function answerAmbient(userId: string, id: string, input: { response: string }): Promise<AmbientSessionRow> {
  if (!input.response || typeof input.response !== 'string') throw AppError.badRequest('invalid_response', 'response is required');
  const session = await getAmbientSession(userId, id);
  if (session.status !== 'PENDING') throw AppError.badRequest('already_answered', 'this session has already been answered');
  await withTenant(userId, (q) => q.query(
    'UPDATE ambient_sessions SET response = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.response, 'ANSWERED', userId],
  ));
  await recordAudit({
    action: AuditAction.AMBIENT_ANSWER_GIVEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ambient_sessions',
    resourceId: id,
    detail: { trigger_text: session.trigger_text },
  });
  return getAmbientSession(userId, id);
}

export async function getAmbientSession(userId: string, id: string): Promise<AmbientSessionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM ambient_sessions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('ambient_session_not_found', 'no ambient session found for that id');
  return rowOf(row);
}

export async function listAmbientSessions(userId: string): Promise<AmbientSessionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM ambient_sessions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function ambientSessionReport(userId: string): Promise<{ sessions: number; pending: number; answered: number }> {
  const sessions = await listAmbientSessions(userId);
  return {
    sessions: sessions.length,
    pending: sessions.filter((s) => s.status === 'PENDING').length,
    answered: sessions.filter((s) => s.status === 'ANSWERED').length,
  };
}
