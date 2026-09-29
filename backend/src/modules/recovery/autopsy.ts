/**
 * CodeConClave — failure autopsies (Stage 26E).
 * Evidence-backed root-cause reports generated for failed tasks. An autopsy
 * NEVER hallucinates: every claim is derived from stored evidence (attempts,
 * errors, dependencies, recovery history, escalation records, branches).
 * When evidence is insufficient the root cause is CAUSE_UNKNOWN with
 * confidence 0 and no prevention recommendation.
 *
 * Autopsies reuse: task engine (attempts/steps/failure info), task history
 * (timeline), audit (every autopsy is audited), memory (confirmed failure
 * knowledge is stored as a semantic memory), Project DNA (prevention
 * recommendations are saved as NEXT_ACTIONS DNA), workers (watchdog sweep
 * generates autopsies for every failed/dead-lettered task without one).
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, DnaKind, MemorySource, MemoryType, RecoveryEventType, RootCauseCode } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { getTask, getTaskFailureInfo, listAttempts, listTaskDependencies, type TaskRow } from '../execution/tasks.js';
import { listRecoveryHistoryInternal } from './history.js';
import { recordRecoveryHistory } from './history.js';
import { createMemory } from '../memory/service.js';
import { saveDna } from '../dna/service.js';

export interface AutopsyRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  owner_id: string;
  status: string;
  root_cause_code: string;
  root_cause: string | null;
  confidence: number;
  timeline: unknown;
  attempts: unknown;
  errors: unknown;
  dependency_state: unknown;
  recovery_attempts: unknown;
  successful_fix: unknown;
  prevention: unknown;
  evidence: unknown;
  memory_id: string | null;
  created_at: Date;
}

const ERROR_CODE_MAP: Array<{ match: RegExp; code: RootCauseCode }> = [
  { match: /approval_rejected|approval_not_answered|approval_denied/, code: RootCauseCode.APPROVAL_REJECTED },
  { match: /task_timeout|timed_out|timeout/, code: RootCauseCode.TASK_TIMEOUT },
  { match: /dependency_failed|dependency_failure|dependency_unavailable|blocked_by_dependency/, code: RootCauseCode.DEPENDENCY_FAILURE },
  { match: /plugin_unavailable|plugin_disconnected|plugin_offline|provider_unavailable/, code: RootCauseCode.PLUGIN_UNAVAILABLE },
  { match: /blocked_permission|permission_denied|plugin_scope_denied|scope_denied|forbidden/, code: RootCauseCode.BLOCKED_PERMISSION },
  { match: /insufficient_resources|resource_exhausted|quota_exceeded|rate_limited|insufficient_credits/, code: RootCauseCode.RESOURCE_EXHAUSTED },
  { match: /auth_failed|authentication_failed|invalid_token|unauthorized|credentials/, code: RootCauseCode.AUTH_FAILURE },
  { match: /max_retries_exceeded|retries_exhausted|dead_lettered/, code: RootCauseCode.MAX_RETRIES_EXCEEDED },
];

const CONFIDENCE: Record<string, number> = {
  [RootCauseCode.CAUSE_UNKNOWN]: 0,
  [RootCauseCode.DEPENDENCY_FAILURE]: 0.9,
  [RootCauseCode.PLUGIN_UNAVAILABLE]: 0.85,
  [RootCauseCode.BLOCKED_PERMISSION]: 0.9,
  [RootCauseCode.APPROVAL_REJECTED]: 0.95,
  [RootCauseCode.TASK_TIMEOUT]: 0.9,
  [RootCauseCode.MAX_RETRIES_EXCEEDED]: 0.6,
  [RootCauseCode.RESOURCE_EXHAUSTED]: 0.7,
  [RootCauseCode.AUTH_FAILURE]: 0.85,
};

/**
 * Rule-based root cause classification from stored error evidence.
 * Unmapped error codes → CAUSE_UNKNOWN (the code is reported as evidence,
 * but no root cause is claimed).
 */
export function classifyRootCause(task: TaskRow): { code: RootCauseCode; reason: string | null } {
  const candidates = [
    task.error_code,
    task.failure_reason,
    task.error_detail,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const { match, code } of ERROR_CODE_MAP) {
    if (candidates.some((c) => match.test(c))) {
      const reason = candidates.find((c) => match.test(c))!;
      return { code, reason: reason.length > 400 ? `${reason.slice(0, 400)}…` : reason };
    }
  }
  if (candidates.length === 0) {
    return { code: RootCauseCode.CAUSE_UNKNOWN, reason: null };
  }
  return {
    code: RootCauseCode.CAUSE_UNKNOWN,
    reason: 'Failure recorded but no stored evidence maps to a known root cause',
  };
}

/** Evidence-backed prevention recommendation per root cause. Null when unknown. */
export function buildPrevention(code: RootCauseCode): { action: string; description: string } | null {
  switch (code) {
    case RootCauseCode.DEPENDENCY_FAILURE:
      return { action: 'verify_dependencies', description: 'Verify the failed dependency is available and healthy before retrying the task' };
    case RootCauseCode.PLUGIN_UNAVAILABLE:
      return { action: 'retry_with_backoff', description: 'The plugin/provider was unavailable; retry with exponential backoff once connectivity is restored' };
    case RootCauseCode.BLOCKED_PERMISSION:
      return { action: 'grant_scopes', description: 'Grant the missing plugin scope or permission, then retry' };
    case RootCauseCode.APPROVAL_REJECTED:
      return { action: 'revise_request', description: 'The approval was rejected; revise the task scope or justification before retrying' };
    case RootCauseCode.TASK_TIMEOUT:
      return { action: 'increase_timeout', description: 'The task exceeded its timeout budget; increase timeout_ms or split the work' };
    case RootCauseCode.MAX_RETRIES_EXCEEDED:
      return { action: 'increase_max_attempts', description: 'All retry attempts were exhausted; raise max_attempts or fix the underlying cause' };
    case RootCauseCode.RESOURCE_EXHAUSTED:
      return { action: 'free_resources', description: 'A resource limit (quota, rate, credits) was hit; free capacity before retrying' };
    case RootCauseCode.AUTH_FAILURE:
      return { action: 'rotate_credentials', description: 'Authentication failed; rotate or refresh credentials before retrying' };
    case RootCauseCode.CAUSE_UNKNOWN:
      return null;
  }
}

/** Is the task in a state that warrants (or already has) an autopsy? */
function isFailureState(task: TaskRow): boolean {
  return task.status === 'FAILED' || task.status === 'TIMED_OUT' || task.status === 'BLOCKED' || task.recovery_status === 'DEAD_LETTERED';
}

/**
 * Generate an evidence-backed autopsy for a failed task.
 * Returns the stored autopsy row. Root cause is always classified, never
 * invented; CAUSE_UNKNOWN when evidence is insufficient.
 */
export async function generateAutopsy(userId: string, taskId: string, attemptId?: string): Promise<AutopsyRow> {
  const task = await getTask(userId, taskId);
  if (!isFailureState(task)) {
    throw AppError.conflict('autopsy_requires_failure', `Task ${task.status.toLowerCase()} has not failed; no autopsy is warranted`);
  }
  const failureInfo = await getTaskFailureInfo(taskId);
  const attempts = await listAttempts(taskId);
  const targetAttempt = attemptId ? attempts.find((a) => a.id === attemptId) ?? attempts[attempts.length - 1] : attempts[attempts.length - 1];
  const history = await listRecoveryHistoryInternal(taskId);
  const dependencies = await listTaskDependencies(taskId);
  const branches = await withTenant<{ id: string; branched_task_id: string; status: string; created_at: Date }[]>(userId, (q) =>
    q
      .query<{ id: string; branched_task_id: string; status: string; created_at: Date }>(
        'SELECT id, branched_task_id, status, created_at FROM task_branches WHERE source_task_id = $1 ORDER BY created_at',
        [taskId],
      )
      .then((r) => r.rows),
  );
  for (const b of branches) {
    const t = await withTenant<{ status: string } | null>(userId, (q) =>
      q.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [b.branched_task_id]).then((r) => r.rows[0] ?? null),
    );
    b.status = t?.status ?? b.status;
  }

  const { code, reason } = classifyRootCause(task);
  const confidence = CONFIDENCE[code] ?? 0;

  const errors: Array<Record<string, unknown>> = [];
  if (task.error_code) errors.push({ source: 'task', error_code: task.error_code, error_detail: task.error_detail ?? null, failure_reason: task.failure_reason ?? null });
  for (const a of attempts) {
    if (a.error_code) errors.push({ source: `attempt_${a.attempt_number}`, error_code: a.error_code, error_detail: a.output_summary ?? null });
  }
  if (failureInfo.dead_letter_at) errors.push({ source: 'dead_letter', error_code: failureInfo.error_code, dead_letter_at: failureInfo.dead_letter_at });

  const recoveryEvents = history.filter((h) => ['RETRIED', 'RECOVERED', 'DEAD_LETTERED', 'PAUSED', 'RESUMED'].includes(h.event));
  const recoveryAttempts = recoveryEvents.map((h) => ({ event: h.event, at: h.created_at, detail: h.detail }));
  if (failureInfo.retry_count > 0) recoveryAttempts.push({ event: 'RETRIED', at: task.updated_at, detail: { retry_count: failureInfo.retry_count } });

  const successfulFix = findSuccessfulFix(taskId, targetAttempt?.id ?? null, attempts, branches);

  const prevention = buildPrevention(code);

  const evidence: Record<string, unknown> = {
    failure_info: failureInfo,
    error_sources: errors.length,
    attempt_count: attempts.length,
    dependency_count: dependencies.length,
    recovery_event_count: recoveryAttempts.length,
    branch_count: branches.length,
  };

  let memoryId: string | null = null;
  if (code !== RootCauseCode.CAUSE_UNKNOWN) {
    try {
      const memory = await createMemory(userId, {
        projectId: task.project_id,
        type: MemoryType.SEMANTIC,
        source: MemorySource.AI_INFERRED,
        content: `Failure knowledge (task ${taskId}): root cause ${code} — ${prevention?.description ?? reason ?? 'see autopsy'}.`,
        confidence,
        provenance: `autopsy:${taskId}`,
      });
      memoryId = memory.id;
      await saveDna(userId, {
        projectId: task.project_id,
        kind: DnaKind.NEXT_ACTIONS,
        title: `Failure prevention: ${task.title.slice(0, 120)}`,
        content: `Root cause ${code}. Recommended action: ${prevention?.action ?? 'investigate'} — ${prevention?.description ?? 'see autopsy'}`,
        auto: true,
      }).catch(() => undefined);
    } catch {
      /* memory/DNA knowledge is best-effort; never fail an autopsy */
    }
  }

  const id = newId(PREFIX.AUTOPSY);
  // Re-autopsy on the same attempt supersedes the previous report (never deletes
  // history — the superseded row stays readable, and recovery_history keeps
  // every AUTOPSIED event immutably).
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE failure_autopsies SET status = 'SUPERSEDED'
        WHERE task_id = $1 AND attempt_id IS NOT DISTINCT FROM $2 AND status = 'GENERATED'`,
      [taskId, targetAttempt?.id ?? null],
    ),
  );
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO failure_autopsies (
         id, task_id, attempt_id, owner_id, status, root_cause_code, root_cause,
         confidence, timeline, attempts, errors, dependency_state, recovery_attempts,
         successful_fix, prevention, evidence, memory_id
       ) VALUES ($1,$2,$3,$4,'GENERATED',$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16)`,
      [
        id,
        taskId,
        targetAttempt?.id ?? null,
        userId,
        code,
        reason,
        confidence,
        JSON.stringify(history.map((h) => ({ event: h.event, at: h.created_at, detail: h.detail }))),
        JSON.stringify(attempts.map((a) => ({ attempt_number: a.attempt_number, result: a.result, error_code: a.error_code, output_summary: a.output_summary, finished_at: a.finished_at }))),
        JSON.stringify(errors),
        JSON.stringify(dependencies.map((d) => ({ depends_on_task_id: d.depends_on_task_id, depends_on_title: d.depends_on_title, depends_on_status: d.depends_on_status }))),
        JSON.stringify(recoveryAttempts),
        JSON.stringify(successfulFix),
        JSON.stringify(prevention),
        JSON.stringify(evidence),
        memoryId,
      ],
    ),
  );
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.AUTOPSIED, {
    autopsyId: id,
    rootCauseCode: code,
    confidence,
  }, userId);
  await recordAudit({
    action: AuditAction.TASK_AUTOPSIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { autopsyId: id, rootCauseCode: code, confidence },
  });
  return getAutopsy(userId, taskId);
}

/**
 * Evidence-backed "successful fix" detection: a later successful attempt on
 * the same task, or a completed branch task, proves the failure was fixed.
 * Returns null when no such evidence exists (never invented).
 */
function findSuccessfulFix(
  taskId: string,
  targetAttemptId: string | null,
  attempts: Array<{ id: string; attempt_number: number; result: string | null; finished_at: Date | null }>,
  branches: Array<{ branched_task_id: string; status: string; created_at: Date }>,
): Record<string, unknown> | null {
  const target = targetAttemptId ? attempts.find((a) => a.id === targetAttemptId) : attempts[attempts.length - 1];
  const later = attempts.filter((a) => a !== target && a.result === 'SUCCESS');
  const fix = later[0];
  if (fix) {
    return { kind: 'attempt', attempt_number: fix.attempt_number, at: fix.finished_at };
  }
  const completedBranch = branches.find((b) => b.status === 'COMPLETED');
  if (completedBranch) {
    return { kind: 'branch', branched_task_id: completedBranch.branched_task_id, at: completedBranch.created_at };
  }
  return null;
}

/** Latest generated autopsy for a task (tenant-scoped). */
export async function getAutopsy(userId: string, taskId: string): Promise<AutopsyRow> {
  const rows = await withTenant<AutopsyRow[]>(userId, (q) =>
    q
      .query<AutopsyRow>(
        `SELECT * FROM failure_autopsies WHERE task_id = $1 AND owner_id = $2 AND status = 'GENERATED' ORDER BY created_at DESC LIMIT 1`,
        [taskId, userId],
      )
      .then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Autopsy');
  return rows[0];
}

/** All autopsies for a task (newest first). */
export async function listAutopsies(userId: string, taskId: string): Promise<AutopsyRow[]> {
  return withTenant<AutopsyRow[]>(userId, (q) =>
    q
      .query<AutopsyRow>(`SELECT * FROM failure_autopsies WHERE task_id = $1 AND owner_id = $2 ORDER BY created_at DESC`, [taskId, userId])
      .then((r) => r.rows),
  );
}

/**
 * Record an explicit remediation (the action taken after the autopsy that
 * fixed the underlying cause). Evidence-backed: only meaningful when a
 * confirmed root cause exists.
 */
export async function applyRemediation(userId: string, taskId: string, input: { action: string; note?: string }): Promise<void> {
  const task = await getTask(userId, taskId);
  await recordRecoveryHistory(taskId, userId, RecoveryEventType.REMEDIATED, {
    action: input.action,
    note: input.note ?? null,
  }, userId);
  await recordAudit({
    action: AuditAction.TASK_REMEDIATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task',
    resourceId: taskId,
    detail: { action: input.action, note: input.note ?? null, taskTitle: task.title },
  });
}

/**
 * Watchdog: generate autopsies for every failed / timed-out / dead-lettered
 * task that does not yet have a GENERATED autopsy. Returns how many were
 * created. Individual failures are logged, never propagated.
 */
export async function sweepAutopsies(): Promise<number> {
  const rows = await withSystem(async (q) => (
    await q.query<{ id: string; owner_id: string }>(
      `SELECT t.id, t.owner_id FROM tasks t
        WHERE (t.status IN ('FAILED','TIMED_OUT') OR t.recovery_status = 'DEAD_LETTERED')
          AND NOT EXISTS (
            SELECT 1 FROM failure_autopsies a
             WHERE a.task_id = t.id AND a.status = 'GENERATED'
          )`,
    )
  ).rows);
  let created = 0;
  for (const row of rows) {
    try {
      await generateAutopsy(row.owner_id, row.id);
      created++;
    } catch {
      /* never let one autopsy failure break the sweep */
    }
  }
  return created;
}