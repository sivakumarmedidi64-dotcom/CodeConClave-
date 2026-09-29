/**
 * CodeConClave — Superpowers: ECHO MEMORY (Master Feature #33, #55).
 *
 * Every human correction / override / review note becomes a labeled lesson
 * bound to a module scope. Future tasks in that scope retrieve matching
 * lessons before acting (Knowledge Diffusion). This is Memory Gravity given
 * teeth: the compounding advantage that cannot be cloned in a sprint.
 *
 * Lessons are stored in echo_lessons, keyed by owner + module_scope. Retrieval
 * is deterministic (exact-scope first, then GLOBAL) and returns the N most
 * recent matching lessons for prompt injection. `applied_count` tracks how
 * many times a lesson was actually used (measurable compounding).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const EchoSource = ['CORRECTION', 'OVERRIDE', 'REVIEW'] as const;
export type EchoSource = (typeof EchoSource)[number];

export interface EchoLessonInput {
  moduleScope?: string;
  label: string;
  lesson: string;
  source?: EchoSource;
  projectId?: string | null;
}

export interface EchoLessonRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  module_scope: string;
  label: string;
  lesson: string;
  source: EchoSource;
  applied_count: number;
  created_at: Date;
  updated_at: Date;
}

function rowOf(r: Record<string, unknown>): EchoLessonRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    module_scope: String(r.module_scope ?? 'GLOBAL'),
    label: String(r.label),
    lesson: String(r.lesson),
    source: (r.source as EchoSource) ?? 'CORRECTION',
    applied_count: Number(r.applied_count) || 0,
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

/** Normalize the reserved global scope (case-insensitive) to the canon value. */
function normalizeScope(scope: string): string {
  return /^global$/i.test(scope) ? 'GLOBAL' : scope;
}

export async function recordEchoLesson(userId: string, input: EchoLessonInput): Promise<EchoLessonRow> {
  const label = (input.label ?? '').trim();
  const lesson = (input.lesson ?? '').trim();
  if (!label) throw AppError.badRequest('label_required', 'A lesson label is required');
  if (!lesson) throw AppError.badRequest('lesson_required', 'A lesson is required');
  const scope = normalizeScope((input.moduleScope ?? '').trim()) || 'GLOBAL';
  const source: EchoSource = input.source && (EchoSource as readonly string[]).includes(input.source) ? input.source : 'CORRECTION';
  const id = newId(PREFIX.ECHO_LESSON);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO echo_lessons (id, owner_id, project_id, module_scope, label, lesson, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, userId, input.projectId ?? null, scope, label, lesson, source],
    ),
  );
  await recordAudit({
    action: AuditAction.ECHO_LESSON_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'echo_lessons',
    resourceId: id,
    detail: { moduleScope: scope, label: label.slice(0, 200), source },
  });
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM echo_lessons WHERE id = $1', [id])).rows,
  );
  return rowOf(rows[0]!);
}

export async function listEchoLessons(userId: string, opts: { moduleScope?: string; limit?: number } = {}): Promise<EchoLessonRow[]> {
  const limit = Math.min(opts.limit ?? 100, 200);
  if (opts.moduleScope) {
    const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>(
        'SELECT * FROM echo_lessons WHERE owner_id = $1 AND module_scope = $2 ORDER BY created_at DESC LIMIT $3',
        [userId, opts.moduleScope, limit],
      )).rows,
    );
    return rows.map(rowOf);
  }
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM echo_lessons WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    )).rows,
  );
  return rows.map(rowOf);
}

/** Prompt-safe retrieval: exact scope first, GLOBAL fallback, newest first,
 *  returns the raw lesson strings for injection. Audit records retrieval. */
export async function retrieveEchoLessons(userId: string, moduleScope?: string, limit = 6): Promise<string[]> {
  const scope = normalizeScope((moduleScope ?? '').trim()) || 'GLOBAL';
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      `SELECT * FROM echo_lessons
       WHERE owner_id = $1 AND (module_scope = $2 OR module_scope = 'GLOBAL')
       ORDER BY (CASE WHEN module_scope = $2 THEN 0 ELSE 1 END), created_at DESC
       LIMIT $3`,
      [userId, scope, limit],
    )).rows,
  );
  const lessons = rows.map(rowOf);
  await recordAudit({
    action: AuditAction.ECHO_LESSON_RETRIEVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'echo_lessons',
    resourceId: null,
    detail: { moduleScope: scope, count: lessons.length },
  });
  return lessons.map((l) => `[${l.source} @ ${l.module_scope}] ${l.label}: ${l.lesson}`);
}

/** Mark a lesson as actually used by a task (measurable compounding). */
export async function markEchoLessonApplied(userId: string, lessonId: string): Promise<EchoLessonRow> {
  const result = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>(
      `UPDATE echo_lessons SET applied_count = applied_count + 1, updated_at = now()
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [lessonId, userId],
    ).then((r) => r.rows[0] ?? null),
  );
  if (!result) throw AppError.notFound('Echo lesson');
  await recordAudit({
    action: AuditAction.ECHO_LESSON_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'echo_lessons',
    resourceId: lessonId,
  });
  return rowOf(result);
}