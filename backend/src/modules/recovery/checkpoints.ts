/**
 * CodeConClave — task checkpoints (Stage 26E).
 * Explicit, durable time-travel snapshots taken on demand (before pause, before
 * branching, or at any moment the user wants a safe point). A checkpoint
 * captures: task state, plan state, execution metadata (attempts, steps,
 * in-flight agent run), and approval state — enough to restore or fork from.
 * Secret material is never copied: only references (ids) and non-secret rows.
 */
import { pool, queryMany, queryOne } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, RecoveryEventType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { getTask, listAttempts, listSteps, type TaskRow } from '../execution/tasks.js';
import { getPlan } from '../execution/planner.js';
import { recordRecoveryHistory } from './history.js';

export interface CheckpointRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  owner_id: string;
  label: string | null;
  reason: string | null;
  stage_index: number;
  task_state: Record<string, unknown>;
  plan_state: Record<string, unknown> | null;
  execution_metadata: Record<string, unknown>;
  approval_state: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateCheckpointInput {
  label?: string;
  reason?: string;
  attemptId?: string;
}

/** Snapshot of approval state for a task (or null when no approval exists). */
async function captureApprovalState(task: TaskRow): Promise<Record<string, unknown> | null> {
  if (!task.approval_id) return null;
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM approvals WHERE id = $1', [task.approval_id]);
  if (!row) return { approval_id: task.approval_id };
  return { approval_id: task.approval_id, ...row };
}

/** Capture the latest attempt checkpoint (stageIndex + completed run ids). */
async function captureAttemptCheckpoint(taskId: string, attemptId?: string): Promise<{ stageIndex: number; runIdsByOrder: Record<string, string>; checkpointedAt: Date | null }> {
  const attempts = await listAttempts(taskId);
  const target = attemptId ? attempts.find((a) => a.id === attemptId) ?? attempts[attempts.length - 1] : attempts[attempts.length - 1];
  if (!target) return { stageIndex: 0, runIdsByOrder: {}, checkpointedAt: null };
  const row = await queryOne<{ checkpoint: unknown; checkpointed_at: Date | null }>(
    'SELECT checkpoint, checkpointed_at FROM task_attempts WHERE id = $1',
    [target.id],
  );
  const raw = row?.checkpoint;
  if (!raw || typeof raw !== 'object') return { stageIndex: 0, runIdsByOrder: {}, checkpointedAt: null };
  const cp = raw as { stageIndex?: unknown; runIdsByOrder?: unknown };
  const runIdsByOrder: Record<string, string> = {};
  if (cp.runIdsByOrder && typeof cp.runIdsByOrder === 'object') {
    for (const [k, v] of Object.entries(cp.runIdsByOrder)) {
      if (typeof v === 'string') runIdsByOrder[k] = v;
    }
  }
  return {
    stageIndex: typeof cp.stageIndex === 'number' ? cp.stageIndex : 0,
    runIdsByOrder,
    checkpointedAt: row?.checkpointed_at ?? null,
  };
}

/**
 * Create a durable checkpoint for a task. Returns the stored snapshot.
 * The checkpoint row is immutable after creation.
 */
export async function createCheckpoint(userId: string, taskId: string, input: CreateCheckpointInput = {}): Promise<CheckpointRow> {
  const task = await getTask(userId, taskId);
  const attempts = await listAttempts(taskId);
  const steps = await listSteps(taskId);
  const plan = await getPlan(taskId);
  const attemptCp = await captureAttemptCheckpoint(taskId, input.attemptId);
  const approval = await captureApprovalState(task);

  const id = newId(PREFIX.TASK_CHECKPOINT);
  const taskState: Record<string, unknown> = { ...task };
  const planState = plan
    ? { goal: plan.goal, status: plan.status, entries: plan.entries }
    : null;
  const executionMetadata: Record<string, unknown> = {
    attempts: attempts.map((a) => ({
      id: a.id,
      attempt_number: a.attempt_number,
      started_at: a.started_at,
      finished_at: a.finished_at,
      result: a.result,
      error_code: a.error_code,
      output_summary: a.output_summary,
    })),
    steps: steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      status: s.status,
      started_at: s.started_at,
      completed_at: s.completed_at,
      error_code: s.error_code,
    })),
    agent_run_id: task.agent_run_id,
    stage_index: attemptCp.stageIndex,
    run_ids_by_order: attemptCp.runIdsByOrder,
  };
  await pool.query(
    `INSERT INTO task_checkpoints (id, task_id, attempt_id, owner_id, label, reason, stage_index, task_state, plan_state, execution_metadata, approval_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
    [
      id,
      taskId,
      input.attemptId ?? null,
      userId,
      input.label ?? null,
      input.reason ?? null,
      attemptCp.stageIndex,
      JSON.stringify(taskState),
      JSON.stringify(planState),
      JSON.stringify(executionMetadata),
      JSON.stringify(approval),
    ],
  );
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.CHECKPOINTED, {
    checkpointId: id,
    label: input.label ?? null,
    stageIndex: attemptCp.stageIndex,
  });
  await recordAudit({
    action: AuditAction.TASK_CHECKPOINTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { checkpointId: id, label: input.label ?? null, stageIndex: attemptCp.stageIndex },
  });
  return getCheckpoint(userId, id);
}

/** Tenant-scoped checkpoint lookup. */
export async function getCheckpoint(userId: string, checkpointId: string): Promise<CheckpointRow> {
  const rows = await queryMany<CheckpointRow>(
    'SELECT * FROM task_checkpoints WHERE id = $1 AND owner_id = $2',
    [checkpointId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Checkpoint');
  return rows[0];
}

/** All checkpoints for a task (newest first). */
export async function listCheckpoints(userId: string, taskId: string): Promise<CheckpointRow[]> {
  return queryMany<CheckpointRow>(
    'SELECT * FROM task_checkpoints WHERE task_id = $1 AND owner_id = $2 ORDER BY created_at DESC',
    [taskId, userId],
  );
}