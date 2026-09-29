/**
 * CodeConClave — Superpowers: FOCUS GUARD (Master Feature #72).
 *
 * Detect deep-work sessions; hold every non-urgent agent question until you
 * surface; urgent stuff still breaks through. Flow state, protected.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FocusGuardRow {
  id: string;
  owner_id: string;
  activity: string;
  intensity: number;
  held: number;
  urgent_out: number;
  digest: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): FocusGuardRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  activity: String(r.activity),
  intensity: Number(r.intensity),
  held: Number(r.held),
  urgent_out: Number(r.urgent_out),
  digest: (r.digest ?? []) as string[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function guardDeepWork(userId: string, input: { activity: string; intensity: number }): Promise<FocusGuardRow> {
  if (!input.activity || typeof input.activity !== 'string') throw AppError.badRequest('invalid_activity', 'what you are working on matters — a guarded session needs an activity');
  if (typeof input.intensity !== 'number' || !Number.isInteger(input.intensity) || input.intensity < 1 || input.intensity > 10) {
    throw AppError.badRequest('invalid_intensity', 'sustained typing and long edits score between 1 and 10');
  }
  const id = newId(PREFIX.FOCUS_GUARD);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO focus_guards (id, owner_id, activity, intensity, held, urgent_out, digest, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.activity, input.intensity, 0, 0, [], 'GUARDED'],
  ));
  await recordAudit({
    action: AuditAction.FOCUS_GUARD_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_guards',
    resourceId: id,
    detail: { activity: input.activity, intensity: input.intensity },
  });
  return getFocusGuard(userId, id);
}

export interface QuestionOutcome {
  question: string;
  broke_through: boolean;
  held: number;
  urgent_out: number;
  note: string;
}

export async function holdQuestion(userId: string, id: string, input: { question: string; urgent?: boolean }): Promise<QuestionOutcome> {
  const session = await getFocusGuard(userId, id);
  if (session.status !== 'GUARDED') throw AppError.badRequest('focus_guard_over', 'this focus session was already surfaced');
  if (!input.question || typeof input.question !== 'string') throw AppError.badRequest('invalid_question', 'a question is required');
  const urgent = input.urgent === true;
  if (urgent) {
    await withTenant(userId, (q) => q.query('UPDATE focus_guards SET urgent_out = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, session.urgent_out + 1, userId]));
    await recordAudit({
      action: AuditAction.FOCUS_QUESTION_BROKE_THROUGH,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'focus_guards',
      resourceId: id,
      detail: { question: input.question },
    });
    return { question: input.question, broke_through: true, held: session.held, urgent_out: session.urgent_out + 1, note: 'urgent question broke through immediately' };
  }
  const digest = [...session.digest, input.question];
  await withTenant(userId, (q) => q.query('UPDATE focus_guards SET held = $2, digest = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, session.held + 1, digest, userId]));
  await recordAudit({
    action: AuditAction.FOCUS_QUESTION_HELD,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_guards',
    resourceId: id,
    detail: { question: input.question },
  });
  return { question: input.question, broke_through: false, held: session.held + 1, urgent_out: session.urgent_out, note: 'held — delivered in the digest when you surface' };
}

/** The digest lands when you surface. */
export async function surfaceGuard(userId: string, id: string): Promise<FocusGuardRow> {
  const session = await getFocusGuard(userId, id);
  if (session.status !== 'GUARDED') throw AppError.badRequest('focus_guard_over', 'this focus session was already surfaced');
  await withTenant(userId, (q) => q.query('UPDATE focus_guards SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'RELEASED', userId]));
  await recordAudit({
    action: AuditAction.FOCUS_GUARD_SURFACED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'focus_guards',
    resourceId: id,
    detail: { held: session.held, urgent_out: session.urgent_out },
  });
  return getFocusGuard(userId, id);
}

export async function getFocusGuard(userId: string, id: string): Promise<FocusGuardRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM focus_guards WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('focus_guard_not_found', 'no focus guard found for that id');
  return rowOf(row);
}

export async function listFocusGuards(userId: string): Promise<FocusGuardRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM focus_guards WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function focusGuardReport(userId: string): Promise<{ sessions: number; held: number; urgent_out: number; released: number }> {
  const sessions = await listFocusGuards(userId);
  return {
    sessions: sessions.length,
    held: sessions.reduce((s, x) => s + x.held, 0),
    urgent_out: sessions.reduce((s, x) => s + x.urgent_out, 0),
    released: sessions.filter((s) => s.status === 'RELEASED').length,
  };
}