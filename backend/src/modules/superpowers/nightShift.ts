/**
 * CodeConClave — Superpowers: NIGHT SHIFT (Master Feature #7).
 *
 * Between 2am-6am coworkers work the entire backlog unsupervised: flaky tests
 * fixed, deps upgraded, dead code deleted, docs synced, perf hunts run. No
 * approval for low-risk tasks. Every morning a report: what changed, what
 * passed, what needs your eyes.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface NightShiftTask {
  name: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  ok: boolean;
  change: string;
}

export interface NightShiftRunRow {
  id: string;
  owner_id: string;
  window_start: string;
  window_end: string;
  tasks_completed: number;
  tasks_failed: number;
  changes_made: NightShiftTask[];
  report: string;
  status: 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): NightShiftRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  window_start: String(r.window_start),
  window_end: String(r.window_end),
  tasks_completed: Number(r.tasks_completed),
  tasks_failed: Number(r.tasks_failed),
  changes_made: (r.changes_made ?? []) as NightShiftTask[],
  report: String(r.report),
  status: r.status as NightShiftRunRow['status'],
  created_at: new Date(r.created_at as string),
});

/** Execute a low-risk task without asking: only LOW/ok tasks count as completed changes. */
export async function runNightShift(
  userId: string,
  input: { windowStart: string; windowEnd: string; tasks: NightShiftTask[] },
): Promise<NightShiftRunRow> {
  if (!input.windowStart || typeof input.windowStart !== 'string') throw AppError.badRequest('invalid_window_start', 'a night shift window start is required');
  if (!input.windowEnd || typeof input.windowEnd !== 'string') throw AppError.badRequest('invalid_window_end', 'a night shift window end is required');
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasks.length === 0) throw AppError.badRequest('empty_shift', 'no tasks in this shift');
  for (const t of tasks) {
    if (!t.name || typeof t.name !== 'string') throw AppError.badRequest('invalid_task_name', 'each shift task needs a name');
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(t.risk)) throw AppError.badRequest('invalid_risk', `task ${t.name} must declare LOW/MEDIUM/HIGH risk`);
  }
  const completed = tasks.filter((t) => t.ok && t.risk === 'LOW');
  const failed = tasks.filter((t) => !t.ok);
  const approved = tasks.filter((t) => t.ok && t.risk !== 'LOW');
  const id = newId(PREFIX.NIGHT_SHIFT_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO night_shift_runs (id, owner_id, window_start, window_end, tasks_completed, tasks_failed, changes_made, report, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.windowStart, input.windowEnd, completed.length, failed.length, completed, nightReport(input, completed, failed, approved), 'COMPLETED'],
  ));
  await recordAudit({
    action: AuditAction.NIGHT_SHIFT_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'night_shift_runs',
    resourceId: id,
    detail: { windowStart: input.windowStart, completed: completed.length, failed: failed.length },
  });
  return getNightShiftRun(userId, id);
}

function nightReport(
  input: { windowStart: string; windowEnd: string; tasks: NightShiftTask[] },
  completed: NightShiftTask[],
  failed: NightShiftTask[],
  approved: NightShiftTask[],
): string {
  return [
    `NIGHT SHIFT ${input.windowStart} — ${input.windowEnd}`,
    `Changed without approval: ${completed.length} task(s)`,
    ...completed.map((t) => `- [done] ${t.name}: ${t.change}`),
    `Needs your eyes: ${approved.length} task(s)`,
    ...approved.map((t) => `- [review] ${t.name}: ${t.change}`),
    `Failed: ${failed.length} task(s)`,
    ...failed.map((t) => `- [failed] ${t.name}`),
  ].join('\n');
}

export async function getNightShiftRun(userId: string, id: string): Promise<NightShiftRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM night_shift_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('night_shift_run_not_found', 'no night shift run found for that id');
  return rowOf(row);
}

export async function listNightShiftRuns(userId: string): Promise<NightShiftRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM night_shift_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function nightShiftReport(userId: string): Promise<{ shifts: number; completed: number; failed: number }> {
  const runs = await listNightShiftRuns(userId);
  return {
    shifts: runs.length,
    completed: runs.reduce((acc, r) => acc + r.tasks_completed, 0),
    failed: runs.reduce((acc, r) => acc + r.tasks_failed, 0),
  };
}