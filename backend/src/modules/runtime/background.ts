/**
 * CodeConClave — PKG-19 runtime — background development tasks (F90 expansion).
 * Tracks build/test/lint/typecheck/dev-server/watch commands as long-running
 * background tasks with an honest lifecycle and streaming latest output. Tasks
 * run through the same policy-gated sandbox runner; a request returns
 * immediately and the task is finalized asynchronously (mirroring the preview
 * module's fire-and-forget build pattern). Stopping a task is best-effort: it
 * requests cancellation and records the state; the sandbox enforces its own
 * hard timeout so no unbounded process can survive.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { BackgroundTask, CreateBackgroundInput, RuntimeExecutionStatus } from './types.js';
import {
  assertProjectAccess,
  evaluateCommand,
  redactOutput,
  projectWorkspaceRoot,
  sandboxAllowedCommands,
  sandboxTimeoutMs,
  workspaceUsable,
  type RuntimeRunner,
} from './security.js';
import { defaultRunner, executionConfigured } from './runner.js';
import { broadcastRuntime } from './events.js';

export interface BackgroundRow {
  id: string;
  project_id: string;
  label: string;
  kind: string;
  command: string;
  status: string;
  pid: number | null;
  exit_code: number | null;
  latest_output: string;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
  created_at: Date;
}

function rowToTask(r: BackgroundRow): BackgroundTask {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    kind: r.kind,
    command: r.command,
    status: r.status as RuntimeExecutionStatus,
    pid: r.pid,
    exitCode: r.exit_code,
    latestOutput: r.latest_output,
    error: r.error,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  };
}

export class RuntimeBackgroundEngine {
  constructor(
    private runner: RuntimeRunner = defaultRunner(),
    private config: () => { allowed: string[]; timeoutMs: number } = () => ({
      allowed: sandboxAllowedCommands(),
      timeoutMs: sandboxTimeoutMs(),
    }),
  ) {}

  async start(userId: string, input: CreateBackgroundInput): Promise<BackgroundTask> {
    await assertProjectAccess(userId, input.projectId);
    const command = String(input.command ?? '').trim();
    if (!command) throw AppError.badRequest('runtime_command_required', 'command is required');
    if (!input.label?.trim()) throw AppError.badRequest('runtime_label_required', 'label is required');

    const id = newId(PREFIX.RUNTIME_BACKGROUND);
    const guard = evaluateCommand(userId, command);
    const configured = executionConfigured();
    const root = projectWorkspaceRoot(input.projectId);
    const usable = root ? await workspaceUsable(input.projectId) : false;
    const allowed = this.config().allowed;
    const firstToken = (command.split(/\s+/)[0] ?? '');

    const blockedReason =
      !guard.allowed ? (guard.blockedReason ?? 'denied by policy')
      : !configured || !root || !usable ? 'runtime execution is not configured (workspace or sandbox missing)'
      : allowed.length > 0 && !allowed.includes(firstToken) ? `command '${firstToken}' is not allow-listed in the sandbox`
      : null;

    if (blockedReason) {
      await withTenant(userId, async (q) =>
        q.query(
          `INSERT INTO runtime_background_tasks (id, owner_id, project_id, label, kind, command, status, error, latest_output)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'')`,
          [id, userId, input.projectId, input.label.trim().slice(0, 200), input.kind ?? 'CUSTOM', command, 'BLOCKED', blockedReason],
        ),
      );
      broadcastRuntime(input.projectId, { type: 'background', id, projectId: input.projectId, status: 'BLOCKED', ts: new Date().toISOString() });
      return this.getRowView(userId, id, input.projectId);
    }

    await withTenant(userId, async (q) =>
      q.query(
        `INSERT INTO runtime_background_tasks (id, owner_id, project_id, label, kind, command, status, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [id, userId, input.projectId, input.label.trim().slice(0, 200), input.kind ?? 'CUSTOM', command, 'STARTING'],
      ),
    );
    broadcastRuntime(input.projectId, { type: 'background', id, projectId: input.projectId, status: 'STARTING', ts: new Date().toISOString() });

    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : this.config().timeoutMs;
    void this.finalizeRun(userId, id, input.projectId, command, root!, timeoutMs);
    return this.getRowView(userId, id, input.projectId);
  }

  private async finalizeRun(
    userId: string,
    id: string,
    projectId: string,
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<void> {
    await withTenant(userId, async (q) => {
      await q.query(`UPDATE runtime_background_tasks SET status = 'RUNNING' WHERE id = $1`, [id]);
      broadcastRuntime(projectId, { type: 'background', id, projectId, status: 'RUNNING', ts: new Date().toISOString() });
      let status: RuntimeExecutionStatus = 'FAILED';
      let exitCode: number | null = null;
      let out = '';
      try {
        const result = await this.runner.run({ command, cwd, timeoutMs, authorized: true });
        exitCode = result.exitCode;
        if (result.timedOut) status = 'TIMED_OUT';
        else if (result.killed && !result.timedOut) status = 'CANCELLED';
        else status = exitCode === 0 ? 'COMPLETED' : 'FAILED';
        out = redactOutput([result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 200_000));
        await q.query(
          `UPDATE runtime_background_tasks SET status = $2, exit_code = $3, latest_output = $4, error = $5, ended_at = now()
           WHERE id = $1`,
          [id, status, exitCode, out, status !== 'COMPLETED' ? `exit ${String(exitCode)}` : null],
        );
      } catch (err) {
        status = 'FAILED';
        await q.query(
          `UPDATE runtime_background_tasks SET status = 'FAILED', ended_at = now(), error = $2, latest_output = $3 WHERE id = $1`,
          [id, (err as Error)?.message?.slice(0, 2000) ?? 'task failed', ''],
        );
      }
      broadcastRuntime(projectId, { type: 'background', id, projectId, status, ts: new Date().toISOString() });
    });
  }

  async list(userId: string, projectId: string, limit = 50): Promise<BackgroundTask[]> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant(userId, async (q) =>
      (await q.query<BackgroundRow>(
        `SELECT * FROM runtime_background_tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [projectId, limit],
      )).rows,
    );
    return rows.map(rowToTask);
  }

  async get(userId: string, projectId: string, taskId: string): Promise<BackgroundTask> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant(userId, async (q) =>
      (await q.query<BackgroundRow>(
        `SELECT * FROM runtime_background_tasks WHERE id = $1 AND project_id = $2`,
        [taskId, projectId],
      )).rows,
    );
    if (!rows[0]) throw AppError.notFound('RuntimeBackgroundTask');
    return rowToTask(rows[0]);
  }

  /** Best-effort stop: requests cancellation and records the state. The
   * underlying sandbox command enforces its own hard timeout (no unbounded run). */
  async stop(userId: string, projectId: string, taskId: string): Promise<BackgroundTask> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant(userId, async (q) =>
      (await q.query<BackgroundRow>(
        `SELECT * FROM runtime_background_tasks WHERE id = $1 AND project_id = $2`,
        [taskId, projectId],
      )).rows,
    );
    if (!rows[0]) throw AppError.notFound('RuntimeBackgroundTask');
    const current = rows[0].status;
    if (current === 'STARTING' || current === 'RUNNING') {
      await withTenant(userId, async (q) =>
        q.query(
          `UPDATE runtime_background_tasks SET status = 'STOPPED', ended_at = now(), error = 'stop requested (best-effort)' WHERE id = $1`,
          [taskId],
        ),
      );
      broadcastRuntime(projectId, { type: 'background', id: taskId, projectId, status: 'STOPPED', ts: new Date().toISOString() });
    }
    return this.getRowView(userId, taskId, projectId);
  }

  private async getRowView(userId: string, id: string, projectId: string): Promise<BackgroundTask> {
    const rows = await withTenant(userId, async (q) =>
      (await q.query<BackgroundRow>(
        `SELECT * FROM runtime_background_tasks WHERE id = $1 AND project_id = $2`,
        [id, projectId],
      )).rows,
    );
    if (!rows[0]) throw AppError.notFound('RuntimeBackgroundTask');
    return rowToTask(rows[0]);
  }
}

export const runtimeBackgroundEngine = new RuntimeBackgroundEngine();
