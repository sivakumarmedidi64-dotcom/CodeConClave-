/**
 * CodeConClave — Superpowers: FOCUS FORGE (Master Feature #62).
 *
 * Detect deep-work sessions; automatically silence all non-P0 interruptions;
 * batch everything else into a digest delivered when you surface.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FocusSessionRow {
  id: string;
  owner_id: string;
  activity: string;
  intensity: number;
  held: number;
  breached: number;
  digest: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): FocusSessionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  activity: String(r.activity),
  intensity: Number(r.intensity),
  held: Number(r.held),
  breached: Number(r.breached),
  digest: (r.digest ?? []) as string[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** Sustained typing and long file edits are deep work. */
export async function forgeFocusSession(userId: string, input: { activity: string; intensity: number }): Promise<FocusSessionRow> {
  if (!input.activity || typeof input.activity !== 'string') throw AppError.badRequest('invalid_activity', 'what you are working on matters — a focus session needs an activity');
  if (typeof input.intensity !== 'number' || !Number.isInteger(input.intensity) || input.intensity < 1 || input.intensity > 10) {
    throw AppError.badRequest('invalid_intensity', 'sustained typing and long edits score between 1 and 10');
  }
  const id = newId(PREFIX.FOCUS_SESSION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO focus_sessions (id, owner_id, activity, intensity, held, breached, digest, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.activity, input.intensity, 0, 0, [], 'DETECTED'],
  ));
  await recordAudit({
    action: AuditAction.FOCUS_SESSION_OPENED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_sessions',
    resourceId: id,
    detail: { activity: input.activity, intensity: input.intensity },
  });
  return getFocusSession(userId, id);
}

/** Hold every non-urgent agent question; batch them into the digest. */
export async function silenceFocus(userId: string, id: string, input: { held: string[] }): Promise<FocusSessionRow> {
  const session = await getFocusSession(userId, id);
  if (session.status !== 'DETECTED') throw AppError.badRequest('focus_already_silenced', 'the focus session is already silent or over');
  const held = Array.isArray(input.held) ? input.held : [];
  await withTenant(userId, (q) => q.query('UPDATE focus_sessions SET held = $2, digest = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5', [
    id, held.length, held, 'SILENCED', userId,
  ]));
  await recordAudit({
    action: AuditAction.FOCUS_SESSION_SILENCED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_sessions',
    resourceId: id,
    detail: { held: held.length },
  });
  return getFocusSession(userId, id);
}

/** P0 stuff still breaks through. */
export async function breachFocus(userId: string, id: string, input: { p0: string }): Promise<FocusSessionRow> {
  const session = await getFocusSession(userId, id);
  if (session.status === 'DONE') throw AppError.badRequest('focus_over', 'the focus session is over — P0s now go to the inbox');
  if (!input.p0 || typeof input.p0 !== 'string') throw AppError.badRequest('invalid_p0', 'a P0 needs a message');
  await withTenant(userId, (q) => q.query('UPDATE focus_sessions SET breached = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, session.breached + 1, userId]));
  await recordAudit({
    action: AuditAction.FOCUS_SESSION_BREACHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_sessions',
    resourceId: id,
    detail: { p0: input.p0 },
  });
  return getFocusSession(userId, id);
}

/** Digest delivered when you surface. */
export async function digestFocus(userId: string, id: string): Promise<FocusSessionRow> {
  const session = await getFocusSession(userId, id);
  if (session.status === 'DONE') throw AppError.badRequest('focus_already_digested', 'the digest was already delivered');
  if (session.status !== 'SILENCED') throw AppError.badRequest('focus_not_silenced', 'silence the world first — the digest is only worth it mid-flow');
  await withTenant(userId, (q) => q.query('UPDATE focus_sessions SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'DONE', userId]));
  await recordAudit({
    action: AuditAction.FOCUS_SESSION_DIGESTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_sessions',
    resourceId: id,
    detail: { held: session.held, breached: session.breached },
  });
  return getFocusSession(userId, id);
}

export async function getFocusSession(userId: string, id: string): Promise<FocusSessionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM focus_sessions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('focus_session_not_found', 'no focus session found for that id');
  return rowOf(row);
}

export async function listFocusSessions(userId: string): Promise<FocusSessionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM focus_sessions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function focusReport(userId: string): Promise<{ sessions: number; active: number; silenced: number; done: number; avg_intensity: number }> {
  const sessions = await listFocusSessions(userId);
  return {
    sessions: sessions.length,
    active: sessions.filter((s) => s.status !== 'DONE').length,
    silenced: sessions.filter((s) => s.status === 'SILENCED').length,
    done: sessions.filter((s) => s.status === 'DONE').length,
    avg_intensity: sessions.length ? Math.round(sessions.reduce((s, x) => s + x.intensity, 0) / sessions.length) : 0,
  };
}