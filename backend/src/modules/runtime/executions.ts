/**
 * CodeConClave — PKG-19 runtime — executables engine (F34/F90 expansion).
 * Server-side controlled, policy-gated, time-boxed command runs with a full,
 * honest lifecycle (STARTED -> RUNNING -> COMPLETED/FAILED/TIMED_OUT/
 * CANCELLED/BLOCKED/STOPPED). Output is captured, secret-redacted, bounded and
 * streamed through the runtime event hub. Nothing is ever executed unless the
 * command passes the deterministic policy gate AND the sandbox allow-list; any
 * denial/absent tooling is persisted as an honest BLOCKED record (never a fake
 * success).
 */
import { withTenant, pool, queryMany, queryOne } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { CreateExecutionInput, RuntimeExecution, RuntimeExecutionKind, RuntimeExecutionStatus } from './types.js';
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
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ExecutionRow {
  id: string;
  project_id: string;
  kind: string;
  command: string;
  status: string;
  exit_code: number | null;
  timed_out: boolean;
  cancelled: boolean;
  blocked: boolean;
  output: string;
  error: string | null;
  duration_ms: number | null;
  started_at: Date;
  ended_at: Date | null;
  created_at: Date;
  environment?: string | null;
  cwd?: string | null;
}

const KIND_WHITELIST = new Set<string>(['RUN', 'BUILD', 'TEST', 'LINT', 'TYPECHECK', 'DEV_SERVER', 'CUSTOM']);

function rowToExecution(r: ExecutionRow): RuntimeExecution {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: (KIND_WHITELIST.has(r.kind) ? r.kind : 'RUN') as RuntimeExecutionKind,
    command: r.command,
    status: r.status as RuntimeExecutionStatus,
    exitCode: r.exit_code,
    timedOut: r.timed_out,
    cancelled: r.cancelled,
    blocked: r.blocked,
    output: r.output,
    error: r.error,
    durationMs: r.duration_ms,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    environment: r.environment ?? null,
    cwd: r.cwd ?? null,
  };
}

export class RuntimeExecutionsEngine {
  constructor(
    private runner: RuntimeRunner = defaultRunner(),
    private config: () => { allowed: string[]; timeoutMs: number } = () => ({
      allowed: sandboxAllowedCommands(),
      timeoutMs: sandboxTimeoutMs(),
    }),
  ) {}

  async execute(userId: string, input: CreateExecutionInput): Promise<RuntimeExecution> {
    await assertProjectAccess(userId, input.projectId);
    const kind = (KIND_WHITELIST.has(input.kind ?? 'RUN') ? input.kind : 'RUN') as RuntimeExecutionKind;
    const command = String(input.command ?? '').trim();
    if (!command) throw AppError.badRequest('runtime_command_required', 'command is required');

    const id = newId(PREFIX.RUNTIME_EXECUTION);
    const env = input.environment ?? null;
    const cwd = input.cwd ?? null;
    const guard = evaluateCommand(userId, command);

    // Persist a record first so the lifecycle is never lost, even when blocked.
    if (!guard.allowed) {
      await pool.query(
        `INSERT INTO runtime_executions (id, owner_id, project_id, kind, command, status, blocked, error, output, environment, cwd)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,'',$8,$9)`,
        [id, userId, input.projectId, kind, command, 'BLOCKED', guard.blockedReason ?? 'denied by policy', env, cwd],
      );
      broadcastRuntime(input.projectId, { type: 'execution', id, projectId: input.projectId, status: 'BLOCKED', ts: new Date().toISOString() });
      return this.getRowView(userId, id, input.projectId);
    }

    // Execution tooling readiness: workspace root + allow-list + existence.
    const configured = executionConfigured();
    const root = projectWorkspaceRoot(input.projectId);
    const usable = root ? await workspaceUsable(input.projectId) : false;
    if (!configured || !root || !usable) {
      await pool.query(
        `INSERT INTO runtime_executions (id, owner_id, project_id, kind, command, status, blocked, error, output, environment, cwd)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,'',$8,$9)`,
        [id, userId, input.projectId, kind, command, 'BLOCKED', 'runtime execution is not configured (workspace or sandbox missing)', env, cwd],
      );
      broadcastRuntime(input.projectId, { type: 'execution', id, projectId: input.projectId, status: 'BLOCKED', ts: new Date().toISOString() });
      return this.getRowView(userId, id, input.projectId);
    }

    const allowed = this.config().allowed;
    const firstToken = (command.split(/\s+/)[0] ?? '');
    if (allowed.length > 0 && !allowed.includes(firstToken)) {
      await pool.query(
        `INSERT INTO runtime_executions (id, owner_id, project_id, kind, command, status, blocked, error, output, environment, cwd)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,'',$8,$9)`,
        [id, userId, input.projectId, kind, command, 'BLOCKED', `command '${firstToken}' is not allow-listed in the sandbox`, env, cwd],
      );
      broadcastRuntime(input.projectId, { type: 'execution', id, projectId: input.projectId, status: 'BLOCKED', ts: new Date().toISOString() });
      return this.getRowView(userId, id, input.projectId);
    }

    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : this.config().timeoutMs;
    await pool.query(
      `INSERT INTO runtime_executions (id, owner_id, project_id, kind, command, status, started_at, environment, cwd)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
      [id, userId, input.projectId, kind, command, 'STARTED', env, cwd],
    );
    broadcastRuntime(input.projectId, { type: 'execution', id, projectId: input.projectId, status: 'STARTED', ts: new Date().toISOString() });
    await pool.query(
      `UPDATE runtime_executions SET status = 'RUNNING' WHERE id = $1`,
      [id],
    );
    broadcastRuntime(input.projectId, { type: 'execution', id, projectId: input.projectId, status: 'RUNNING', ts: new Date().toISOString() });

    let status: RuntimeExecutionStatus = 'FAILED';
    let exitCode: number | null = null;
    let timedOut = false;
    let cancelled = false;
    try {
      const result = await this.runner.run({
        command,
        cwd: root!,
        timeoutMs,
        authorized: true,
      });
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      cancelled = result.killed && !result.timedOut;
      if (timedOut) status = 'TIMED_OUT';
      else if (cancelled) status = 'CANCELLED';
      else status = exitCode === 0 ? 'COMPLETED' : 'FAILED';
      const output = redactOutput([result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 200_000));
      await pool.query(
        `UPDATE runtime_executions SET status = $2, exit_code = $3, timed_out = $4, cancelled = $5, output = $6, ended_at = now(), duration_ms = $7, error = $8
         WHERE id = $1`,
        [id, status, exitCode, timedOut, cancelled, output, result.durationMs, status !== 'COMPLETED' ? `exit ${String(exitCode)}` : null],
      );
    } catch (err) {
      const msg = (err as Error)?.message ?? 'execution error';
      await pool.query(
        `UPDATE runtime_executions SET status = 'FAILED', ended_at = now(), error = $2, output = $3 WHERE id = $1`,
        [id, msg.slice(0, 2000), '' ],
      );
      status = 'FAILED';
    }
    broadcastRuntime(input.projectId, { type: 'execution', id, projectId: input.projectId, status, ts: new Date().toISOString() });

    await recordAudit({
      action: AuditAction.TERMINAL_SESSION_CREATED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'runtime_execution',
      resourceId: id,
      detail: { projectId: input.projectId, kind, status, blocked: false },
      success: status === 'COMPLETED',
    }).catch(() => undefined);

    return this.getRowView(userId, id, input.projectId);
  }

  async list(userId: string, projectId: string, limit = 50): Promise<RuntimeExecution[]> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant<ExecutionRow[]>(userId, async (q) =>
      (
        await q.query<ExecutionRow>(
          `SELECT * FROM runtime_executions WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [projectId, limit],
        )
      ).rows,
    );
    return rows.map(rowToExecution);
  }

  async get(userId: string, projectId: string, executionId: string): Promise<RuntimeExecution> {
    await assertProjectAccess(userId, projectId);
    return this.getRowView(userId, executionId, projectId);
  }

  private async getRowView(userId: string, id: string, projectId: string): Promise<RuntimeExecution> {
    const rows = await withTenant<ExecutionRow[]>(userId, async (q) =>
      (
        await q.query<ExecutionRow>(
          `SELECT * FROM runtime_executions WHERE id = $1 AND project_id = $2`,
          [id, projectId],
        )
      ).rows,
    );
    if (!rows[0]) throw AppError.notFound('RuntimeExecution');
    return rowToExecution(rows[0]);
  }
}

export const runtimeExecutionsEngine = new RuntimeExecutionsEngine();
