/**
 * CodeConClave — Superpowers: SELF-EVOLVING TOOLCHAIN (#149).
 *
 * Analyzes every failure or correction, updates agent prompts, tools, and policies.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface SelfEvolvingLessonRow {
  id: string;
  owner_id: string;
  failure_description: string;
  lesson: string;
  source: string;
  adopted: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SelfEvolvingLessonRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  failure_description: String(r.failure_description),
  lesson: String(r.lesson),
  source: String(r.source),
  adopted: Boolean(r.adopted),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function recordLesson(userId: string, input: { failure_description: string; lesson: string; source: string }): Promise<SelfEvolvingLessonRow> {
  if (!input.failure_description || typeof input.failure_description !== 'string') throw AppError.badRequest('invalid_failure_description', 'a failure description is required');
  if (!input.lesson || typeof input.lesson !== 'string') throw AppError.badRequest('invalid_lesson', 'a lesson is required');
  if (!input.source || typeof input.source !== 'string') throw AppError.badRequest('invalid_source', 'a source is required');
  const id = newId(PREFIX.SELF_EVOLVING);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO self_evolving_lessons (id, owner_id, failure_description, lesson, source, adopted, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.failure_description, input.lesson, input.source, false, 'PENDING'],
  ));
  await recordAudit({
    action: AuditAction.TOOLCHAIN_LESSON_ADOPTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'self_evolving_lessons',
    resourceId: id,
    detail: { lesson: input.lesson },
  });
  return getLesson(userId, id);
}

export async function adoptLesson(userId: string, id: string): Promise<SelfEvolvingLessonRow> {
  const lesson = await getLesson(userId, id);
  if (lesson.status === 'ADOPTED') throw AppError.badRequest('lesson_already_adopted', 'this lesson has already been adopted');
  await withTenant(userId, (q) => q.query(
    'UPDATE self_evolving_lessons SET adopted = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, true, 'ADOPTED', userId],
  ));
  await recordAudit({
    action: AuditAction.TOOLCHAIN_LESSON_ADOPTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'self_evolving_lessons',
    resourceId: id,
    detail: { lesson_id: id },
  });
  return getLesson(userId, id);
}

export async function getLesson(userId: string, id: string): Promise<SelfEvolvingLessonRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM self_evolving_lessons WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('self_evolving_lesson_not_found', 'no self-evolving lesson found for that id');
  return rowOf(row);
}

export async function listLessons(userId: string): Promise<SelfEvolvingLessonRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM self_evolving_lessons WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function selfEvolvingReport(userId: string): Promise<{ lessons: number; pending: number; adopted: number; discarded: number }> {
  const lessons = await listLessons(userId);
  return {
    lessons: lessons.length,
    pending: lessons.filter((l) => l.status === 'PENDING').length,
    adopted: lessons.filter((l) => l.status === 'ADOPTED').length,
    discarded: lessons.filter((l) => l.status === 'DISCARDED').length,
  };
}
