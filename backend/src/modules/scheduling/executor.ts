/**
 * CodeConClave — scheduled task executor (Stage 26C).
 * Runs inside the EXISTING watchdog sweep (no separate scheduler process).
 * Each due occurrence is claimed atomically through the unique
 * (schedule_id, scheduled_for) constraint — if the tick fires twice, the
 * second insert is a no-op, so exactly one business execution happens per
 * occurrence. Execution itself reuses the existing agent engine (startRun),
 * so the queue/worker/watchdog/approval pipeline is the single execution path.
 *
 * Missed-run handling (when an occurrence is found overdue):
 *   RUN_ON_RECOVERY  → latest missed occurrence executes (reason
 *                      'recovered_missed'); older missed are recorded MISSED.
 *   RUN_ONCE         → latest missed executes (reason 'covered_by_single_run');
 *                      older missed are recorded SKIPPED.
 *   SKIP_STALE       → nothing executes; occurrences are recorded SKIPPED
 *                      ('stale_missed').
 */
import { pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { startRun, getAgent } from '../agents/service.js';
import { nextRunAt, occurrencesBetween, type ScheduleAnchor } from './recurrence.js';
import type { ScheduleRunRow, ScheduledTaskRow } from './service.js';
import { rowToSchedule } from './service.js';

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const PERIOD_LABELS: Record<string, number> = {
  HOURLY: 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 31 * 24 * 60 * 60 * 1000,
};

function anchorFor(s: ScheduledTaskRow): ScheduleAnchor {
  return {
    recurrence: s.recurrence,
    runAt: s.run_at,
    runOnDays: s.run_on_days,
    timezone: s.timezone,
    cronExpression: s.cron_expression,
  };
}

/** Staleness threshold: a missed occurrence older than this triggers policy. */
function staleThresholdMs(s: ScheduledTaskRow): number {
  return Math.max(DEFAULT_STALE_MS, PERIOD_LABELS[s.recurrence] ?? DEFAULT_STALE_MS);
}

/** Atomically claim an occurrence. Returns the inserted row or null on conflict. */
export async function claimOccurrence(scheduleId: string, ownerId: string, scheduledFor: Date): Promise<ScheduleRunRow | null> {
  const result = await pool.query(
    `INSERT INTO schedule_runs (id, schedule_id, owner_id, scheduled_for, status)
     VALUES ($1,$2,$3,$4,'DUE')
     ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
     RETURNING *`,
    [newId(PREFIX.SCHEDULE_RUN), scheduleId, ownerId, scheduledFor.toISOString()],
  );
  if (!result.rows[0]) return null;
  return mapRunRow(result.rows[0]);
}

function mapRunRow(row: Record<string, unknown>): ScheduleRunRow {
  return {
    id: String(row.id),
    schedule_id: String(row.schedule_id),
    owner_id: String(row.owner_id),
    scheduled_for: new Date(row.scheduled_for as string),
    status: String(row.status),
    task_id: row.task_id ? String(row.task_id) : null,
    agent_run_id: row.agent_run_id ? String(row.agent_run_id) : null,
    reason: row.reason ? String(row.reason) : null,
    error: row.error ? String(row.error) : null,
    started_at: row.started_at ? new Date(row.started_at as string) : null,
    completed_at: row.completed_at ? new Date(row.completed_at as string) : null,
    created_at: new Date(row.created_at as string),
  };
}

async function updateRun(id: string, patch: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE schedule_runs SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function markFailed(run: ScheduleRunRow, error: string, reason?: string): Promise<void> {
  await updateRun(run.id, {
    status: 'FAILED',
    error,
    reason: reason ?? null,
    completed_at: new Date().toISOString(),
  });
  await recordAudit({
    action: AuditAction.SCHEDULE_SKIPPED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: run.owner_id,
    resourceType: 'schedule',
    resourceId: run.schedule_id,
    detail: { runId: run.id, outcome: 'failed', error },
  });
}

/** Export for manual run-now paths: mark a claimed run failed by id. */
export async function markScheduleRunFailed(runId: string, error: string): Promise<void> {
  await updateRun(runId, {
    status: 'FAILED',
    error,
    reason: 'execution_failed',
    completed_at: new Date().toISOString(),
  });
}

/** Record a non-executed occurrence per the missed-run policy. */
async function recordMissed(run: ScheduleRunRow, schedule: ScheduledTaskRow, kind: 'MISSED' | 'SKIPPED', reason: string): Promise<void> {
  await updateRun(run.id, {
    status: kind,
    reason,
    completed_at: new Date().toISOString(),
  });
  await recordAudit({
    action: kind === 'MISSED' ? AuditAction.SCHEDULE_MISSED : AuditAction.SCHEDULE_SKIPPED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: schedule.owner_id,
    resourceType: 'schedule',
    resourceId: schedule.id,
    detail: { runId: run.id, reason },
  });
}

/**
 * Execute a claimed occurrence by materializing real tasks through the agent
 * engine. Returns the updated run row.
 */
export async function executeClaimedRun(schedule: ScheduledTaskRow, run: ScheduleRunRow, reason?: string): Promise<ScheduleRunRow> {
  const agent = await getAgent(schedule.owner_id, schedule.agent_id);
  if (!agent) throw AppError.notFound('Agent');
  if (agent.status !== 'IDLE') {
    throw AppError.conflict('agent_busy', `Agent ${schedule.agent_id} has an active run`);
  }

  const agentRun = await startRun(schedule.owner_id, schedule.agent_id, {
    projectId: schedule.project_id ?? undefined,
    objective: schedule.title,
    subtasks: schedule.description
      ? [{ title: schedule.title, description: schedule.description }]
      : [{ title: schedule.title }],
    requireApproval: schedule.require_approval,
  });

  // Apply the schedule's execution contract to the run's tasks (server-authoritative).
  const modeSql = schedule.execution_mode === 'LOCAL_ONLY' ? 'LOCAL' : schedule.execution_mode;
  await pool.query(
    `UPDATE tasks SET execution_mode = $2, timeout_ms = $3, max_attempts = $4
      WHERE agent_run_id = $1`,
    [agentRun.id, modeSql, schedule.timeout_ms, schedule.max_attempts],
  );

  const status = schedule.require_approval
    ? 'WAITING_FOR_APPROVAL'
    : schedule.execution_mode === 'LOCAL_ONLY'
      ? 'WAITING_FOR_LOCAL_AGENT'
      : 'RUNNING';
  await updateRun(run.id, {
    status,
    agent_run_id: agentRun.id,
    reason: reason ?? null,
    started_at: new Date().toISOString(),
  });

  await recordAudit({
    action: AuditAction.SCHEDULE_EXECUTED,
    actorUserId: schedule.owner_id,
    scope: 'USER',
    tenantId: schedule.owner_id,
    resourceType: 'schedule',
    resourceId: schedule.id,
    detail: { runId: run.id, agentRunId: agentRun.id, executionMode: schedule.execution_mode, recovered: reason === 'recovered_missed' },
  });

  return { ...run, status, agent_run_id: agentRun.id, reason: reason ?? null, started_at: new Date() };
}

/** Advance a schedule past the occurrence it just consumed. */
async function advanceSchedule(
  schedule: ScheduledTaskRow,
  now: Date,
  firedAt: Date,
  outcome: 'EXECUTED' | 'FAILED' | 'SKIPPED' = 'EXECUTED',
  error?: string | null,
): Promise<void> {
  const anchor = anchorFor(schedule);
  const next = nextRunAt(anchor, now);
  if (schedule.recurrence === 'ONCE' && !next) {
    await pool.query(
      `UPDATE scheduled_tasks SET enabled = false, next_run_at = $3, last_run_at = $3, last_run_status = $4, run_count = run_count + 1, error = $5, updated_at = now()
       WHERE id = $1 AND owner_id = $2`,
      [schedule.id, schedule.owner_id, firedAt.toISOString(), outcome, error ?? null],
    );
    return;
  }
  if (!next) return;
  await pool.query(
    `UPDATE scheduled_tasks SET next_run_at = $3, last_run_at = $4, last_run_status = $5, run_count = run_count + 1, error = $6, updated_at = now()
     WHERE id = $1 AND owner_id = $2`,
    [schedule.id, schedule.owner_id, next.toISOString(), firedAt.toISOString(), outcome, error ?? null],
  );
}

/**
 * Watchdog scheduler tick: find due schedules, claim + execute each, apply
 * missed-run policies. Returns the number of occurrences processed.
 */
export async function schedulerTick(limit = 50): Promise<number> {
  const due = await queryMany<ScheduledTaskRow>(
    `SELECT * FROM scheduled_tasks WHERE enabled = true AND next_run_at <= now()
     ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  const now = new Date();
  let processed = 0;

  for (const raw of due) {
    const schedule = rowToSchedule(raw as unknown as Record<string, unknown>);
    const scheduledFor = schedule.next_run_at;
    const run = await claimOccurrence(schedule.id, schedule.owner_id, scheduledFor);
    if (!run) continue; // another tick claimed this occurrence — idempotent skip

    const lagMs = now.getTime() - scheduledFor.getTime();
    const stale = schedule.recurrence !== 'ONCE' && lagMs > staleThresholdMs(schedule);

    if (stale) {
      const policy = schedule.missed_run_policy;
      const missed = occurrencesBetween(anchorFor(schedule), schedule.last_run_at ?? schedule.created_at, scheduledFor, 10);
      const latest = missed[missed.length - 1] ?? scheduledFor;
      const older = missed.filter((d) => d.getTime() < latest.getTime());

      if (policy === 'SKIP_STALE') {
        for (const d of older) {
          const oldRun = await claimOccurrence(schedule.id, schedule.owner_id, d);
          if (oldRun) await recordMissed(oldRun, schedule, 'SKIPPED', 'stale_missed');
        }
        if (run.scheduled_for.getTime() === latest.getTime()) {
          await recordMissed(run, schedule, 'SKIPPED', 'stale_missed');
        }
        await advanceSchedule(schedule, now, scheduledFor, 'SKIPPED', 'stale_missed');
        processed++;
        continue;
      }

      const reason = policy === 'RUN_ONCE' ? 'covered_by_single_run' : 'recovered_missed';
      const skipKind = policy === 'RUN_ONCE' ? 'SKIPPED' : 'MISSED';
      const skipReason = policy === 'RUN_ONCE' ? 'covered_by_single_run' : 'missed_window';
      for (const d of older) {
        const oldRun = await claimOccurrence(schedule.id, schedule.owner_id, d);
        if (oldRun) await recordMissed(oldRun, schedule, skipKind, skipReason);
      }
      // If the overdue occurrence itself is not the latest, mark it and run the latest.
      let toRun = run;
      if (run.scheduled_for.getTime() !== latest.getTime()) {
        await recordMissed(run, schedule, skipKind, skipReason);
        const latestRun = await claimOccurrence(schedule.id, schedule.owner_id, latest);
        if (!latestRun) {
          await advanceSchedule(schedule, now, scheduledFor, 'SKIPPED', skipReason);
          processed++;
          continue;
        }
        toRun = latestRun;
      }
      try {
        await executeClaimedRun(schedule, toRun, reason);
        await advanceSchedule(schedule, now, scheduledFor, 'EXECUTED');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markFailed(toRun, msg, 'execution_failed');
        await advanceSchedule(schedule, now, scheduledFor, 'FAILED', msg);
      }
      processed++;
      continue;
    }

    // Normal (on-time) execution.
    try {
      await executeClaimedRun(schedule, run);
      await advanceSchedule(schedule, now, scheduledFor, 'EXECUTED');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(run, msg, 'execution_failed');
      await advanceSchedule(schedule, now, scheduledFor, 'FAILED', msg);
    }
    processed++;
  }

  return processed;
}

/**
 * Watchdog reconcile: fold terminal agent-run states back onto live schedule
 * runs, fire completion notifications, and mark schedule timeouts truthfully.
 */
export async function reconcileDueSchedules(limit = 100): Promise<number> {
  const live = await queryMany<ScheduleRunRow>(
    `SELECT sr.* FROM schedule_runs sr
      JOIN ai_agent_runs ar ON ar.id = sr.agent_run_id
     WHERE sr.status IN ('RUNNING','WAITING_FOR_APPROVAL','WAITING_FOR_LOCAL_AGENT')
       AND ar.status IN ('COMPLETED','FAILED','BLOCKED','TIMED_OUT')
     ORDER BY sr.scheduled_for
     LIMIT $1`,
    [limit],
  );
  let changed = 0;
  for (const raw of live) {
    const run = mapRunRow(raw as unknown as Record<string, unknown>);
    const agentState = await queryMany<{ status: string; error: string | null }>(
      'SELECT status, error FROM ai_agent_runs WHERE id = $1', [run.agent_run_id],
    );
    const st = agentState[0]?.status;
    const err = agentState[0]?.error ?? null;
    if (!st) continue;
    const sched = await queryMany<ScheduledTaskRow>('SELECT * FROM scheduled_tasks WHERE id = $1', [run.schedule_id]);
    if (!sched[0]) continue;
    const schedule = rowToSchedule(sched[0] as unknown as Record<string, unknown>);

    if (st === 'COMPLETED') {
      await updateRun(run.id, { status: 'COMPLETED', completed_at: new Date().toISOString(), error: null });
      await pool.query(`UPDATE scheduled_tasks SET last_run_status = 'COMPLETED', error = NULL, updated_at = now() WHERE id = $1`, [schedule.id]);
      if (schedule.notify_on_completion) {
        await notify(schedule.owner_id, NotificationType.SCHEDULE_RUN_COMPLETED, `Scheduled run completed: ${schedule.title}`, {
          body: `The scheduled run ${schedule.title} finished successfully.`,
          resourceType: 'schedule', resourceId: schedule.id,
        });
      }
      try {
        const { emitScheduleExecuted } = await import('../automations/events.js');
        await emitScheduleExecuted(schedule.owner_id, { id: schedule.id, title: schedule.title }, run.id);
      } catch {
        /* automation events are best-effort */
      }
      changed++;
    } else if (st === 'FAILED' || st === 'BLOCKED' || st === 'TIMED_OUT') {
      await updateRun(run.id, { status: st === 'TIMED_OUT' ? 'FAILED' : st, completed_at: new Date().toISOString(), error: err });
      await pool.query(`UPDATE scheduled_tasks SET last_run_status = 'FAILED', error = $2, updated_at = now() WHERE id = $1`, [schedule.id, err]);
      if (schedule.notify_on_completion) {
        await notify(schedule.owner_id, NotificationType.SCHEDULE_RUN_FAILED, `Scheduled run failed: ${schedule.title}`, {
          body: err ?? 'The scheduled run failed.',
          resourceType: 'schedule', resourceId: schedule.id,
        });
      }
      try {
        const { emitScheduleFailed } = await import('../automations/events.js');
        await emitScheduleFailed(schedule.owner_id, { id: schedule.id, title: schedule.title }, err ?? st, run.id);
      } catch {
        /* automation events are best-effort */
      }
      changed++;
    }
  }
  return changed;
}

/** Entry point for the watchdog sweep: process due runs then reconcile. */
export async function sweepScheduledRuns(limit = 50): Promise<{ scheduled: number; reconciled: number }> {
  const scheduled = await schedulerTick(limit);
  const reconciled = await reconcileDueSchedules(100);
  return { scheduled, reconciled };
}