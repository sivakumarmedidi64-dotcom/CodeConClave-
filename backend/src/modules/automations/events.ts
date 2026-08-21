/**
 * CodeConClave — internal event emission (Stage 26D).
 * Best-effort hooks fired from the task and schedule engines when work
 * completes or fails. Emits are deliberately cheap and never throw into the
 * caller: ingestEvent is idempotent (event_log UNIQUE source+event_id) so a
 * duplicated or late emission is harmless.
 */
import type { EventContext } from './executor.js';

export interface EmitContext {
  source: 'task_completed' | 'schedule' | 'plugin' | 'deployment' | 'webhook';
  eventId: string;
  eventType: string;
  ownerId: string;
  payload: Record<string, unknown>;
}

/** Fire an event into the automation pipeline. Never throws. */
export async function emitEvent(ctx: EmitContext): Promise<void> {
  try {
    const { ingestEvent } = await import('./executor.js');
    await ingestEvent(ctx as EventContext);
  } catch {
    /* hooks must never break the caller */
  }
}

export async function emitTaskCompleted(userId: string, task: { id: string; title?: string | null; objective?: string | null }): Promise<void> {
  await emitEvent({
    source: 'task_completed',
    eventId: `task-completed-${task.id}`,
    eventType: 'task.completed',
    ownerId: userId,
    payload: { taskId: task.id, title: task.title ?? task.objective ?? '' },
  });
}

export async function emitTaskFailed(userId: string, task: { id: string; title?: string | null; objective?: string | null }, error: string): Promise<void> {
  await emitEvent({
    source: 'task_completed',
    eventId: `task-failed-${task.id}`,
    eventType: 'task.failed',
    ownerId: userId,
    payload: { taskId: task.id, title: task.title ?? task.objective ?? '', error },
  });
}

export async function emitScheduleExecuted(userId: string, schedule: { id: string; title?: string | null; objective?: string | null }, runId?: string): Promise<void> {
  await emitEvent({
    source: 'schedule',
    eventId: `schedule-executed-${schedule.id}-${runId ?? Date.now()}`,
    eventType: 'schedule.executed',
    ownerId: userId,
    payload: { scheduleId: schedule.id, title: schedule.title ?? schedule.objective ?? '' },
  });
}

export async function emitScheduleFailed(userId: string, schedule: { id: string; title?: string | null; objective?: string | null }, error: string, runId?: string): Promise<void> {
  await emitEvent({
    source: 'schedule',
    eventId: `schedule-failed-${schedule.id}-${runId ?? Date.now()}`,
    eventType: 'schedule.failed',
    ownerId: userId,
    payload: { scheduleId: schedule.id, title: schedule.title ?? schedule.objective ?? '', error },
  });
}