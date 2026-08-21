/**
 * Stage 26F — Self-Healing CI.
 *
 * CI failure intake → log diagnosis → fix proposal → approval gate (when the
 * fix is HIGH risk) → fix application → retest.
 *
 * Honesty rules:
 *   - Diagnosis is derived deterministically from the actual failure logs;
 *     unknown logs produce an honest `unknown` diagnosis.
 *   - HIGH/CRITICAL fixes are gated by the existing approval machinery
 *     (createApproval + decideApproval); rejected fixes stay rejected.
 *   - Fix application NEVER performs destructive actions: merge / delete /
 *     drop / force-push / rebase are refused (`destructive_merge_rejected`)
 *     — there is no automatic destructive merge.
 *   - Retest results are fed back by the caller; the module never fabricates
 *     a green build.
 *
 * Reuses the existing task engine (createTask), approvals, audit,
 * notifications.
 */
import { pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType, RiskLevel } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { createTask } from '../execution/tasks.js';
import { createApproval, decideApproval } from '../execution/approvals.js';

export type CiRunStatus =
  | 'FAILED' | 'FIX_PROPOSED' | 'WAITING_FOR_APPROVAL'
  | 'FIX_APPLIED' | 'RETEST_PASSED' | 'RETEST_FAILED' | 'FIX_REJECTED';

export interface CiRunRow {
  id: string;
  owner_id: string;
  project_id: string;
  pipeline: string;
  commit_ref: string;
  log_ref: string | null;
  log_summary: string | null;
  status: CiRunStatus;
  diagnosis: Record<string, unknown> | null;
  fix_proposal: Record<string, unknown> | null;
  task_id: string | null;
  approval_id: string | null;
  retest_summary: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecordCiFailureInput {
  projectId: string;
  pipeline: string;
  commitRef: string;
  logRef?: string;
  logs: string;
}

interface Diagnosis {
  rootCause: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  action: string;
  description: string;
}

const DESTRUCTIVE_PATTERNS = [
  'git merge',
  'git push --force',
  'git rebase',
  'drop table',
  'drop database',
  'rm -rf',
  'delete from',
];

function diagnose(logs: string): Diagnosis {
  const text = logs.slice(0, 20_000).toLowerCase();
  if (/\btimed? ?out\b|timeout/i.test(text)) {
    return {
      rootCause: 'timeout',
      severity: 'HIGH',
      action: 'increase_timeout',
      description: 'The pipeline exceeded its timeout budget; raise the limit or split the stage.',
    };
  }
  if (/eai_again|enotfound|network|connection reset|socket hang/i.test(text)) {
    return {
      rootCause: 'network',
      severity: 'HIGH',
      action: 'verify_dependency_availability',
      description: 'A network/dependency fetch failed; verify registry and connectivity, then retry.',
    };
  }
  if (/cannot find module|no such file|error ts\d+|compilation error|build failed/i.test(text)) {
    return {
      rootCause: 'compile_error',
      severity: 'HIGH',
      action: 'fix_compile_error',
      description: 'The build/compile stage failed; fix the reported error, then retest.',
    };
  }
  if (/\b401\b|unauthorized|credentials|authentication failed|invalid token/i.test(text)) {
    return {
      rootCause: 'auth_failure',
      severity: 'HIGH',
      action: 'rotate_credentials',
      description: 'Authentication failed; rotate or refresh the credentials, then retry.',
    };
  }
  if (/flaky|intermittent|timing sensitive|race condition/i.test(text)) {
    return {
      rootCause: 'flaky_test',
      severity: 'MEDIUM',
      action: 'investigate_flaky_test',
      description: 'The failure looks flaky; investigate the test before concluding a real regression.',
    };
  }
  return {
    rootCause: 'unknown',
    severity: 'LOW',
    action: 'manual_investigation',
    description: 'No known failure pattern matched the logs; a human needs to investigate.',
  };
}

export async function getCiRun(userId: string, ciRunId: string): Promise<CiRunRow> {
  const rows = await queryMany<CiRunRow>('SELECT * FROM ci_runs WHERE id = $1 AND owner_id = $2', [ciRunId, userId]);
  if (!rows[0]) throw AppError.notFound('CI run');
  return rows[0];
}

export async function listCiRuns(userId: string, projectId?: string): Promise<CiRunRow[]> {
  const where = projectId ? 'owner_id = $1 AND project_id = $2' : 'owner_id = $1';
  const params = projectId ? [userId, projectId] : [userId];
  return queryMany<CiRunRow>(`SELECT * FROM ci_runs WHERE ${where} ORDER BY created_at DESC`, params);
}

/** Record a CI failure: intake logs, diagnose, open a repair task. */
export async function recordCiFailure(userId: string, input: RecordCiFailureInput): Promise<CiRunRow> {
  if (!input.projectId || !input.pipeline || !input.commitRef || typeof input.logs !== 'string' || !input.logs.trim()) {
    throw AppError.badRequest('ci_invalid_input', 'projectId, pipeline, commitRef and logs are required');
  }
  const id = newId(PREFIX.CI_RUN);
  const diagnosis = diagnose(input.logs);
  const task = await createTask({
    userId,
    projectId: input.projectId,
    title: `Repair CI: ${input.pipeline} @ ${input.commitRef.slice(0, 12)}`,
    description: `Self-healing repair for failed pipeline ${input.pipeline}. Diagnosis: ${diagnosis.rootCause}.`,
    riskLevel: diagnosis.severity === 'HIGH' || diagnosis.severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
  });
  await pool.query(
    `INSERT INTO ci_runs
       (id, owner_id, project_id, pipeline, commit_ref, log_ref, log_summary, status, diagnosis, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'FAILED',$8,$9)`,
    [
      id, userId, input.projectId, input.pipeline, input.commitRef, input.logRef ?? null,
      input.logs.slice(0, 1000), JSON.stringify(diagnosis), task.id,
    ],
  );
  await recordAudit({
    action: AuditAction.CI_FAILURE_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ci_run',
    resourceId: id,
    detail: { pipeline: input.pipeline, commitRef: input.commitRef, rootCause: diagnosis.rootCause, taskId: task.id },
  });
  return getCiRun(userId, id);
}

/** Propose a fix from the recorded diagnosis (only for a recorded failure). */
export async function proposeCiFix(userId: string, ciRunId: string): Promise<CiRunRow> {
  const run = await getCiRun(userId, ciRunId);
  if (run.status !== 'FAILED') throw AppError.conflict('ci_fix_not_proposable', `CI run is ${run.status}`);
  const diagnosis = run.diagnosis as Diagnosis | null;
  const proposal = diagnosis
    ? { action: diagnosis.action, severity: diagnosis.severity, description: diagnosis.description }
    : { action: 'manual_investigation', severity: 'LOW', description: 'No diagnosis recorded.' };
  await pool.query(
    `UPDATE ci_runs SET status = 'FIX_PROPOSED', fix_proposal = $1, updated_at = now() WHERE id = $2 AND owner_id = $3`,
    [JSON.stringify(proposal), ciRunId, userId],
  );
  await recordAudit({
    action: AuditAction.CI_FIX_PROPOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ci_run',
    resourceId: ciRunId,
    detail: proposal,
  });
  return getCiRun(userId, ciRunId);
}

/**
 * Apply the proposed fix. HIGH/CRITICAL fixes go through the existing
 * approval machinery first (WAITING_FOR_APPROVAL); LOW/MEDIUM fixes apply
 * directly. Destructive actions are always refused.
 */
export async function applyCiFix(
  userId: string,
  ciRunId: string,
  actionOverride?: string,
): Promise<CiRunRow> {
  const run = await getCiRun(userId, ciRunId);
  if (run.status !== 'FIX_PROPOSED') {
    throw AppError.conflict('ci_fix_not_applicable', `CI run is ${run.status}`);
  }
  const proposal = (run.fix_proposal ?? {}) as { action: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' };
  const action = actionOverride ?? proposal.action ?? 'manual_investigation';
  const lower = action.toLowerCase();
  if (DESTRUCTIVE_PATTERNS.some((p) => lower.includes(p))) {
    await recordAudit({
      action: AuditAction.CI_MERGE_REJECTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'ci_run',
      resourceId: ciRunId,
      detail: { attemptedAction: action },
    });
    throw AppError.forbidden('destructive_merge_rejected', `Action "${action}" is destructive and is never performed automatically`);
  }
  const severity = actionOverride ? proposal.severity : proposal.severity;
  if (severity === 'HIGH' || severity === 'CRITICAL') {
    const approval = await createApproval({
      ownerId: userId,
      taskId: run.task_id ?? undefined,
      riskLevel: RiskLevel.HIGH,
      detail: {
        action_type: 'ci_fix',
        justification: `Apply CI fix "${action}" for pipeline ${run.pipeline} @ ${run.commit_ref.slice(0, 12)}`,
        proposed_action: proposal,
        resource_ref: ciRunId,
      },
    });
    await pool.query(
      `UPDATE ci_runs SET status = 'WAITING_FOR_APPROVAL', approval_id = $1, updated_at = now() WHERE id = $2 AND owner_id = $3`,
      [approval.id, ciRunId, userId],
    );
    await recordAudit({
      action: AuditAction.CI_FIX_APPROVAL_REQUESTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'ci_run',
      resourceId: ciRunId,
      detail: { action, approvalId: approval.id },
    });
    await notify(
      userId,
      NotificationType.CI_FIX_APPROVAL_REQUIRED,
      'CI fix needs approval',
      {
        body: `Applying "${action}" to ${run.pipeline} requires approval`,
        resourceType: 'ci_run',
        resourceId: ciRunId,
        metadata: { action, approvalId: approval.id },
      },
    );
    return getCiRun(userId, ciRunId);
  }
  await pool.query(
    `UPDATE ci_runs SET status = 'FIX_APPLIED', updated_at = now() WHERE id = $1 AND owner_id = $2`,
    [ciRunId, userId],
  );
  await recordAudit({
    action: AuditAction.CI_FIX_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ci_run',
    resourceId: ciRunId,
    detail: { action },
  });
  await notify(userId, NotificationType.CI_FIX_APPLIED, 'CI fix applied', {
      body: `${run.pipeline}: ${action}`,
      resourceType: 'ci_run',
      resourceId: ciRunId,
      metadata: { action },
    });
  return getCiRun(userId, ciRunId);
}

/** Decide a pending CI-fix approval through the existing approval machinery. */
export async function decideCiFixApproval(
  userId: string,
  ciRunId: string,
  decision: 'APPROVE' | 'REJECT',
  reason?: string,
): Promise<CiRunRow> {
  const run = await getCiRun(userId, ciRunId);
  if (run.status !== 'WAITING_FOR_APPROVAL' || !run.approval_id) {
    throw AppError.conflict('ci_fix_not_decidable', `CI run is ${run.status}`);
  }
  await decideApproval(userId, run.approval_id, decision, reason);
  const next = decision === 'APPROVE' ? 'FIX_APPLIED' : 'FIX_REJECTED';
  await pool.query(
    `UPDATE ci_runs SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3`,
    [next, ciRunId, userId],
  );
  await recordAudit({
    action: decision === 'APPROVE' ? AuditAction.CI_FIX_APPROVED : AuditAction.CI_FIX_REJECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ci_run',
    resourceId: ciRunId,
    detail: { approvalId: run.approval_id, reason: reason ?? null },
  });
  return getCiRun(userId, ciRunId);
}

/** Feed back a REAL retest result. */
export async function recordRetest(
  userId: string,
  ciRunId: string,
  result: { ok: boolean; summary: string },
): Promise<CiRunRow> {
  const run = await getCiRun(userId, ciRunId);
  if (run.status !== 'FIX_APPLIED' && run.status !== 'RETEST_FAILED') {
    throw AppError.conflict('ci_retest_not_allowed', `CI run is ${run.status}`);
  }
  const next = result.ok ? 'RETEST_PASSED' : 'RETEST_FAILED';
  await pool.query(
    `UPDATE ci_runs SET status = $1, retest_summary = $2, updated_at = now() WHERE id = $3 AND owner_id = $4`,
    [next, result.summary.slice(0, 2000), ciRunId, userId],
  );
  await recordAudit({
    action: AuditAction.CI_RETEST_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ci_run',
    resourceId: ciRunId,
    detail: { ok: result.ok, summary: result.summary.slice(0, 400) },
  });
  return getCiRun(userId, ciRunId);
}