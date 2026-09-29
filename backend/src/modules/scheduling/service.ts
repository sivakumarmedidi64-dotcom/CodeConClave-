/**
 * CodeConClave — scheduled autonomous tasks (Stage 26C).
 * CRUD + server-authoritative next-run preview + run-now + history. The actual
 * due processing lives in executor.ts and runs inside the existing watchdog
 * sweep (no separate scheduler process). Every mutation is audited and
 * tenant-scoped by explicit owner_id filters (RLS also applies).
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { getAgent } from '../agents/service.js';
import { nextRunAt, describeAnchor, parseCron, type ScheduleAnchor, type ScheduleRecurrence } from './recurrence.js';

export interface ScheduledTaskRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  agent_id: string;
  title: string;
  description: string | null;
  recurrence: ScheduleRecurrence;
  cron_expression: string | null;
  timezone: string;
  run_at: string;
  run_on_days: string[];
  enabled: boolean;
  execution_mode: 'CLOUD' | 'LOCAL_ONLY' | 'HYBRID';
  missed_run_policy: 'RUN_ON_RECOVERY' | 'SKIP_STALE' | 'RUN_ONCE';
  next_run_at: Date;
  last_run_at: Date | null;
  last_run_status: string | null;
  run_count: number;
  require_approval: boolean;
  timeout_ms: number;
  max_attempts: number;
  notify_on_completion: boolean;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleInput {
  projectId?: string | null;
  agentId: string;
  title: string;
  description?: string | null;
  recurrence: ScheduleRecurrence;
  cronExpression?: string | null;
  timezone?: string;
  runAt?: string;
  runOnDays?: string[];
  executionMode?: 'CLOUD' | 'LOCAL_ONLY' | 'HYBRID';
  missedRunPolicy?: 'RUN_ON_RECOVERY' | 'SKIP_STALE' | 'RUN_ONCE';
  requireApproval?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  notifyOnCompletion?: boolean;
  firstRunAt?: string;
}

export const MISSED_RUN_POLICIES = ['RUN_ON_RECOVERY', 'SKIP_STALE', 'RUN_ONCE'] as const;
export const EXECUTION_MODES = ['CLOUD', 'LOCAL_ONLY', 'HYBRID'] as const;

export function rowToSchedule(row: Record<string, unknown>): ScheduledTaskRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    project_id: row.project_id ? String(row.project_id) : null,
    agent_id: String(row.agent_id),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    recurrence: row.recurrence as ScheduleRecurrence,
    cron_expression: row.cron_expression ? String(row.cron_expression) : null,
    timezone: String(row.timezone),
    run_at: String(row.run_at),
    run_on_days: Array.isArray(row.run_on_days) ? row.run_on_days.map(String) : [],
    enabled: Boolean(row.enabled),
    execution_mode: row.execution_mode as ScheduledTaskRow['execution_mode'],
    missed_run_policy: row.missed_run_policy as ScheduledTaskRow['missed_run_policy'],
    next_run_at: new Date(row.next_run_at as string),
    last_run_at: row.last_run_at ? new Date(row.last_run_at as string) : null,
    last_run_status: row.last_run_status ? String(row.last_run_status) : null,
    run_count: Number(row.run_count ?? 0),
    require_approval: Boolean(row.require_approval),
    timeout_ms: Number(row.timeout_ms ?? 900000),
    max_attempts: Number(row.max_attempts ?? 3),
    notify_on_completion: Boolean(row.notify_on_completion),
    error: row.error ? String(row.error) : null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function validateTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw AppError.badRequest('invalid_timezone', `Unknown IANA timezone: ${tz}`);
  }
}

function validateAnchor(input: ScheduleInput, now: Date): ScheduleAnchor {
  const recurrence = input.recurrence ?? 'DAILY';
  const timezone = validateTimezone(input.timezone ?? 'UTC');
  const runAt = input.runAt ?? (recurrence === 'ONCE' ? '2099-12-31T09:00' : '09:00');
  const runOnDays = Array.isArray(input.runOnDays) ? input.runOnDays : [];

  if (recurrence === 'CRON') {
    if (!input.cronExpression || !parseCron(input.cronExpression)) {
      throw AppError.badRequest('invalid_cron', 'cronExpression must be 5 fields (minute hour dom month dow) with numbers, ranges or lists');
    }
  }
  if (recurrence === 'WEEKLY' && runOnDays.length === 0) {
    throw AppError.badRequest('weekly_days_required', 'runOnDays must list at least one weekday for WEEKLY schedules');
  }
  if (recurrence === 'MONTHLY' && runOnDays.length === 0) {
    throw AppError.badRequest('monthly_days_required', 'runOnDays must list at least one day-of-month for MONTHLY schedules');
  }
  if (recurrence === 'HOURLY') {
    const n = Number(runAt);
    if (!Number.isFinite(n) || n < 0 || n > 59) throw AppError.badRequest('invalid_hourly_minutes', 'runAt must be minutes past the hour (00-59) for HOURLY schedules');
  }
  if (recurrence === 'ONCE' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(runAt)) {
    throw AppError.badRequest('invalid_once_at', 'runAt must be YYYY-MM-DDTHH:MM for ONCE schedules');
  }

  const anchor: ScheduleAnchor = { recurrence, runAt, runOnDays, timezone, cronExpression: input.cronExpression ?? null };
  const first = nextRunAt(anchor, now);
  if (input.recurrence === 'ONCE' && input.firstRunAt && input.firstRunAt !== runAt) {
    // caller-supplied firstRunAt is authoritative for ONCE (it IS runAt).
  }
  if (recurrence === 'ONCE' && !first) {
    throw AppError.badRequest('once_run_in_past', 'ONCE schedule runAt must be in the future');
  }
  return anchor;
}

async function getOwnedSchedule(userId: string, scheduleId: string): Promise<ScheduledTaskRow> {
  const rows = await withTenant<ScheduledTaskRow[]>(userId, (q) =>
    q.query<ScheduledTaskRow>('SELECT * FROM scheduled_tasks WHERE id = $1 AND owner_id = $2', [scheduleId, userId]).then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Schedule');
  return rowToSchedule(rows[0] as unknown as Record<string, unknown>);
}

export async function listSchedules(userId: string, includeDisabled = false): Promise<ScheduledTaskRow[]> {
  const rows = await withTenant<ScheduledTaskRow[]>(userId, (q) =>
    q
      .query<ScheduledTaskRow>(
        `SELECT * FROM scheduled_tasks WHERE owner_id = $1 ${includeDisabled ? '' : 'AND enabled = true'} ORDER BY next_run_at, created_at`,
        [userId],
      )
      .then((r) => r.rows),
  );
  return rows.map((r) => rowToSchedule(r as unknown as Record<string, unknown>));
}

export async function getSchedule(userId: string, scheduleId: string): Promise<ScheduledTaskRow> {
  return getOwnedSchedule(userId, scheduleId);
}

export async function createSchedule(userId: string, input: ScheduleInput): Promise<ScheduledTaskRow> {
  const { assertAutonomyEnabled } = await import('../control/killSwitch.js');
  await assertAutonomyEnabled(userId, 'SCHEDULES');
  const title = (input.title ?? '').trim();
  if (!title) throw AppError.badRequest('title_required', 'Title is required');
  const agent = await getAgent(userId, input.agentId);
  if (!agent) throw AppError.notFound('Agent');

  if (input.projectId) {
    const p = await withTenant<{ id: string }[]>(userId, (q) =>
      q.query<{ id: string }>('SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [input.projectId, userId]).then((r) => r.rows),
    );
    if (!p[0]) throw AppError.notFound('Project');
  }

  const now = new Date();
  const anchor = validateAnchor(input, now);
  const initialNext = nextRunAt(anchor, now);
  if (!initialNext) throw AppError.badRequest('no_next_run', 'Schedule has no valid next run');

  const id = newId(PREFIX.SCHEDULE);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO scheduled_tasks (
         id, owner_id, project_id, agent_id, title, description, recurrence, cron_expression,
         timezone, run_at, run_on_days, enabled, execution_mode, missed_run_policy,
         next_run_at, require_approval, timeout_ms, max_attempts, notify_on_completion
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,true,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id, userId, input.projectId ?? null, input.agentId, title, input.description ?? null,
        anchor.recurrence, anchor.cronExpression, anchor.timezone, anchor.runAt,
        JSON.stringify(anchor.runOnDays), input.executionMode ?? 'CLOUD', input.missedRunPolicy ?? 'RUN_ON_RECOVERY',
        initialNext.toISOString(), input.requireApproval ?? false,
        input.timeoutMs ?? 900000, input.maxAttempts ?? 3, input.notifyOnCompletion ?? false,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.SCHEDULE_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schedule',
    resourceId: id,
    detail: { recurrence: anchor.recurrence, nextRunAt: initialNext.toISOString(), agentId: input.agentId, executionMode: input.executionMode ?? 'CLOUD' },
  });
  return getOwnedSchedule(userId, id);
}

export async function updateSchedule(userId: string, scheduleId: string, patch: Partial<ScheduleInput>): Promise<ScheduledTaskRow> {
  const existing = await getOwnedSchedule(userId, scheduleId);
  const merged: ScheduleInput = {
    projectId: patch.projectId !== undefined ? patch.projectId : existing.project_id,
    agentId: patch.agentId ?? existing.agent_id,
    title: patch.title ?? existing.title,
    description: patch.description !== undefined ? patch.description : existing.description,
    recurrence: patch.recurrence ?? existing.recurrence,
    cronExpression: patch.cronExpression !== undefined ? patch.cronExpression : existing.cron_expression,
    timezone: patch.timezone ?? existing.timezone,
    runAt: patch.runAt ?? existing.run_at,
    runOnDays: patch.runOnDays ?? existing.run_on_days,
    executionMode: patch.executionMode ?? existing.execution_mode,
    missedRunPolicy: patch.missedRunPolicy ?? existing.missed_run_policy,
    requireApproval: patch.requireApproval ?? existing.require_approval,
    timeoutMs: patch.timeoutMs ?? existing.timeout_ms,
    maxAttempts: patch.maxAttempts ?? existing.max_attempts,
    notifyOnCompletion: patch.notifyOnCompletion ?? existing.notify_on_completion,
  };

  const agent = await getAgent(userId, merged.agentId);
  if (!agent) throw AppError.notFound('Agent');
  const now = new Date();
  const anchor = validateAnchor({ ...merged, recurrence: merged.recurrence, timezone: merged.timezone } as ScheduleInput, now);
  const next = nextRunAt(anchor, now);
  if (!next) throw AppError.badRequest('no_next_run', 'Schedule has no valid next run');

  await withTenant(userId, (q) =>
    q.query(
      `UPDATE scheduled_tasks SET
         project_id = $3, agent_id = $4, title = $5, description = $6, recurrence = $7,
         cron_expression = $8, timezone = $9, run_at = $10, run_on_days = $11::jsonb,
         execution_mode = $12, missed_run_policy = $13, require_approval = $14,
         timeout_ms = $15, max_attempts = $16, notify_on_completion = $17,
         next_run_at = $18, enabled = true, error = NULL, updated_at = now()
       WHERE id = $1 AND owner_id = $2`,
      [
        scheduleId, userId, merged.projectId ?? null, merged.agentId, merged.title,
        merged.description ?? null, anchor.recurrence, anchor.cronExpression, anchor.timezone,
        anchor.runAt, JSON.stringify(anchor.runOnDays), merged.executionMode,
        merged.missedRunPolicy, merged.requireApproval ?? false, merged.timeoutMs ?? 900000,
        merged.maxAttempts ?? 3, merged.notifyOnCompletion ?? false, next.toISOString(),
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.SCHEDULE_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schedule',
    resourceId: scheduleId,
    detail: { nextRunAt: next.toISOString() },
  });
  return getOwnedSchedule(userId, scheduleId);
}

export async function setScheduleEnabled(userId: string, scheduleId: string, enabled: boolean): Promise<ScheduledTaskRow> {
  const existing = await getOwnedSchedule(userId, scheduleId);
  if (existing.enabled === enabled) return existing;
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE scheduled_tasks SET enabled = $3, updated_at = now() WHERE id = $1 AND owner_id = $2`,
      [scheduleId, userId, enabled],
    ),
  );
  await recordAudit({
    action: enabled ? AuditAction.SCHEDULE_RESUMED : AuditAction.SCHEDULE_PAUSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schedule',
    resourceId: scheduleId,
    detail: { enabled },
  });
  return getOwnedSchedule(userId, scheduleId);
}

export async function deleteSchedule(userId: string, scheduleId: string): Promise<void> {
  await getOwnedSchedule(userId, scheduleId);
  await withTenant(userId, (q) => q.query('DELETE FROM scheduled_tasks WHERE id = $1 AND owner_id = $2', [scheduleId, userId]));
  await recordAudit({
    action: AuditAction.SCHEDULE_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schedule',
    resourceId: scheduleId,
  });
}

/** Server-authoritative preview of the next N run instants (never client-computed). */
export async function previewNextRuns(userId: string, scheduleId: string, count = 5): Promise<{ anchor: ScheduleAnchor; next: string[] }> {
  const existing = await getOwnedSchedule(userId, scheduleId);
  const anchor: ScheduleAnchor = {
    recurrence: existing.recurrence,
    runAt: existing.run_at,
    runOnDays: existing.run_on_days,
    timezone: existing.timezone,
    cronExpression: existing.cron_expression,
  };
  const next: string[] = [];
  let cursor = nextRunAt(anchor, existing.next_run_at);
  for (let i = 0; i < count && cursor; i++) {
    next.push(cursor.toISOString());
    cursor = nextRunAt(anchor, cursor);
  }
  return { anchor, next };
}

export interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  owner_id: string;
  scheduled_for: Date;
  status: string;
  task_id: string | null;
  agent_run_id: string | null;
  reason: string | null;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export async function listScheduleRuns(userId: string, scheduleId: string, limit = 20): Promise<ScheduleRunRow[]> {
  const rows = await withTenant<ScheduleRunRow[]>(userId, (q) =>
    q
      .query<ScheduleRunRow>(
        `SELECT * FROM schedule_runs WHERE owner_id = $1 AND schedule_id = $2 ORDER BY scheduled_for DESC LIMIT $3`,
        [userId, scheduleId, Math.min(Math.max(limit, 1), 100)],
      )
      .then((r) => r.rows),
  );
  return rows.map((r) => ({
    ...r,
    scheduled_for: new Date(r.scheduled_for as unknown as string),
    started_at: r.started_at ? new Date(r.started_at as unknown as string) : null,
    completed_at: r.completed_at ? new Date(r.completed_at as unknown as string) : null,
    created_at: new Date(r.created_at as unknown as string),
  }));
}

/**
 * Manual "run now": executes a schedule immediately without changing its
 * recurrence. Idempotent within a short window — a second call while the
 * previous run is still in flight is rejected (single business execution).
 */
export async function runNow(userId: string, scheduleId: string): Promise<ScheduleRunRow> {
  const schedule = await getOwnedSchedule(userId, scheduleId);
  const pending = await withTenant<{ id: string }[]>(userId, (q) =>
    q
      .query<{ id: string }>(
        `SELECT id FROM schedule_runs
          WHERE schedule_id = $1 AND status IN ('DUE','CLAIMED','ENQUEUED','RUNNING','WAITING_FOR_APPROVAL','WAITING_FOR_LOCAL_AGENT')
          LIMIT 1`,
        [scheduleId],
      )
      .then((r) => r.rows),
  );
  if (pending[0]) throw AppError.conflict('run_in_flight', 'A run for this schedule is already in flight');

  const { claimOccurrence, executeClaimedRun } = await import('./executor.js');
  const claimed = await claimOccurrence(scheduleId, userId, new Date());
  if (!claimed) throw AppError.conflict('run_in_flight', 'A run for this schedule was claimed concurrently');
  let run: ScheduleRunRow;
  try {
    run = await executeClaimedRun(schedule, claimed, 'manual');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await import('./executor.js').then(async (m) => m.markScheduleRunFailed(userId, claimed.id, msg));
    throw AppError.conflict('run_execution_failed', `Run could not start: ${msg}`);
  }
  await recordAudit({
    action: AuditAction.SCHEDULE_RUN_NOW,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schedule',
    resourceId: scheduleId,
    detail: { runId: run.id },
  });
  return run;
}

/** Human description of the schedule's recurrence (server-authoritative). */
export function describeSchedule(schedule: ScheduledTaskRow): string {
  return describeAnchor({
    recurrence: schedule.recurrence,
    runAt: schedule.run_at,
    runOnDays: schedule.run_on_days,
    timezone: schedule.timezone,
    cronExpression: schedule.cron_expression,
  });
}

export { describeAnchor };

/** Reconcile a live run against its agent run/task terminal states. */
export async function reconcileScheduleRuns(limit = 100): Promise<number> {
  const { reconcileDueSchedules } = await import('./executor.js');
  return reconcileDueSchedules(limit);
}

export { NotificationType as _scheduleNotificationTypes };