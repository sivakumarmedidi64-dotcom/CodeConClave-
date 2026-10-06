/**
 * CodeConClave — execution -> runtime event bridge.
 * Published streams ((/api/v1/runtime/events?projectId=) already deliver
 * preview / execution / background / capture events. This module pushes REAL
 * task and coworker-run state transitions into that same project-scoped bus so
 * the Workbench can refresh immediately instead of spinning on a timer. Every
 * emit is best-effort: a failed broadcast or lookup must never break the
 * caller (task/coworker mutation) that triggered it.
 */
import { pool } from '../../shared/db.js';
import { broadcastRuntime } from '../runtime/events.js';

export async function emitTaskRuntime(taskId: string, status: string): Promise<void> {
  try {
    const rows = await pool.query<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    const projectId = rows.rows[0]?.project_id;
    if (!projectId) return;
    broadcastRuntime(projectId, {
      type: 'task',
      id: taskId,
      projectId,
      status,
      ts: new Date().toISOString(),
    });
  } catch {
    /* never break the caller */
  }
}

export async function emitCoworkerRuntime(runId: string, state: string): Promise<void> {
  try {
    const rows = await pool.query<{ project_id: string }>(
      `SELECT t.project_id
       FROM coworker_runs cr
       JOIN tasks t ON t.id = cr.task_id
       WHERE cr.id = $1`,
      [runId],
    );
    const projectId = rows.rows[0]?.project_id;
    if (!projectId) return;
    broadcastRuntime(projectId, {
      type: 'coworker',
      id: runId,
      runId,
      projectId,
      state,
      ts: new Date().toISOString(),
    });
  } catch {
    /* never break the caller */
  }
}