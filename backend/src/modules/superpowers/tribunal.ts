/**
 * CodeConClave — Superpowers: TRIBUNAL (Master Feature #18).
 *
 * High-stakes changes are routed to several models in parallel; every
 * candidate runs against the real test suite in a sandbox, and the judge —
 * test results, not vibes — picks the winner. Losing attempts are logged to
 * Memory Gravity as lessons, not discarded.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface TribunalCandidate {
  model: string;
  solution: string;
  passed: boolean;
  score: number;
}

export type TribunalStatus = 'DELIBERATING' | 'RESOLVED';

export interface TribunalHearingRow {
  id: string;
  owner_id: string;
  change: string;
  status: TribunalStatus;
  models: string[];
  candidates: TribunalCandidate[];
  verdict: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TribunalLessonRow {
  id: string;
  owner_id: string;
  change: string;
  losing_models: string[];
  lesson: string;
  created_at: Date;
}

const hearingRowOf = (r: Record<string, unknown>): TribunalHearingRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  change: String(r.change),
  status: r.status as TribunalStatus,
  models: (r.models ?? []) as string[],
  candidates: (r.candidates ?? []) as TribunalCandidate[],
  verdict: r.verdict === null || r.verdict === undefined ? null : String(r.verdict),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const lessonRowOf = (r: Record<string, unknown>): TribunalLessonRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  change: String(r.change),
  losing_models: (r.losing_models ?? []) as string[],
  lesson: String(r.lesson),
  created_at: new Date(r.created_at as string),
});

export async function conveneTribunal(
  userId: string,
  input: { change: string; models: string[]; candidates: TribunalCandidate[] },
): Promise<TribunalHearingRow> {
  if (!input.change || typeof input.change !== 'string') throw AppError.badRequest('invalid_change', 'a change description is required to convene a tribunal');
  if (!Array.isArray(input.models) || input.models.length < 2) throw AppError.badRequest('too_few_models', 'a tribunal needs at least 2 models');
  if (!Array.isArray(input.candidates) || input.candidates.length < 2) throw AppError.badRequest('too_few_candidates', 'each model must submit a candidate solution');

  for (const c of input.candidates) {
    if (!input.models.includes(c.model)) throw AppError.badRequest('unregistered_model', `${c.model} did not get a seat at this tribunal`);
    if (!c.solution || typeof c.solution !== 'string') throw AppError.badRequest('incomplete_candidate', `the candidate from ${c.model} is missing a solution`);
    if (typeof c.score !== 'number' || c.score < 0 || c.score > 100) throw AppError.badRequest('invalid_score', `candidate scores must be 0-100 (got ${c.score})`);
  }

  const passing = input.candidates.filter((c) => c.passed).sort((a, b) => b.score - a.score);
  const winner = passing[0] ?? null;
  const losers = winner ? input.candidates.filter((c) => c.model !== winner.model) : input.candidates;
  const verdict = winner ? `signed off by ${winner.model} (passed tests, score ${winner.score})` : 'no_candidate_passed';

  const id = newId(PREFIX.TRIBUNAL_HEARING);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO tribunal_hearings (id, owner_id, change, status, models, candidates, verdict) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, input.change, 'RESOLVED', input.models, input.candidates, verdict],
    ),
  );
  await recordAudit({
    action: AuditAction.TRIBUNAL_CONVENED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'tribunal_hearings',
    resourceId: id,
    detail: { change: input.change, models: input.models },
  });

  for (const loser of losers) {
    const lessonId = newId(PREFIX.TRIBUNAL_LESSON);
    const lesson = `the ${loser.model} candidate for "${input.change}" lost because ${loser.passed ? 'it scored lower on the test suite' : 'it did not pass the test suite'}`;
    await withTenant(userId, (q) =>
      q.query('INSERT INTO tribunal_lessons (id, owner_id, change, losing_models, lesson) VALUES ($1,$2,$3,$4,$5)', [
        lessonId,
        userId,
        input.change,
        [loser.model],
        lesson,
      ]),
    );
    await recordAudit({
      action: AuditAction.TRIBUNAL_LESSON_LOGGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'tribunal_lessons',
      resourceId: lessonId,
      detail: { change: input.change, losingModel: loser.model, lesson },
    });
  }

  await recordAudit({
    action: AuditAction.TRIBUNAL_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'tribunal_hearings',
    resourceId: id,
    detail: { change: input.change, verdict },
  });
  return getHearing(userId, id);
}

export async function getHearing(userId: string, id: string): Promise<TribunalHearingRow> {
  const row = await withTenant(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM tribunal_hearings WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('tribunal_hearing_not_found', 'no tribunal hearing found for that id');
  return hearingRowOf(row);
}

export async function listHearings(userId: string): Promise<TribunalHearingRow[]> {
  return (
    await withTenant(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM tribunal_hearings WHERE owner_id = $1', [userId])).rows,
    )
  ).map(hearingRowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function listLessons(userId: string): Promise<TribunalLessonRow[]> {
  return (
    await withTenant(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM tribunal_lessons WHERE owner_id = $1', [userId])).rows,
    )
  ).map(lessonRowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function tribunalReport(userId: string): Promise<{ hearings: number; resolved: number; lessons: number; winners: Record<string, number> }> {
  const hearings = await listHearings(userId);
  const lessons = await listLessons(userId);
  const winners: Record<string, number> = {};
  for (const h of hearings) {
    const w = h.verdict?.match(/^signed off by (\S+)/);
    if (w) winners[w[1]!] = (winners[w[1]!] ?? 0) + 1;
  }
  return {
    hearings: hearings.length,
    resolved: hearings.filter((h) => h.status === 'RESOLVED').length,
    lessons: lessons.length,
    winners,
  };
}