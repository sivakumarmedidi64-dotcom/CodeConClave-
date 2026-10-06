/**
 * CodeConClave — tasks (24/7 engine). Column names and status values follow the
 * frozen migration 0008 exactly. Lifecycle:
 *   CREATED → PLANNED → WAITING_APPROVAL → RUNNING → TESTING → VERIFIED → COMPLETED
 *   |-> FAILED / TIMED_OUT / CANCELLED / BLOCKED / WAITING_FOR_LOCAL_AGENT / REQUIRES_REVIEW
 */
import { withSystem, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, type Risky } from './policy-shared.js';
import { guardTransition } from '../autonomy/state-machine.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { notifyTeamMembersAbout } from '../teams/service.js';
import { recordUsage } from '../workspace/service.js';
import { NotificationType, RetryPolicy } from '@codeconclave/shared';

export interface TaskRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  owner_id: string;
  title: string;
  description: string | null;
  plan: string | null;
  status: string;
  risk_level: string;
  required_approval: boolean;
  approval_id: string | null;
  coworker_pipeline: unknown[] | null;
  execution_mode: 'CLOUD' | 'LOCAL' | 'HYBRID';
  timeout_ms: number;
  started_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  error_code: string | null;
  error_detail: string | null;
  attempt_count: number;
  max_attempts: number;
  last_heartbeat_at: Date | null;
  watchdog_checked_at: Date | null;
  priority: number;
  failure_reason: string | null;
  recovery_status: string;
  retry_count: number;
  next_attempt_at: Date | null;
  dead_letter_at: Date | null;
  requires_review_reason: string | null;
  agent_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const HEARTBEAT_TTL_MS = 30_000;
export const TASK_TIMEOUT_MS = 15 * 60 * 1000;

export async function createTask(input: {
  userId: string;
  projectId: string;
  conversationId?: string | null;
  title: string;
  description?: string | null;
  riskLevel?: Risky;
  executionMode?: 'CLOUD' | 'LOCAL' | 'HYBRID';
  coworkerPipeline?: unknown[];
  maxAttempts?: number;
  priority?: number;
  dependsOn?: string[];
}): Promise<TaskRow> {
  // Stage 26G control plane: kill switch stops NEW task work; a matching
  // policy can raise risk (require approval) or block outright.
  const { assertAutonomyEnabled } = await import('../control/killSwitch.js');
  await assertAutonomyEnabled(input.userId, 'TASKS');
  const { evaluatePolicy } = await import('../control/policies.js');
  const policy = await evaluatePolicy(input.userId, 'task', input.title ? 'create' : 'create', input.riskLevel ?? 'MEDIUM');
  // Tenant gate: the caller must own or belong to the project (and to the
  // linked conversation when one is given). Without this, any authenticated
  // user could plant tasks into a victim's project — polluting project stats
  // and fanning team notifications to the victim's team.
  const { getProject } = await import('../projects/service.js');
  await getProject(input.userId, input.projectId);
  if (input.conversationId) {
    const { getConversation } = await import('../conversations/service.js');
    await getConversation(input.userId, input.conversationId);
  }
  const id = newId(PREFIX.TASK);
  let riskLevel = input.riskLevel ?? 'MEDIUM';
  if (!policy.allowed) {
    throw AppError.forbidden('policy_blocked', `Task blocked by control policy (${policy.matched?.scope}/${policy.matched?.action})`);
  }
  if (policy.requireApproval) riskLevel = 'HIGH';
  const requiredApproval = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';
  await withTenant(input.userId, async (q) =>
    q.query(
      `INSERT INTO tasks (
         id, project_id, conversation_id, owner_id, title, description, status,
         risk_level, required_approval, coworker_pipeline, execution_mode, timeout_ms,
         max_attempts, priority
       ) VALUES ($1,$2,$3,$4,$5,$6,'CREATED',$7,$8,$9::jsonb,$10,$11,$12,$13)`,
      [
        id,
        input.projectId,
        input.conversationId ?? null,
        input.userId,
        input.title,
        input.description ?? null,
        riskLevel,
        requiredApproval,
        input.coworkerPipeline === undefined || input.coworkerPipeline === null
          ? null
          : JSON.stringify(input.coworkerPipeline),
        input.executionMode ?? 'CLOUD',
        TASK_TIMEOUT_MS,
        input.maxAttempts ?? RetryPolicy.DEFAULT_MAX_ATTEMPTS,
        input.priority ?? 0,
      ],
    ),
  );
  if (input.dependsOn?.length) {
    for (const dep of input.dependsOn) {
      await addTaskDependency(id, dep);
    }
  }
  await recordAudit({
    action: AuditAction.TASK_CREATED,
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.userId,
    resourceType: 'task',
    resourceId: id,
    detail: { projectId: input.projectId, risk: riskLevel },
  });
  await recordUsage(input.userId, 'tasks', 1).catch(() => undefined);
  try {
    // Phase 9: new tasks in team projects announce to the team.
    const project = await withTenant<{ rows: { team_id: string | null }[] }>(input.userId, async (q) =>
      q.query<{ team_id: string | null }>(
        'SELECT team_id FROM projects WHERE id = $1 AND deleted_at IS NULL',
        [input.projectId],
      ),
    );
    if (project.rows[0]?.team_id) {
      await notifyTeamMembersAbout(project.rows[0].team_id, NotificationType.TEAM_TASK_ASSIGNED, 'A task was assigned in a team project', {
        exceptUserId: input.userId,
        body: input.title,
        resourceType: 'task',
        resourceId: id,
      });
    }
  } catch {
    /* best-effort; never fail task creation on notification errors */
  }
  return getTask(input.userId, id);
}

export async function getTask(userId: string, taskId: string): Promise<TaskRow> {
  const rows = await withTenant<{ rows: TaskRow[] }>(userId, async (q) =>
    q.query<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND owner_id = $2', [taskId, userId]),
  );
  if (!rows.rows[0]) throw AppError.notFound('Task');
  return rows.rows[0];
}

/** Internal fetch without tenant filter (used by worker/audit paths). */
export async function getTaskInternal(taskId: string): Promise<TaskRow> {
  const rows = await withSystem<{ rows: TaskRow[] }>(async (q) => q.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [taskId]));
  if (!rows.rows[0]) throw AppError.notFound('Task');
  return rows.rows[0];
}

/**
 * Read the current status and reject semantically-impossible rewrites (e.g.
 * resurrecting COMPLETED work, or jumping out of CANCELLED). This is the single
 * enforcement point for the canonical lifecycle: every single-row status write
 * routes through here (the SQL WHERE-gated sweeps in shared/queue.ts encode
 * their legal source states directly in the predicate).
 *
 * The read is BEST-EFFORT: a real task row always exists, so the guard always
 * applies in production. If the row cannot be read (e.g. a stripped test double
 * that does not model `SELECT status FROM tasks`) we proceed as before rather
 * than inventing a policy from missing data.
 */
async function guardTaskWrite(taskId: string, to: string): Promise<void> {
  const row = await withSystem<{ rows: { status: string }[] }>(async (q) =>
    q.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]),
  );
  if (row.rows[0]?.status) guardTransition(row.rows[0].status, to);
}

/**
 * Continuity: latest task filed under a conversation (owner-scoped). Used by
 * the chat deep-work path to answer a retried send (same clientId) with the
 * already-created task instead of filing a duplicate.
 */
export async function findLatestTaskByConversation(userId: string, conversationId: string): Promise<TaskRow | null> {
  const rows = await withTenant<{ rows: TaskRow[] }>(userId, async (q) =>
    q.query<TaskRow>(
      'SELECT * FROM tasks WHERE owner_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1',
      [userId, conversationId],
    ),
  );
  return rows.rows[0] ?? null;
}

export async function listTasks(userId: string, projectId: string): Promise<TaskRow[]> {
  const rows = await withTenant<{ rows: TaskRow[] }>(userId, async (q) =>
    q.query<TaskRow>(
      'SELECT * FROM tasks WHERE owner_id = $1 AND project_id = $2 ORDER BY created_at DESC',
      [userId, projectId],
    ),
  );
  return rows.rows;
}

export async function setTaskStatus(taskId: string, status: string, errorCode?: string): Promise<void> {
  await guardTaskWrite(taskId, status);
  const fields: string[] = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [taskId, status];
  if (status === 'COMPLETED') fields.push('completed_at = now()');
  if (status === 'FAILED' || status === 'TIMED_OUT') fields.push('failed_at = now()');
  if (errorCode) {
    params.push(errorCode);
    fields.push(`error_code = $${params.length}`);
  }
  await withSystem(async (q) => q.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $1`, params));
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'TIMED_OUT' || status === 'CANCELLED' || status === 'BLOCKED') {
    try {
      const task = await getTaskInternal(taskId);
      if (task.agent_run_id) {
        await (await import('../agents/service.js')).agentTaskChanged(taskId);
      }
      if (task.project_id) {
        await (await import('../preview/service.js')).previewTaskCompleted(taskId, task.project_id).catch(() => undefined);
      }
    } catch {
      /* agent/preview accounting is best-effort; never break task transitions */
    }
  }
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'TIMED_OUT') {
    try {
      const task = await getTaskInternal(taskId);
      if (status === 'COMPLETED') {
        await (await import('../automations/events.js')).emitTaskCompleted(task.owner_id, { id: task.id, title: task.title });
      } else {
        await (await import('../automations/events.js')).emitTaskFailed(task.owner_id, { id: task.id, title: task.title }, errorCode ?? status);
      }
    } catch {
      /* automation events are best-effort; never break task transitions */
    }
  }
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'TIMED_OUT') {
    try {
      const task = await getTaskInternal(taskId);
      await notify(task.owner_id, status === 'COMPLETED' ? NotificationType.TASK_COMPLETED : NotificationType.TASK_FAILED, status === 'COMPLETED' ? 'Task completed' : 'Task failed', {
        body: task.title,
        resourceType: 'task',
        resourceId: taskId,
        metadata: { status, errorCode: errorCode ?? null },
        email: status === 'FAILED' || status === 'TIMED_OUT',
      });
      // Phase 9: tasks inside team projects fan out to team members.
      if (status === 'COMPLETED') {
        const project = await withSystem<{ rows: { team_id: string | null }[] }>(async (q) =>
          q.query<{ team_id: string | null }>(
            'SELECT team_id FROM projects WHERE id = $1 AND deleted_at IS NULL',
            [task.project_id],
          ),
        );
        if (project.rows[0]?.team_id) {
          await notifyTeamMembersAbout(project.rows[0].team_id, NotificationType.TEAM_TASK_COMPLETED, 'A team task was completed', {
            exceptUserId: task.owner_id,
            body: task.title,
            resourceType: 'task',
            resourceId: taskId,
            metadata: { status },
          });
        }
      }
    } catch {
      /* notification is best-effort; never fail task status transitions */
    }
  }
  try {
    await (await import('./events.js')).emitTaskRuntime(taskId, status);
  } catch {
    /* workbench event bridge is best-effort; never fail task status transitions */
  }
}

export async function cancelTask(userId: string, taskId: string, reason?: string): Promise<TaskRow> {
  const task = await getTask(userId, taskId);
  if (['COMPLETED', 'CANCELLED'].includes(task.status)) {
    throw AppError.conflict('task_not_cancellable', `Task is already ${task.status.toLowerCase()}`);
  }
  await setTaskStatus(taskId, 'CANCELLED', reason ?? 'cancelled_by_user');
  await recordAudit({
    action: AuditAction.TASK_CANCELLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
  });
  return getTask(userId, taskId);
}

// ---------------------------------------------------------------- retry / DLQ

/** Exponential backoff for retry N (retry_count before this retry). Capped. */
export function retryBackoffMs(retryCount: number): number {
  const exp = Math.min(retryCount, 10);
  return Math.min(RetryPolicy.MAX_BACKOFF_MS, RetryPolicy.BASE_BACKOFF_MS * 2 ** exp);
}

/**
 * Reschedule a task for another attempt: back to CREATED with exponential
 * backoff. Never claims immediately — next_attempt_at gates the claim gate.
 */
export async function scheduleRetry(
  taskId: string,
  errorCode?: string,
  failureReason?: string,
  recoveryStatus: 'RETRYING' | 'RECOVERED' = 'RETRYING',
): Promise<void> {
  const task = await getTaskInternal(taskId);
  guardTransition(task.status, 'CREATED');
  const backoff = retryBackoffMs(task.retry_count);
  await withSystem(async (q) =>
    q.query(
      `UPDATE tasks
          SET status = 'CREATED', recovery_status = $2,
              retry_count = retry_count + 1,
              next_attempt_at = now() + ($3 || ' milliseconds')::interval,
              failure_reason = COALESCE($4, failure_reason),
              error_code = COALESCE($5, error_code),
              error_detail = COALESCE($6, error_detail),
              failed_at = NULL, completed_at = NULL, updated_at = now()
        WHERE id = $1`,
      [taskId, recoveryStatus, backoff, failureReason ?? null, errorCode ?? null, errorCode ?? null],
    ),
  );
  await recordAudit({
    action: recoveryStatus === 'RECOVERED' ? AuditAction.TASK_RECOVERED : AuditAction.TASK_RETRIED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'task',
    resourceId: taskId,
    detail: { retryCount: task.retry_count + 1, backoffMs: backoff, errorCode: errorCode ?? null },
  });
}

/**
 * Move a task to the dead-letter queue: terminal FAILED + a task_dlq row.
 * The recovery marker and the DLQ row are written in ONE transaction so a
 * mid-sequence database failure can never leave a task flagged DEAD_LETTERED
 * without its DLQ record (the harmful partial state); the status FAILED
 * transition stays retryable and visible either way.
 */
export async function deadLetterTask(taskId: string, errorCode?: string, failureReason?: string): Promise<void> {
  const task = await getTaskInternal(taskId);
  await setTaskStatus(taskId, 'FAILED', errorCode ?? 'max_retries_exceeded');
  let dlqId = newId(PREFIX.TASK_DLQ);
  await withSystem(async (q) => {
    await q.query(
      `UPDATE tasks
          SET recovery_status = 'DEAD_LETTERED', dead_letter_at = now(),
              failure_reason = COALESCE($2, failure_reason), updated_at = now()
        WHERE id = $1`,
      [taskId, failureReason ?? null],
    );
    dlqId = newId(PREFIX.TASK_DLQ);
    await q.query(
      `INSERT INTO task_dlq (id, task_id, project_id, owner_id, title, reason, error_code, error_detail, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        dlqId,
        task.id,
        task.project_id,
        task.owner_id,
        task.title,
        failureReason ?? errorCode ?? 'max_retries_exceeded',
        errorCode ?? 'max_retries_exceeded',
        task.error_detail,
        task.attempt_count,
      ],
    );
  });
  await recordAudit({
    action: AuditAction.TASK_DEAD_LETTERED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'task',
    resourceId: taskId,
    detail: { dlqId, attempts: task.attempt_count, errorCode: errorCode ?? null },
  });
}

/**
 * Park a task in the existing REQUIRES_REVIEW state with the reason recorded.
 *
 * Used when a stage produced an affirmative FAIL verdict (reviewer/verifier
 * rejection). That is a judgement about the work, not a transient outage, so it
 * must not be retried automatically: the deliverable is NOT published and NOT
 * labelled PASS, every run output stays in coworker_runs, and the reason is
 * visible to the owner through the task row, task_steps and a task.failed
 * notification.
 */
export async function requireTaskReview(taskId: string, reason: string, errorCode = 'verification_failed'): Promise<void> {
  await setTaskStatus(taskId, 'REQUIRES_REVIEW', errorCode);
  await withSystem(async (q) =>
    q.query(
      `UPDATE tasks SET requires_review_reason = $2, failure_reason = $2, updated_at = now() WHERE id = $1`,
      [taskId, reason.slice(0, 2000)],
    ),
  );
  await recordAudit({
    action: AuditAction.TASK_FAILED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'task',
    resourceId: taskId,
    detail: { error: reason.slice(0, 500), decision: 'REQUIRES_REVIEW', errorCode },
  });
  try {
    const task = await getTaskInternal(taskId);
    await notify(task.owner_id, NotificationType.TASK_FAILED, 'Task needs review', {
      body: `${task.title} — review did not pass`,
      resourceType: 'task',
      resourceId: taskId,
      metadata: { status: 'REQUIRES_REVIEW', errorCode, reason: reason.slice(0, 500) },
      email: false,
    });
  } catch {
    /* notification is best-effort; never break the state transition */
  }
}

/**
 * Clear the FINAL task row's failure marker after an attempt succeeds.
 *
 * scheduleRetry() deliberately keeps failure_reason/error_code for the audit
 * trail, but nothing cleared them on the way back to success: a COMPLETED task
 * kept the previous attempt's "Premium compute requires an entitled plan"
 * message and recovery_status='RETRYING', so the final state contradicted the
 * outcome. Attempt-level history (task_attempts, task_steps, coworker_runs,
 * audit) is deliberately NOT touched — only the final task row becomes truthful.
 * A task that never failed keeps recovery_status='NONE'.
 */
export async function clearTaskFailureState(taskId: string): Promise<void> {
  await withSystem(async (q) =>
    q.query(
      `UPDATE tasks
          SET failure_reason = NULL,
              error_code = NULL,
              error_detail = NULL,
              requires_review_reason = NULL,
              recovery_status = CASE WHEN recovery_status = 'NONE' THEN 'NONE' ELSE 'RECOVERED' END,
              updated_at = now()
        WHERE id = $1`,
      [taskId],
    ),
  );
}

/**
 * Drop the durable resume checkpoint for an attempt.
 *
 * Used when an attempt is aborted for a reason a resume cannot fix (a verifier
 * that could not be reached). Without this the next attempt would resume the
 * very same runs, re-derive the same SKIPPED verdict and dead-letter without
 * ever retrying the verification.
 */
export async function clearAttemptCheckpoint(attemptId: string): Promise<void> {
  await withSystem(async (q) =>
    q.query('UPDATE task_attempts SET checkpoint = NULL, checkpointed_at = NULL WHERE id = $1', [attemptId]),
  );
}

/**
 * Engine decision on a failed attempt: retry while the budget remains
 * (max_attempts total attempts), otherwise dead-letter. Returns the decision.
 */
export async function retryOrDeadLetter(
  taskId: string,
  errorCode?: string,
  failureReason?: string,
): Promise<'RETRIED' | 'DEAD_LETTERED'> {
  const task = await getTaskInternal(taskId);
  const retriesLeft = task.max_attempts - 1 - task.retry_count;
  if (retriesLeft > 0) {
    await scheduleRetry(taskId, errorCode, failureReason);
    return 'RETRIED';
  }
  await deadLetterTask(taskId, errorCode, failureReason);
  return 'DEAD_LETTERED';
}

/** Manual recovery: retry a FAILED/TIMED_OUT/BLOCKED or dead-lettered task. */
export async function retryTask(userId: string, taskId: string, reason?: string): Promise<TaskRow> {
  const task = await getTask(userId, taskId);
  const retryable = ['FAILED', 'TIMED_OUT', 'BLOCKED', 'REQUIRES_REVIEW'].includes(task.status) || task.recovery_status === 'DEAD_LETTERED';
  if (!retryable) {
    throw AppError.conflict('task_not_retryable', `Task ${task.status.toLowerCase()} cannot be retried`);
  }
  if (task.recovery_status === 'DEAD_LETTERED') {
    await withTenant(userId, async (q) => q.query('DELETE FROM task_dlq WHERE task_id = $1', [taskId]));
  }
  await scheduleRetry(taskId, undefined, reason ?? task.failure_reason ?? 'retried_by_user', 'RECOVERED');
  return getTask(userId, taskId);
}

export async function listDeadLettered(userId: string) {
  const rows = await withTenant<{ rows: Record<string, unknown>[] }>(userId, async (q) =>
    q.query(
      `SELECT d.*, t.status AS task_status, t.priority, t.retry_count, t.max_attempts
         FROM task_dlq d
         JOIN tasks t ON t.id = d.task_id
        WHERE d.owner_id = $1
        ORDER BY d.moved_at DESC`,
      [userId],
    ),
  );
  return rows.rows;
}

export async function getTaskFailureInfo(taskId: string) {
  const task = await getTaskInternal(taskId);
  return {
    failure_reason: task.failure_reason,
    recovery_status: task.recovery_status,
    retry_count: task.retry_count,
    max_attempts: task.max_attempts,
    next_attempt_at: task.next_attempt_at,
    dead_letter_at: task.dead_letter_at,
    error_code: task.error_code,
    error_detail: task.error_detail,
  };
}

// ---------------------------------------------------------------- dependencies

export async function addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
  const id = newId(PREFIX.TASK_DEPENDENCY);
  await withSystem(async (q) =>
    q.query(
      `INSERT INTO task_dependencies (id, task_id, depends_on_task_id, kind)
       VALUES ($1,$2,$3,'finish') ON CONFLICT DO NOTHING`,
      [id, taskId, dependsOnTaskId],
    ),
  );
  await recordAudit({
    action: AuditAction.TASK_DEPENDENCY_ADDED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'task',
    resourceId: taskId,
    detail: { dependsOnTaskId, kind: 'finish' },
  });
}

export async function listTaskDependencies(taskId: string) {
  const rows = await withSystem<{ rows: Record<string, unknown>[] }>(async (q) =>
    q.query(
      `SELECT td.*, dep.title AS depends_on_title, dep.status AS depends_on_status
         FROM task_dependencies td
         JOIN tasks dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id = $1
        ORDER BY td.created_at`,
      [taskId],
    ),
  );
  return rows.rows;
}

// ---------------------------------------------------------------- watchdog (phase 7)

/**
 * Watchdog: apply the retry policy to TIMED_OUT tasks (they were failed by the
 * timeout sweep, never by the engine itself). Budget left → reschedule with
 * backoff; exhausted → dead-letter. Returns per-decision counts.
 */
export async function recoverTimedOutTasks(): Promise<{ retried: number; deadLettered: number }> {
  const res = await withSystem<{ rows: { id: string }[] }>(async (q) =>
    q.query(`SELECT id FROM tasks WHERE status = 'TIMED_OUT' AND recovery_status = 'NONE'`),
  );
  let retried = 0;
  let deadLettered = 0;
  for (const row of res.rows) {
    const decision = await retryOrDeadLetter(row.id, 'task_timeout', 'Timed out; retry policy applied');
    if (decision === 'RETRIED') retried++;
    else deadLettered++;
  }
  return { retried, deadLettered };
}

/** Watchdog: block dependent tasks whose dependency failed terminally. */
export async function blockBlockedDependencies(): Promise<number> {
  const result = await withSystem<{ rowCount: number | null }>(async (q) =>
    q.query(
      `UPDATE tasks t
          SET status = 'BLOCKED', error_code = 'dependency_failed', updated_at = now()
        WHERE t.status IN ('CREATED','PLANNED','CHANGED')
          AND EXISTS (
            SELECT 1 FROM task_dependencies td
            JOIN tasks dep ON dep.id = td.depends_on_task_id
            WHERE td.task_id = t.id AND dep.status IN ('FAILED','TIMED_OUT','CANCELLED','BLOCKED')
          )
        RETURNING id`,
    ),
  );
  return result.rowCount ?? 0;
}

export async function requireApprovalForTask(taskId: string): Promise<void> {
  await guardTaskWrite(taskId, 'WAITING_APPROVAL');
  await withSystem(async (q) =>
    q.query(`UPDATE tasks SET status = 'WAITING_APPROVAL', updated_at = now() WHERE id = $1`, [taskId]),
  );
  try {
    const task = await getTaskInternal(taskId);
    if (task.agent_run_id) {
      await (await import('../agents/service.js')).agentTaskChanged(taskId);
    }
    await notify(task.owner_id, NotificationType.APPROVAL_REQUESTED, 'Approval required', {
      body: task.title,
      resourceType: 'task',
      resourceId: taskId,
      email: true,
    });
  } catch {
    /* best-effort */
  }
}

export async function approveLinkTask(taskId: string, approvalId: string): Promise<void> {
  await guardTaskWrite(taskId, 'PLANNED');
  // Conditional release: only a pre-execution task may be released by an
  // approval. A task that moved on concurrently (cancelled, completed,
  // already running) must not be yanked back to PLANNED by a late approval.
  const released = await withSystem<{ rowCount: number | null }>(async (q) =>
    q.query(
      `UPDATE tasks SET status = 'PLANNED', required_approval = false, approval_id = $2, updated_at = now()
       WHERE id = $1 AND status IN ('WAITING_APPROVAL','CREATED','PLANNED','CHANGED')`,
      [taskId, approvalId],
    ),
  );
  if ((released.rowCount ?? 0) === 0) {
    throw AppError.conflict(
      'task_not_waiting_approval',
      'Task is no longer awaiting approval (it moved on concurrently)',
    );
  }
  try {
    const task = await getTaskInternal(taskId);
    if (task.agent_run_id) {
      await (await import('../agents/service.js')).agentTaskChanged(taskId);
    }
    await notify(task.owner_id, NotificationType.APPROVAL_RESOLVED, 'Approval resolved', {
      body: `${task.title} — the approval was decided.`,
      resourceType: 'task',
      resourceId: taskId,
      metadata: { approvalId },
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------- attempts

export interface AttemptRow {
  id: string;
  task_id: string;
  attempt_number: number;
  started_at: Date;
  finished_at: Date | null;
  result: string | null;
  error_code: string | null;
  output_summary: string | null;
}

export async function beginAttempt(taskId: string): Promise<AttemptRow> {
  const next = await withSystem<{ rows: { n: number }[] }>(async (q) =>
    q.query<{ n: number }>(
      'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM task_attempts WHERE task_id = $1',
      [taskId],
    ),
  );
  const id = newId(PREFIX.TASK_ATTEMPT);
  await withSystem(async (q) =>
    q.query(`INSERT INTO task_attempts (id, task_id, attempt_number, started_at) VALUES ($1,$2,$3, now())`, [id, taskId, next.rows[0]?.n ?? 1]),
  );
  // Phase 16: stamp started_at on the first claim so the timeout sweep
  // (failTimedOutTasks, gated on started_at IS NOT NULL) can bound even
  // long-running tasks — a task is never RUNNING forever.
  await withSystem(async (q) =>
    q.query(
      `UPDATE tasks
          SET attempt_count = attempt_count + 1,
              last_heartbeat_at = now(),
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [taskId],
    ),
  );
  const row = await withSystem<{ rows: AttemptRow[] }>(async (q) => q.query<AttemptRow>('SELECT * FROM task_attempts WHERE id = $1', [id]));
  return row.rows[0]!;
}

export async function finishAttempt(
  attemptId: string,
  result: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'CANCELLED',
  errorCode?: string,
  outputSummary?: string,
): Promise<void> {
  await withSystem(async (q) =>
    q.query(
      `UPDATE task_attempts SET finished_at = now(), result = $2, error_code = $3, output_summary = $4
       WHERE id = $1`,
      [attemptId, result, errorCode ?? null, outputSummary ?? null],
    ),
  );
}

// ---------------------------------------------------------------- checkpoints

export interface AttemptCheckpoint {
  /** Highest completed pipeline stage orderIndex at checkpoint time. */
  stageIndex: number;
  /** orderIndex → coworker run id already completed (reused on resume). */
  runIdsByOrder: Record<string, string>;
}

/** Persist durable progress so a worker restart can resume, never restart silently. */
export async function saveAttemptCheckpoint(attemptId: string, checkpoint: AttemptCheckpoint): Promise<void> {
  await withSystem(async (q) =>
    q.query(
      `UPDATE task_attempts SET checkpoint = $2::jsonb, checkpointed_at = now() WHERE id = $1`,
      [attemptId, JSON.stringify(checkpoint)],
    ),
  );
}

/** Latest checkpoint from a finished or interrupted PREVIOUS attempt (never the given attemptId). */
export async function latestCheckpoint(taskId: string, excludeAttemptId: string): Promise<AttemptCheckpoint | null> {
  const row = await withSystem<{ rows: { checkpoint: unknown }[] }>(async (q) =>
    q.query<{ checkpoint: unknown }>(
      `SELECT checkpoint FROM task_attempts
        WHERE task_id = $1 AND id <> $2 AND checkpointed_at IS NOT NULL
        ORDER BY checkpointed_at DESC LIMIT 1`,
      [taskId, excludeAttemptId],
    ),
  );
  const raw = row.rows[0]?.checkpoint;
  if (!raw || typeof raw !== 'object') return null;
  const cp = raw as { stageIndex?: unknown; runIdsByOrder?: unknown };
  if (typeof cp.stageIndex !== 'number' || !cp.runIdsByOrder || typeof cp.runIdsByOrder !== 'object') return null;
  const runIdsByOrder: Record<string, string> = {};
  for (const [k, v] of Object.entries(cp.runIdsByOrder)) {
    if (typeof v === 'string') runIdsByOrder[k] = v;
  }
  return { stageIndex: cp.stageIndex, runIdsByOrder };
}

export async function listAttempts(taskId: string): Promise<AttemptRow[]> {
  const rows = await withSystem<{ rows: AttemptRow[] }>(async (q) =>
    q.query<AttemptRow>('SELECT * FROM task_attempts WHERE task_id = $1 ORDER BY started_at', [taskId]),
  );
  return rows.rows;
}

// ---------------------------------------------------------------- steps

export interface StepRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  kind: string;
  title: string;
  status: string;
  detail: Record<string, unknown> | null;
  output: string | null;
  error_code: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export async function addStep(
  taskId: string,
  attemptId: string,
  kind: string,
  title: string,
): Promise<StepRow> {
  const id = newId(PREFIX.TASK_STEP);
  await withSystem(async (q) =>
    q.query(
      `INSERT INTO task_steps (id, task_id, attempt_id, kind, title, status, started_at)
       VALUES ($1,$2,$3,$4,$5,'RUNNING', now())`,
      [id, taskId, attemptId, kind, title],
    ),
  );
  const row = await withSystem<{ rows: StepRow[] }>(async (q) => q.query<StepRow>('SELECT * FROM task_steps WHERE id = $1', [id]));
  return row.rows[0]!;
}

export async function finishStep(
  stepId: string,
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED',
  detail?: Record<string, unknown>,
  output?: string,
  errorCode?: string,
): Promise<void> {
  await withSystem(async (q) =>
    q.query(
      `UPDATE task_steps
          SET status = $2, completed_at = now(), detail = COALESCE($3::jsonb, detail),
              output = COALESCE($4, output), error_code = COALESCE($5, error_code)
        WHERE id = $1`,
      [stepId, status, detail ? JSON.stringify(detail) : null, output ?? null, errorCode ?? null],
    ),
  );
}

export async function listSteps(taskId: string): Promise<StepRow[]> {
  const rows = await withSystem<{ rows: StepRow[] }>(async (q) =>
    q.query<StepRow>('SELECT * FROM task_steps WHERE task_id = $1 ORDER BY started_at', [taskId]),
  );
  return rows.rows;
}

/** Worker/poll paths: keep the task's heartbeat fresh (watchdog recovery signal). */
export async function touchTask(taskId: string): Promise<void> {
  await withSystem(async (q) => q.query(`UPDATE tasks SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1`, [taskId]));
}

/** Watchdog: refresh heartbeats of RUNNING tasks so long-running work isn't reclaimed. */
export async function heartbeatRunningTasks(): Promise<number> {
  const result = await withSystem<{ rowCount: number | null }>(async (q) =>
    q.query(`UPDATE tasks SET last_heartbeat_at = now() WHERE status = 'RUNNING' RETURNING id`),
  );
  return result.rowCount ?? 0;
}