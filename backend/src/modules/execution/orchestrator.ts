/**
 * CodeConClave — task orchestrator (executes one claimed task end-to-end).
 * Phase 7: every task runs from a structured, persisted plan (never free-form
 * text); pipeline stages run sequentially, with dependency-safe parallel
 * groups when the plan says so; failures go through the retry policy
 * (exponential backoff) and finally the dead-letter queue. LOCAL tasks are
 * handed to WAITING_FOR_LOCAL_AGENT (never faked).
 */
import { withTenant, pool, queryOne } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import {
  beginAttempt,
  finishAttempt,
  addStep,
  finishStep,
  setTaskStatus,
  getTaskInternal,
  retryOrDeadLetter,
  listTaskDependencies,
  getTaskFailureInfo,
  touchTask,
  saveAttemptCheckpoint,
  latestCheckpoint,
  type TaskRow,
} from './tasks.js';
import {
  createCoworkerRun,
  runCoworker,
  recordHandoff,
  saveCoworkerArtifact,
  listCoworkerRuns,
  type CoworkerRunRow,
} from './coworkers.js';
import {
  getPlan,
  persistPlan,
  generatePlan,
  planToPipeline,
  groupPipeline,
  validatePlannerEntries,
  type PipelineEntry,
  type PersistedPlan,
} from './planner.js';
import { recordAudit } from '../audit/service.js';
import { issueReceipt } from '../receipts/service.js';
import { AuditAction } from './policy-shared.js';
import { AppError } from '../../shared/errors.js';
import { autoSaveTaskDna } from '../dna/service.js';
import { recordLatencyMetric } from '../../observability/metrics.js';

const DEFAULT_PIPELINE = ['ARCHITECT', 'CODER', 'SECURITY', 'TESTER', 'REVIEWER', 'DOCS'];

export { type PipelineEntry };

export function normalizePipeline(raw: unknown): PipelineEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .map((e) => (typeof e === 'string' ? { coworker: e } : e))
      .filter((e): e is PipelineEntry => Boolean(e && typeof e.coworker === 'string'));
  }
  return DEFAULT_PIPELINE.map((coworker) => ({ coworker }));
}

/**
 * Resolve the plan a task executes from: persisted plan first, then an
 * explicit validated pipeline, then the PLANNER (with deterministic fallback).
 * Every branch ends persisted — free-form text is never executed.
 */
async function loadOrGeneratePlan(task: TaskRow): Promise<PersistedPlan> {
  const existing = await getPlan(task.id);
  if (existing) return existing;
  if (Array.isArray(task.coworker_pipeline) && task.coworker_pipeline.length > 0) {
    const entries = validatePlannerEntries(
      task.coworker_pipeline.map((e) => (typeof e === 'string' ? { coworker: e } : e)),
    );
    if (entries) return persistPlan({ taskId: task.id, goal: task.title, entries });
  }
  return generatePlan({
    userId: task.owner_id,
    taskId: task.id,
    title: task.title,
    description: task.description,
  });
}

/**
 * Cooperative cancellation gate. cancelTask only flips the row — without this
 * check the worker would run every remaining stage (and all their side
 * effects) after the user cancelled. Checked before each pipeline group and
 * before the final completion writes.
 */
async function abortIfCancelled(taskId: string, attemptId: string): Promise<void> {
  const current = await getTaskInternal(taskId);
  if (current.status === 'CANCELLED') {
    await finishAttempt(attemptId, 'CANCELLED');
    throw AppError.conflict('task_cancelled', 'Task was cancelled; execution stops before further side effects');
  }
}

/**
 * Execute a claimed cloud task. Never swallows errors: failures are persisted,
 * and the retry policy (backoff, then dead-letter queue) is applied.
 */
export async function executeTask(task: TaskRow): Promise<void> {
  if (task.execution_mode === 'LOCAL') {
    await setTaskStatus(task.id, 'WAITING_FOR_LOCAL_AGENT');
    return;
  }

  const executeStartedAt = Date.now();
  const attempt = await beginAttempt(task.id);
  const steps: string[] = [];

  try {
    // Phase 16: durable resume — a checkpointed previous attempt skips the
    // completed stages (worker restart / crash recovery); the plan itself is
    // already persisted, so it is never regenerated.
    const resume = await latestCheckpoint(task.id, attempt.id);
    const resumedRuns = resume?.runIdsByOrder ?? {};

    // 1. structured persisted plan (never free-form text)
    const planStep = await addStep(task.id, attempt.id, 'plan', 'Plan pipeline');
    const planStartedAt = Date.now();
    const plan = await loadOrGeneratePlan(task);
    const pipeline = planToPipeline(plan);
    recordLatencyMetric('plan_prepare_ms', Date.now() - planStartedAt);
    await finishStep(planStep.id, 'COMPLETED', {
      pipeline: pipeline.map((p) => p.coworker),
      planId: plan.id,
      resumed: Boolean(resume),
    });
    steps.push(planStep.id);

    // 2. create coworker runs (order preserved; parallel groups from the plan)
    const groups = groupPipeline(pipeline);
    const runsByGroup: CoworkerRunRow[][] = [];
    let orderIndex = 0;
    for (const group of groups) {
      const groupRuns: CoworkerRunRow[] = [];
      for (const entry of group) {
        const resumedRunId = resumedRuns[String(orderIndex)];
        if (resumedRunId) {
          const existing = (await listCoworkerRuns(task.id)).find((r) => r.id === resumedRunId);
          if (existing) {
            groupRuns.push(existing);
            orderIndex++;
            continue;
          }
        }
        const run = await createCoworkerRun({
          taskId: task.id,
          coworkerType: entry.coworker,
          orderIndex: orderIndex++,
          runInput: entry.input ?? {},
          parallelGroup: entry.parallelGroup,
        });
        groupRuns.push(run);
      }
      runsByGroup.push(groupRuns);
    }

    // 3. execute groups sequentially; runs within a group in parallel.
    // Handoffs preserve the full context between stages.
    let previousGroupLast: CoworkerRunRow | null = null;
    for (const group of runsByGroup) {
      await abortIfCancelled(task.id, attempt.id);
      if (previousGroupLast) {
        const summary =
          (previousGroupLast.output && (previousGroupLast.output as { handoff?: string }).handoff) ||
          `Output of ${previousGroupLast.coworker_type} completed (${previousGroupLast.id})`;
        await recordHandoff(previousGroupLast.id, group[0]!.id, summary);
      }
      const runSteps = await Promise.all(
        group.map(async (run) => {
          if (resumedRuns[String(run.order_index)]) {
            // Checkpointed stage: reuse the persisted run output, never re-run.
            const reuseStep = await addStep(task.id, attempt.id, run.coworker_type, `${run.coworker_type} run (resumed)`);
            await finishStep(reuseStep.id, 'COMPLETED', { runId: run.id, resumed: true });
            return reuseStep.id;
          }
          const runStep = await addStep(task.id, attempt.id, run.coworker_type, `${run.coworker_type} run`);
          try {
            await runCoworker(run, {
              userId: task.owner_id,
              title: task.title,
              description: task.description,
              plan: JSON.stringify({ planId: plan.id, goal: plan.goal }),
              projectId: (task as { project_id?: string }).project_id ?? null,
            });
            await finishStep(runStep.id, 'COMPLETED', { runId: run.id });
          } catch (err) {
            await finishStep(runStep.id, 'FAILED', { runId: run.id }, undefined, 'coworker_error');
            throw err;
          }
          return runStep.id;
        }),
      );
      steps.push(...runSteps);
      previousGroupLast = group[group.length - 1]!;
      // Phase 16: heartbeat + durable progress after every completed stage —
      // a crashed worker resumes here instead of restarting from scratch.
      await touchTask(task.id);
      const completedOrderIndexes = group.map((r) => Number(r.order_index)).filter((n) => Number.isFinite(n));
      const runIdsByOrder: Record<string, string> = { ...resumedRuns };
      for (const run of group) runIdsByOrder[String(run.order_index)] = run.id;
      await saveAttemptCheckpoint(attempt.id, {
        stageIndex: Math.max(0, ...completedOrderIndexes),
        runIdsByOrder,
      });
    }

    // 4. verification (evidence-gated: SKIPPED unless a real verifier ran)
    const verifyStep = await addStep(task.id, attempt.id, 'verify', 'Verify results');
    const results = await listCoworkerRuns(task.id);
    const verification = results
      .filter((r) => r.verification_result)
      .map((r) => r.verification_result)
      .join(',');
    const verified = Boolean(verification && verification.includes('PASS'));
    await finishStep(
      verifyStep.id,
      verified ? 'COMPLETED' : 'SKIPPED',
      { verification: verification || 'SKIPPED', reason: verified ? undefined : 'no verifier executed' },
    );
    steps.push(verifyStep.id);

    // 5. artifacts (persist final output with SHA-256 + attempt + verification refs)
    const last = runsByGroup.length ? runsByGroup[runsByGroup.length - 1]![runsByGroup[runsByGroup.length - 1]!.length - 1]! : null;
    if (last) {
      const artifactStep = await addStep(task.id, attempt.id, 'artifact', 'Persist artifacts');
      await saveCoworkerArtifact({
        runId: last.id,
        name: `${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}-output.md`,
        kind: 'output',
        content: JSON.stringify(last.output, null, 2),
        attemptId: attempt.id,
        verification: verified ? 'PASS' : 'SKIPPED',
      });
      await finishStep(artifactStep.id, 'COMPLETED', { runId: last.id });
      steps.push(artifactStep.id);
    }

    // 6. complete (re-check: a cancel during verification/artifacts must not
    // be overwritten by completion writes)
    await abortIfCancelled(task.id, attempt.id);
    await setTaskStatus(task.id, 'VERIFIED');
    await setTaskStatus(task.id, 'COMPLETED');
    // Phase 6: auto-save project DNA (background; never blocks or fails the task).
    void autoSaveTaskDna({
      userId: task.owner_id,
      projectId: task.project_id,
      taskId: task.id,
      title: task.title,
      description: task.description ?? task.title,
      outcome: last ? JSON.stringify(last.output).slice(0, 3000) : 'Completed',
    }).catch(() => undefined);
    await finishAttempt(attempt.id, 'SUCCESS');
    // 5b. verified execution receipt + spec-proof matrix (blueprint #1/#6):
    // assembled from persisted engine rows (runs, artifact bytes,
    // verification strings) — never from model self-report. Best-effort:
    // receipt issuance must never fail an otherwise completed task.
    if (last) {
      try {
        const runRows = await listCoworkerRuns(task.id);
        await issueReceipt({
          taskId: task.id,
          attemptId: attempt.id,
          projectId: task.project_id,
          ownerId: task.owner_id,
          artifactContent: JSON.stringify(last.output, null, 2),
          verification: verification || 'SKIPPED',
          runs: runRows.map((r) => ({
            runId: r.id,
            coworkerType: r.coworker_type,
            orderIndex: r.order_index,
            verification: r.verification_result,
            output: r.output,
          })),
          criteria: plan.entries.map((e) => e.acceptanceCriteria),
        });
      } catch (err) {
        logger.warn('receipt issuance failed (task still completed)', {
          taskId: task.id,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    await recordAudit({
      action: AuditAction.TASK_COMPLETED,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: null,
      resourceType: 'task',
      resourceId: task.id,
      detail: { steps, planId: plan.id, resumed: Boolean(resume) },
    });
    logger.info('task completed', { taskId: task.id, steps });
    recordLatencyMetric('task_execute_ms', Date.now() - executeStartedAt);
  } catch (err) {
    if (err instanceof AppError && err.errorCode === 'task_cancelled') {
      // Cooperative cancel, already finished as CANCELLED above: audit quietly
      // and return. Never route through the failure/retry path (a CANCELLED
      // task must not be retried or dead-lettered).
      await recordAudit({
        action: AuditAction.TASK_CANCELLED,
        actorUserId: task.owner_id,
        scope: 'USER',
        tenantId: task.owner_id,
        resourceType: 'task',
        resourceId: task.id,
        detail: { attemptId: attempt.id, at: 'cooperative' },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await finishAttempt(attempt.id, 'FAILURE', message.slice(0, 500));
    recordLatencyMetric('task_execute_ms', Date.now() - executeStartedAt);
    const decision = await retryOrDeadLetter(task.id, 'coworker_error', message.slice(0, 200));
    await recordAudit({
      action: AuditAction.TASK_FAILED,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: null,
      resourceType: 'task',
      resourceId: task.id,
      detail: { error: message, decision },
    });
    logger.error('task failed', { taskId: task.id, err: message, decision });
  }
}

/** Boot-time wiring for task lifecycle from the chat deep path. */
export async function createTaskFromChat(input: {
  userId: string;
  projectId: string;
  conversationId: string;
  title: string;
  description?: string | null;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  pipeline?: unknown;
  priority?: number;
  dependsOn?: string[];
}): Promise<TaskRow> {
  const { createTask } = await import('./tasks.js');
  const { enqueueTask } = await import('../../shared/queue.js');
  const task = await createTask({
    userId: input.userId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    title: input.title,
    description: input.description,
    riskLevel: input.riskLevel ?? 'MEDIUM',
    coworkerPipeline: normalizePipeline(input.pipeline),
    priority: input.priority,
    dependsOn: input.dependsOn,
  });
  if (!task.required_approval) {
    // Enqueue for the worker; the in-process worker claims within its poll
    // interval (2s). Inline execution from the HTTP path is intentionally not
    // used: it spawned unbounded concurrent executions (one per create) that
    // starved the shared pool under load (Stage 24 measurement).
    await enqueueTask(task.id);
  }
  return task;
}

export async function getTaskTimeline(userId: string, taskId: string) {
  const { getTask, listAttempts, listSteps } = await import('./tasks.js');
  const { listToolCalls } = await import('./toolcalls.js');
  const { listCoworkerArtifacts } = await import('./coworkers.js');
  const task = await getTask(userId, taskId);
  const runs = await listCoworkerRuns(taskId);
  const artifacts = (
    await Promise.all(runs.map((r) => listCoworkerArtifacts(r.id).then((a) => a.map((x) => ({ ...x, run: r.coworker_type })))))
  ).flat();
  const plan = await getPlan(taskId);
  const dependencies = await listTaskDependencies(taskId);
  const failureInfo = await getTaskFailureInfo(taskId);
  const dlqRow = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM task_dlq WHERE task_id = $1', [taskId])).rows[0] ?? null,
  );
  return {
    task,
    attempts: await listAttempts(taskId),
    steps: await listSteps(taskId),
    toolCalls: await listToolCalls(taskId),
    coworkerRuns: runs,
    artifacts,
    plan,
    dependencies,
    failureInfo,
    dlq: dlqRow ?? null,
  };
}

export { pool as _orchestratorPool };
export { getTaskInternal as _getTaskInternal };