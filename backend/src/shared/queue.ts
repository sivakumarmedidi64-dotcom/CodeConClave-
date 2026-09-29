/**
 * CodeConClave — task queue (claim + recover). Backed by the tasks table itself;
 * QUEUE_PROVIDER=redis adds best-effort notifications; polling is the source of
 * truth either way (works without external infra — no fakes).
 */
import { pool } from './db.js';
import { env } from '../config/env.js';
import { recordLatencyMetric } from '../observability/metrics.js';

export type QueueProvider = 'memory' | 'redis';

export function queueProvider(): QueueProvider {
  return env.QUEUE_PROVIDER;
}

export async function enqueueTask(taskId: string): Promise<void> {
  // Polling the tasks table is the source of truth; no external queue is
  // required for correctness (QUEUE_PROVIDER is an optimization only).
  void taskId;
}

export interface QueuedTask {
  id: string;
  project_id: string;
  owner_id: string;
  title: string;
  risk_level: string;
  execution_mode: 'CLOUD' | 'LOCAL' | 'HYBRID';
  created_at: Date;
}

/** Atomically claim next runnable task (no approval required / already approved). */
export async function claimNextTask(workerId: string, limit = 1): Promise<QueuedTask[]> {
  const result = await pool.query(
    `UPDATE tasks
        SET status = 'RUNNING', last_heartbeat_at = now(), updated_at = now(),
            -- Stamp started_at at claim time so the timeout sweep
            -- (failTimedOutTasks, gated on started_at IS NOT NULL) can bound a
            -- task even if the worker crashes before beginAttempt runs.
            started_at = COALESCE(started_at, now())
      WHERE id IN (
        SELECT id FROM tasks
         WHERE status IN ('CREATED','PLANNED','CHANGED')
           AND paused_at IS NULL
           AND (required_approval = false OR approval_id IS NOT NULL)
           AND execution_mode IN ('CLOUD','HYBRID')
           AND attempt_count < max_attempts
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies td
             JOIN tasks dep ON dep.id = td.depends_on_task_id
             WHERE td.task_id = tasks.id AND dep.status <> 'COMPLETED'
           )
         ORDER BY priority DESC, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, project_id, owner_id, title, risk_level, execution_mode, created_at`,
    [limit],
  );
  const rows = result.rows as QueuedTask[];
  // Phase 16: measure queue wait (created_at → claim) for honest latency data.
  for (const row of rows) {
    const waitMs = Date.now() - new Date(row.created_at).getTime();
    recordLatencyMetric('queue_wait_ms', waitMs);
  }
  return rows;
}

/** Watchdog: recover stale RUNNING tasks back to CREATED for re-claim. */
export async function recoverStaleTasks(heartbeatTtlMs: number): Promise<number> {
  const result = await pool.query(
    `UPDATE tasks
        SET status = 'CREATED', error_code = 'recovered_heartbeat_timeout', updated_at = now()
      WHERE status = 'RUNNING'
        AND last_heartbeat_at < now() - ($1 || ' milliseconds')::interval
      RETURNING id`,
    [heartbeatTtlMs],
  );
  return result.rowCount ?? 0;
}

/** Watchdog: fail tasks whose overall timeout_ms budget expired. */
export async function failTimedOutTasks(): Promise<number> {
  const result = await pool.query(
    `UPDATE tasks
        SET status = 'TIMED_OUT', error_code = 'task_timeout', failed_at = now(), updated_at = now()
      WHERE status IN ('CREATED','PLANNED','RUNNING','TESTING','VERIFIED','REQUIRES_REVIEW','BLOCKED')
        AND started_at IS NOT NULL
        AND started_at + (timeout_ms || ' milliseconds')::interval < now()
      RETURNING id`,
  );
  return result.rowCount ?? 0;
}

/** Block tasks whose approval is pending beyond APPROVAL_REJECT_TIMEOUT (2h) → CANCELLED. */
export async function expireWaitingApprovals(): Promise<number> {
  const result = await pool.query(
    `UPDATE tasks SET status = 'CANCELLED', error_code = 'approval_not_answered', updated_at = now()
      WHERE status = 'WAITING_APPROVAL'
        AND created_at < now() - interval '2 hours'
      RETURNING id`,
  );
  return result.rowCount ?? 0;
}

export async function pendingTaskCount(): Promise<number> {
  const row = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tasks
      WHERE status IN ('CREATED','PLANNED','CHANGED')
        AND paused_at IS NULL
        AND (required_approval = false OR approval_id IS NOT NULL)
        AND execution_mode IN ('CLOUD','HYBRID')
        AND attempt_count < max_attempts
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
  );
  return row.rows[0]!.n as number;
}