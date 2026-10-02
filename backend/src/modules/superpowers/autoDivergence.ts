/**
 * CodeConClave — Superpowers: AUTO-DIVERGENCE (Master Feature #12).
 *
 * Spots when you're hand-fixing something the coworker already knows how to
 * fix — repeated manual actions become concrete suggestions ("you renamed 12
 * imports manually; I see 40 more to go") and every yes/no answer tunes a
 * verb-level affinity so future suggestions follow your taste.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type DivergenceStatus = 'OPEN' | 'APPLIED' | 'DISMISSED';

export interface DivergenceSessionRow {
  id: string;
  owner_id: string;
  verb: string;
  target: string;
  observed_count: number;
  remaining_count: number;
  status: DivergenceStatus;
  accepted: boolean | null;
  created_at: Date;
  updated_at: Date;
}

export interface DivergencePreferenceRow {
  id: string;
  owner_id: string;
  verb: string;
  affinity: number;
  record_count: number;
  created_at: Date;
  updated_at: Date;
}

const SUGGEST_THRESHOLD = 2;
const REMAINING_MULTIPLIER = 3;
const AFFINITY_STEP = 0.1;

const rowOf = (r: Record<string, unknown>): DivergenceSessionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  verb: String(r.verb),
  target: String(r.target),
  observed_count: Number(r.observed_count),
  remaining_count: Number(r.remaining_count),
  status: r.status as DivergenceStatus,
  accepted: r.accepted === null || r.accepted === undefined ? null : Boolean(r.accepted),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const preferenceRowOf = (r: Record<string, unknown>): DivergencePreferenceRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  verb: String(r.verb),
  affinity: Number(r.affinity),
  record_count: Number(r.record_count),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Repeated manual actions of the same kind on the same target build a suggestion. */
export async function recordManualAction(userId: string, input: { verb: string; target: string }): Promise<DivergenceSessionRow> {
  if (!input.verb || typeof input.verb !== 'string') throw AppError.badRequest('invalid_verb', 'a manual action verb is required');
  if (!input.target || typeof input.target !== 'string') throw AppError.badRequest('invalid_target', 'the manual action needs a target');
  const open = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q
      .query<Record<string, unknown>>(
        'SELECT * FROM divergence_sessions WHERE owner_id = $1 AND verb = $2 AND target = $3 AND status = $4',
        [userId, input.verb, input.target, 'OPEN'],
      )
      .then((r) => r.rows[0] ?? null),
  );

  if (open) {
    const observed = Number(open.observed_count) + 1;
    const raise = observed >= SUGGEST_THRESHOLD && Number(open.remaining_count) === 0;
    const remaining = raise ? observed * REMAINING_MULTIPLIER : Number(open.remaining_count);
    await withTenant(userId, (q) =>
      q.query('UPDATE divergence_sessions SET observed_count = $2, remaining_count = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [
        open.id,
        observed,
        remaining,
        userId,
      ]),
    );
    const row = await getDivergenceSession(userId, String(open.id));
    if (raise) {
      await recordAudit({
        action: AuditAction.DIVERGENCE_HINT_RAISED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'divergence_sessions',
        resourceId: row.id,
        detail: { verb: input.verb, target: input.target, observed, remaining },
      });
    }
    return row;
  }

  const id = newId(PREFIX.DIVERGENCE_SESSION);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO divergence_sessions (id, owner_id, verb, target, observed_count, remaining_count, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, input.verb, input.target, 1, 0, 'OPEN'],
    ),
  );
  return getDivergenceSession(userId, id);
}

async function adjustPreference(userId: string, verb: string, delta: number): Promise<void> {
  const existing = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM divergence_preferences WHERE owner_id = $1 AND verb = $2', [userId, verb]).then((r) => r.rows[0] ?? null),
  );
  if (existing) {
    const affinity = clamp(Number(existing.affinity) + delta, 0, 1);
    await withTenant(userId, (q) =>
      q.query('UPDATE divergence_preferences SET affinity = $2, record_count = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [
        existing.id,
        affinity,
        Number(existing.record_count) + 1,
        userId,
      ]),
    );
  } else {
    const id = newId(PREFIX.DIVERGENCE_PREFERENCE);
    await withTenant(userId, (q) =>
      q.query('INSERT INTO divergence_preferences (id, owner_id, verb, affinity, record_count) VALUES ($1,$2,$3,$4,$5)', [
        id,
        userId,
        verb,
        clamp(0.5 + delta, 0, 1),
        1,
      ]),
    );
  }
}

export async function acceptSuggestion(userId: string, id: string): Promise<DivergenceSessionRow> {
  const session = await getDivergenceSession(userId, id);
  if (session.status !== 'OPEN' || session.remaining_count === 0) throw AppError.badRequest('suggestion_not_open', `the suggestion for ${session.verb} is not open`);
  await withTenant(userId, (q) => q.query('UPDATE divergence_sessions SET status = $2, accepted = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, 'APPLIED', true, userId]));
  await adjustPreference(userId, session.verb, AFFINITY_STEP);
  await recordAudit({
    action: AuditAction.DIVERGENCE_HINT_ACCEPTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'divergence_sessions',
    resourceId: id,
    detail: { verb: session.verb, target: session.target, remaining: session.remaining_count },
  });
  return getDivergenceSession(userId, id);
}

export async function dismissSuggestion(userId: string, id: string): Promise<DivergenceSessionRow> {
  const session = await getDivergenceSession(userId, id);
  if (session.status !== 'OPEN' || session.remaining_count === 0) throw AppError.badRequest('suggestion_not_open', `the suggestion for ${session.verb} is not open`);
  await withTenant(userId, (q) => q.query('UPDATE divergence_sessions SET status = $2, accepted = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, 'DISMISSED', false, userId]));
  await adjustPreference(userId, session.verb, -AFFINITY_STEP);
  await recordAudit({
    action: AuditAction.DIVERGENCE_HINT_DISMISSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'divergence_sessions',
    resourceId: id,
    detail: { verb: session.verb, target: session.target, remaining: session.remaining_count },
  });
  return getDivergenceSession(userId, id);
}

export async function listSuggestions(userId: string): Promise<DivergenceSessionRow[]> {
  return (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>(
      'SELECT * FROM divergence_sessions WHERE owner_id = $1 AND status = $2 AND remaining_count > 0',
      [userId, 'OPEN'],
    ).then((r) => r.rows),
  )).map(rowOf).sort((a, b) => b.observed_count - a.observed_count);
}

export async function listManualActions(userId: string): Promise<DivergenceSessionRow[]> {
  return (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM divergence_sessions WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function getDivergenceSession(userId: string, id: string): Promise<DivergenceSessionRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM divergence_sessions WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('divergence_session_not_found', 'no divergence session found for that id');
  return rowOf(row);
}

export async function learnedPatterns(userId: string): Promise<DivergencePreferenceRow[]> {
  return (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM divergence_preferences WHERE owner_id = $1 ORDER BY affinity DESC', [userId]).then((r) => r.rows),
  )).map(preferenceRowOf);
}

export async function divergenceReport(userId: string): Promise<{
  open_suggestions: number;
  applied: number;
  dismissed: number;
  favorite_verb: string | null;
}> {
  const sessions = await listManualActions(userId);
  const prefs = await learnedPatterns(userId);
  return {
    open_suggestions: sessions.filter((s) => s.status === 'OPEN' && s.remaining_count > 0).length,
    applied: sessions.filter((s) => s.status === 'APPLIED').length,
    dismissed: sessions.filter((s) => s.status === 'DISMISSED').length,
    favorite_verb: prefs[0]?.verb ?? null,
  };
}