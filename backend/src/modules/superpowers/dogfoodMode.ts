/**
 * CodeConClave — Superpowers: DOGFOOD MODE (Feature #161).
 *
 * CodeConClave manages its own repository: agents file issues, fix CI,
 * write docs, release CodeConClave itself.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DogfoodTaskRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  category: string;
  assignee: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DogfoodTaskRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  title: String(r.title),
  description: String(r.description),
  category: String(r.category),
  assignee: r.assignee == null ? null : String(r.assignee),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function fileDogfoodTask(userId: string, input: { title: string; description: string; category: string; assignee?: string }): Promise<DogfoodTaskRow> {
  if (!input.title || typeof input.title !== 'string') throw AppError.badRequest('invalid_title', 'title is required');
  if (!input.description || typeof input.description !== 'string') throw AppError.badRequest('invalid_description', 'description is required');
  if (!input.category || typeof input.category !== 'string') throw AppError.badRequest('invalid_category', 'category is required');
  const id = newId(PREFIX.DOGFOOD_MODE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO dogfood_tasks (id, owner_id, title, description, category, assignee, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.title, input.description, input.category, input.assignee ?? null, 'FILED'],
  ));
  await recordAudit({
    action: AuditAction.DOGFOOD_TASK_FILED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dogfood_tasks',
    resourceId: id,
    detail: { title: input.title },
  });
  return getDogfoodTask(userId, id);
}

export async function getDogfoodTask(userId: string, id: string): Promise<DogfoodTaskRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM dogfood_tasks WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('dogfood_task_not_found', 'no dogfood task found for that id');
  return rowOf(row);
}

export async function listDogfoodTasks(userId: string): Promise<DogfoodTaskRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM dogfood_tasks WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function dogfoodModeReport(userId: string): Promise<{ tasks: number; filed: number; categories: number }> {
  const tasks = await listDogfoodTasks(userId);
  const cats = new Set(tasks.map((t) => t.category));
  return {
    tasks: tasks.length,
    filed: tasks.filter((t) => t.status === 'FILED').length,
    categories: cats.size,
  };
}
