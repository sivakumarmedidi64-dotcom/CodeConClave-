/**
 * CodeConClave — time travel (Stage 26E).
 * Pause / checkpoint / rewind / branch / modify-future-steps / resume.
 *
 * Semantics (honest, evidence-backed):
 *  - Pause: cancel the in-flight agent run (if any), mark the task PAUSED and
 *    exclude it from the queue (paused_at IS NULL gate in claimNextTask).
 *  - Resume: clear the pause and return the task to CREATED so the queue
 *    re-claims it; the orchestrator continues from the latest attempt
 *    checkpoint (Phase 16 machinery) — never silently restarts.
 *  - Rewind: restore a checkpoint by creating a NEW branch task that starts
 *    from the checkpointed state. The original task and its history are
 *    IMMUTABLE — we never mutate the past. Rewind is blocked when an
 *    irreversible action was recorded after the checkpoint (we never claim
 *    undo where undo does not exist).
 *  - Branch: fork from a checkpoint (or the current state) into a new task.
 *  - Modify future steps: re-persist the plan entries of a task.
 */
import { pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, RecoveryEventType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import {
  createTask, getTask, getTaskInternal, type TaskRow,
} from '../execution/tasks.js';
import { getPlan, persistPlan, type PlanEntryInput } from '../execution/planner.js';
import { createCheckpoint, getCheckpoint, type CheckpointRow } from './checkpoints.js';
import { recordRecoveryHistory } from './history.js';
import { irreversibleAfter } from './irreversible.js';

export interface PauseInput {
  reason?: string;
}

export interface ResumeInput {
  reason?: string;
  /** Replace the plan entries of the remaining work before resuming. */
  modifySteps?: { entries: PlanEntryInput[] };
}

export interface ModifyStepsInput {
  entries: PlanEntryInput[];
  reason?: string;
}

export interface BranchInput {
  checkpointId?: string;
  label?: string;
  reason?: string;
}

export interface RewindInput {
  checkpointId: string;
  reason?: string;
}

/** Pause a task: cancel in-flight agent work, then exclude from the queue. */
export async function pauseTask(userId: string, taskId: string, input: PauseInput = {}): Promise<TaskRow> {
  const task = await getTask(userId, taskId);
  if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(task.status)) {
    throw AppError.conflict('task_not_pausable', `Task ${task.status.toLowerCase()} cannot be paused`);
  }
  if (task.status === 'PAUSED') {
    throw AppError.conflict('task_already_paused', 'Task is already paused');
  }
  if (task.agent_run_id) {
    try {
      const { cancelRun, agentTaskChanged } = await import('../agents/service.js');
      await cancelRun(userId, task.agent_run_id);
      await agentTaskChanged(taskId);
    } catch {
      /* agent cancellation is best-effort; pause still proceeds */
    }
  }
  await pool.query(
    `UPDATE tasks SET status = 'PAUSED', paused_at = now(), paused_by = $2, paused_reason = $3, updated_at = now() WHERE id = $1`,
    [taskId, userId, input.reason ?? null],
  );
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.PAUSED, { reason: input.reason ?? null }, userId);
  await recordAudit({
    action: AuditAction.TASK_PAUSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { reason: input.reason ?? null },
  });
  return getTask(userId, taskId);
}

/** Resume a paused task: apply any step modifications, then re-enqueue. */
export async function resumeTask(userId: string, taskId: string, input: ResumeInput = {}): Promise<TaskRow> {
  const task = await getTask(userId, taskId);
  if (task.status !== 'PAUSED') {
    throw AppError.conflict('task_not_resumable', `Task ${task.status.toLowerCase()} is not paused`);
  }
  if (input.modifySteps?.entries?.length) {
    await applyFutureSteps(userId, taskId, { entries: input.modifySteps.entries, reason: input.reason ?? 'modified before resume' });
  }
  await pool.query(
    `UPDATE tasks
        SET status = 'CREATED', paused_at = NULL, paused_by = NULL, paused_reason = NULL,
            recovery_status = 'RECOVERED', updated_at = now()
      WHERE id = $1`,
    [taskId],
  );
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.RESUMED, { reason: input.reason ?? null, modified: Boolean(input.modifySteps?.entries?.length) }, userId);
  await recordAudit({
    action: AuditAction.TASK_RESUMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { reason: input.reason ?? null, modified: Boolean(input.modifySteps?.entries?.length) },
  });
  return getTask(userId, taskId);
}

/** Replace the plan entries of the remaining work (future steps). */
export async function modifyFutureSteps(userId: string, taskId: string, input: ModifyStepsInput): Promise<void> {
  const task = await getTask(userId, taskId);
  if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(task.status)) {
    throw AppError.conflict('task_not_modifiable', `Task ${task.status.toLowerCase()} cannot be modified`);
  }
  await applyFutureSteps(userId, taskId, input);
}

async function applyFutureSteps(userId: string, taskId: string, input: ModifyStepsInput): Promise<void> {
  const task = await getTaskInternal(taskId);
  const plan = await getPlan(taskId);
  await persistPlan({
    taskId,
    goal: plan?.goal ?? task.title,
    entries: input.entries,
    riskLevel: (task.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL') ?? undefined,
  });
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.MODIFIED, {
    reason: input.reason ?? null,
    entryCount: input.entries.length,
  }, userId);
  await recordAudit({
    action: AuditAction.TASK_PLAN_MODIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { reason: input.reason ?? null, entryCount: input.entries.length },
  });
}

/** Fork a task from a checkpoint (or current state) into a new task. */
export async function branchTask(userId: string, taskId: string, input: BranchInput = {}): Promise<{ branchTask: TaskRow; branchId: string }> {
  const task = await getTask(userId, taskId);
  let checkpoint: CheckpointRow;
  if (input.checkpointId) {
    checkpoint = await getCheckpoint(userId, input.checkpointId);
    if (checkpoint.task_id !== taskId) throw AppError.notFound('Checkpoint');
  } else {
    checkpoint = await createCheckpoint(userId, taskId, { label: 'pre-branch', reason: input.reason ?? 'branch checkpoint' });
  }
  const { branchTask: forked, branchId } = await forkFromCheckpoint(userId, taskId, checkpoint, input.label ?? 'branch');
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.BRANCHED, {
    checkpointId: checkpoint.id,
    branchedTaskId: forked.id,
    label: input.label ?? null,
  }, userId);
  await recordAudit({
    action: AuditAction.TASK_BRANCHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { checkpointId: checkpoint.id, branchedTaskId: forked.id, label: input.label ?? null },
  });
  return { branchTask: forked, branchId };
}

/**
 * Rewind to a checkpoint: blocked if any irreversible action was recorded
 * after the checkpoint — we never claim undo where undo does not exist.
 * Otherwise creates a NEW branch task from the checkpointed state; the
 * original task and its history stay immutable.
 */
export async function rewindTask(userId: string, taskId: string, input: RewindInput): Promise<{ branchTask: TaskRow; branchId: string }> {
  const task = await getTask(userId, taskId);
  const checkpoint = await getCheckpoint(userId, input.checkpointId);
  if (checkpoint.task_id !== taskId) throw AppError.notFound('Checkpoint');
  const blockers = await irreversibleAfter(userId, taskId, new Date(checkpoint.created_at));
  if (blockers.length > 0) {
    throw AppError.conflict(
      'irreversible_action_blocks_rewind',
      `Cannot rewind: ${blockers.length} irreversible action(s) recorded after this checkpoint cannot be undone`,
    );
  }
  if (task.agent_run_id) {
    try {
      const { cancelRun, agentTaskChanged } = await import('../agents/service.js');
      await cancelRun(userId, task.agent_run_id);
      await agentTaskChanged(taskId);
    } catch {
      /* best-effort; the branch proceeds */
    }
  }
  const { branchTask: forked, branchId } = await forkFromCheckpoint(userId, taskId, checkpoint, 'rewind');
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.REWOUND, {
    checkpointId: checkpoint.id,
    branchedTaskId: forked.id,
    reason: input.reason ?? null,
  }, userId);
  await recordAudit({
    action: AuditAction.TASK_REWOUND,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { checkpointId: checkpoint.id, branchedTaskId: forked.id, reason: input.reason ?? null },
  });
  return { branchTask: forked, branchId };
}

/**
 * Create the branch task from a checkpoint:
 *  1. New task row (CREATED, claimable by the queue).
 *  2. Plan copied from the checkpoint (goal + entries).
 *  3. Attempt checkpoint copied so the orchestrator resumes from the
 *     checkpointed stage instead of regenerating from scratch.
 *  4. task_branches link row (source → branch).
 */
async function forkFromCheckpoint(
  userId: string,
  taskId: string,
  checkpoint: CheckpointRow,
  label: string,
): Promise<{ branchTask: TaskRow; branchId: string }> {
  const task = await getTaskInternal(taskId);
  const forked = await createTask({
    userId,
    projectId: task.project_id,
    conversationId: task.conversation_id,
    title: `${task.title} (${label})`,
    description: task.description,
    riskLevel: task.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    executionMode: task.execution_mode,
    coworkerPipeline: task.coworker_pipeline as unknown[] | undefined,
    maxAttempts: task.max_attempts,
    priority: task.priority,
  });
  const planState = checkpoint.plan_state;
  if (planState && Array.isArray((planState as { entries?: unknown }).entries) && (planState as { entries: unknown[] }).entries.length > 0) {
    await persistPlan({
      taskId: forked.id,
      goal: String((planState as { goal?: unknown }).goal ?? task.title),
      entries: (planState as { entries: PlanEntryInput[] }).entries,
      riskLevel: (planState as { risk_level?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }).risk_level ?? (task.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'),
    });
  }
  const meta = checkpoint.execution_metadata as { stage_index?: number; run_ids_by_order?: Record<string, string> };
  if (typeof meta?.stage_index === 'number' && meta.stage_index > 0) {
    await pool.query(
      `INSERT INTO task_attempts (id, task_id, attempt_number, started_at, checkpoint, checkpointed_at)
       VALUES ($1,$2,1, now(), $3::jsonb, now())`,
      [newId(PREFIX.TASK_ATTEMPT), forked.id, JSON.stringify({ stageIndex: meta.stage_index, runIdsByOrder: meta.run_ids_by_order ?? {} })],
    );
  }
  const branchId = newId(PREFIX.TASK_BRANCH);
  await pool.query(
    `INSERT INTO task_branches (id, source_task_id, checkpoint_id, branched_task_id, owner_id, label, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [branchId, taskId, checkpoint.id, forked.id, userId, label, null],
  );
  return { branchTask: await getTask(userId, forked.id), branchId };
}