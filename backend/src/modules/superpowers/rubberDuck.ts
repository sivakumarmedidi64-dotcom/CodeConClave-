/**
 * CodeConClave — Superpowers: RUBBER DUCK MODE (Master Feature #60).
 *
 * Explain your problem out loud; the system asks Socratic questions until YOU
 * find the answer. Sometimes you don't want the answer — you want the question
 * that unlocks it.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type DuckSessionStatus = 'SEARCHING' | 'FOUND';

export interface DuckSessionRow {
  id: string;
  owner_id: string;
  problem: string;
  turns: string[];
  status: DuckSessionStatus;
  resolution: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DuckSessionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  problem: String(r.problem),
  turns: (r.turns ?? []) as string[],
  status: r.status as DuckSessionStatus,
  resolution: r.resolution === null || r.resolution === undefined ? null : String(r.resolution),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** Socratic scaffolding — deterministic questions that make you think. */
export function socraticTurns(problem: string): string[] {
  const subjectMatch = / in ([a-z0-9 _-]+)/i.exec(problem);
  const subject = subjectMatch ? subjectMatch[1]!.trim() : 'the code';
  const termMatch = /(?:getting|seeing|hitting) ([a-z0-9]+)/i.exec(problem);
  const term = termMatch ? termMatch[1]! : 'the issue';
  return [
    `Walk me through the request flow: where does ${subject} first see ${term}?`,
    `What's the first place ${subject} can produce ${term}?`,
    `What changed around ${subject} right before this started?`,
    `Explain how you'd fix it to a new hire — say it out loud.`,
  ];
}

export async function startDuckSession(userId: string, input: { problem: string }): Promise<DuckSessionRow> {
  if (!input.problem || typeof input.problem !== 'string') throw AppError.badRequest('empty_problem', 'tell me the problem you are trying to debug');
  const turns = socraticTurns(input.problem);
  const id = newId(PREFIX.DUCK_SESSION);
  await withTenant(userId, (q) => q.query('INSERT INTO duck_sessions (id, owner_id, problem, turns, status) VALUES ($1,$2,$3,$4,$5)', [id, userId, input.problem, turns, 'SEARCHING']));
  await recordAudit({
    action: AuditAction.DUCK_SESSION_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'duck_sessions',
    resourceId: id,
    detail: { problem: input.problem, turns: turns.length },
  });
  return getDuckSession(userId, id);
}

export async function foundIt(userId: string, id: string, resolution: string): Promise<DuckSessionRow> {
  const session = await getDuckSession(userId, id);
  if (session.status !== 'SEARCHING') throw AppError.badRequest('session_already_found', 'this duck session already found its answer');
  if (!resolution || typeof resolution !== 'string') throw AppError.badRequest('empty_resolution', 'tell me what you figured out');
  await withTenant(userId, (q) => q.query('UPDATE duck_sessions SET status = $2, resolution = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, 'FOUND', resolution, userId]));
  await recordAudit({
    action: AuditAction.DUCK_SESSION_FOUND,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'duck_sessions',
    resourceId: id,
    detail: { problem: session.problem },
  });
  return getDuckSession(userId, id);
}

export async function getDuckSession(userId: string, id: string): Promise<DuckSessionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM duck_sessions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('duck_session_not_found', 'no duck session found for that id');
  return rowOf(row);
}

export async function listDuckSessions(userId: string): Promise<DuckSessionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM duck_sessions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function duckReport(userId: string): Promise<{ sessions: number; searching: number; found: number }> {
  const sessions = await listDuckSessions(userId);
  return {
    sessions: sessions.length,
    searching: sessions.filter((s) => s.status === 'SEARCHING').length,
    found: sessions.filter((s) => s.status === 'FOUND').length,
  };
}