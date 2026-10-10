/**
 * CodeConClave — approvals (Approval Center).
 * Persisted, auditable, expiring, reviewable, rejectable. HIGH/CRITICAL always
 * require approval. Fast mode never bypasses: tenant isolation, payment
 * verification, critical security policy, high-risk actions.
 * Status values per migration 0008/0025: PENDING, APPROVED, REJECTED, EXPIRED,
 * REVOKED, EXECUTED, CANCELLED. Phase 4C adds the server-authoritative
 * propose -> decide -> execute human gate: execution revalidates the approval,
 * the policy engine, capabilities and device authorization before any tool
 * runs, and records the execution result back on the approval.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { ApprovalActionType, ApprovalExecutionState } from '@codeconclave/shared';
import { Timeouts, RiskLevel, AuditAction, type Risky } from './policy-shared.js';
import { guardTransition } from '../autonomy/state-machine.js';
import { recordAudit } from '../audit/service.js';
import { evaluateToolCall, policyDeniedError } from './policy.js';
import { requirePairedDevice, requireAgentOnline, requireRemoteSession } from '../agent/service.js';
import { agentWs } from '../agent/ws.js';
import { incMetric } from '../../observability/metrics.js';

const TTL_BY_RISK: Record<Risky, number> = {
  LOW: Timeouts.APPROVAL_DEFAULT_TTL_MS,
  MEDIUM: Timeouts.APPROVAL_DEFAULT_TTL_MS,
  HIGH: Timeouts.APPROVAL_MAX_TTL_MS,
  CRITICAL: Timeouts.APPROVAL_MAX_TTL_MS,
};

/** Canonical tool per action type — execution may only run these tools. */
const CANONICAL_TOOL: Record<string, string[]> = {
  [ApprovalActionType.FILE_READ]: ['file_read'],
  [ApprovalActionType.FILE_WRITE]: ['file_write', 'file_create'],
  [ApprovalActionType.FILE_CREATE]: ['file_write', 'file_create'],
  [ApprovalActionType.FILE_DELETE]: ['file_delete'],
  [ApprovalActionType.TERMINAL_EXEC]: ['terminal_exec'],
  [ApprovalActionType.NETWORK_REQUEST]: ['network_request'],
  [ApprovalActionType.PLUGIN_ACTION]: ['plugin_action'],
  [ApprovalActionType.PUBLISH]: ['plugin_action'],
  [ApprovalActionType.DEPLOY]: ['plugin_action'],
  [ApprovalActionType.PRODUCTION_OP]: ['plugin_action', 'terminal_exec'],
  [ApprovalActionType.SECRET_ACCESS]: ['file_read'],
  [ApprovalActionType.POLICY_OVERRIDE]: ['plugin_action'],
  [ApprovalActionType.PAYMENT_OP]: ['payment_admin', 'plugin_action'],
  [ApprovalActionType.REMOTE_EXEC]: ['terminal_exec'],
  [ApprovalActionType.BATCH]: ['file_write', 'file_create', 'file_delete', 'terminal_exec', 'network_request', 'plugin_action'],
};

/** Default risk when the proposal does not state one — server-classified. */
const RISK_BY_ACTION: Record<string, Risky> = {
  [ApprovalActionType.FILE_READ]: 'LOW',
  [ApprovalActionType.FILE_WRITE]: 'MEDIUM',
  [ApprovalActionType.FILE_CREATE]: 'MEDIUM',
  [ApprovalActionType.NETWORK_REQUEST]: 'MEDIUM',
  [ApprovalActionType.PLUGIN_ACTION]: 'MEDIUM',
  [ApprovalActionType.FILE_DELETE]: 'HIGH',
  [ApprovalActionType.TERMINAL_EXEC]: 'HIGH',
  [ApprovalActionType.PUBLISH]: 'HIGH',
  [ApprovalActionType.DEPLOY]: 'HIGH',
  [ApprovalActionType.PAYMENT_OP]: 'HIGH',
  [ApprovalActionType.REMOTE_EXEC]: 'HIGH',
  [ApprovalActionType.BATCH]: 'HIGH',
  [ApprovalActionType.PRODUCTION_OP]: 'CRITICAL',
  [ApprovalActionType.SECRET_ACCESS]: 'CRITICAL',
  [ApprovalActionType.POLICY_OVERRIDE]: 'CRITICAL',
};

export interface ApprovalRow {
  id: string;
  task_id: string | null;
  owner_id: string;
  detail: Record<string, unknown>;
  risk_level: Risky;
  status: string;
  decision: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  expires_at: Date;
  created_at: Date;
  action_type?: string | null;
  coworker?: string | null;
  model?: string | null;
  justification?: string | null;
  affected_resources?: unknown;
  proposed_action?: unknown;
  execution_status?: string | null;
  execution_started_at?: Date | null;
  execution_completed_at?: Date | null;
  execution_result?: unknown;
  audit_reference?: string | null;
  batch_group?: string | null;
}

export async function createApproval(input: {
  ownerId: string;
  taskId?: string | null;
  riskLevel: Risky;
  detail: Record<string, unknown>;
  expiresInMs?: number;
}): Promise<ApprovalRow> {
  const id = newId(PREFIX.APPROVAL);
  const expiresIn = Math.min(
    input.expiresInMs ?? TTL_BY_RISK[input.riskLevel] ?? Timeouts.APPROVAL_DEFAULT_TTL_MS,
    Timeouts.APPROVAL_MAX_TTL_MS,
  );
  await withTenant(input.ownerId, (q) =>
    q.query(
      `INSERT INTO approvals (id, task_id, owner_id, detail, risk_level, status, expires_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,'PENDING', now() + ($6 || ' milliseconds')::interval)`,
      [id, input.taskId ?? null, input.ownerId, JSON.stringify(input.detail), input.riskLevel, expiresIn],
    ),
  );
  await recordAudit({
    action: AuditAction.TASK_APPROVAL_REQUESTED,
    actorUserId: input.ownerId,
    scope: 'USER',
    tenantId: input.ownerId,
    resourceType: 'approval',
    resourceId: id,
    detail: { risk: input.riskLevel, taskId: input.taskId ?? null },
  });
  return getApproval(input.ownerId, id);
}

export async function getApproval(userId: string, approvalId: string): Promise<ApprovalRow> {
  const rows = await withTenant<ApprovalRow[]>(userId, (q) =>
    q.query<ApprovalRow>('SELECT * FROM approvals WHERE id = $1 AND owner_id = $2', [approvalId, userId]).then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Approval');
  return rows[0];
}

export async function listApprovals(userId: string, status?: string): Promise<ApprovalRow[]> {
  const params: unknown[] = [userId];
  let statusClause = '';
  if (status) {
    params.push(status);
    statusClause = `AND status = $${params.length}`;
  }
  return withTenant<ApprovalRow[]>(userId, (q) =>
    q
      .query<ApprovalRow>(
        `SELECT * FROM approvals WHERE owner_id = $1 ${statusClause}
         ORDER BY (status = 'PENDING') DESC, created_at DESC`,
        params,
      )
      .then((r) => r.rows),
  );
}

export async function decideApproval(
  userId: string,
  approvalId: string,
  decision: 'APPROVE' | 'REJECT',
  reason?: string,
): Promise<ApprovalRow> {
  const approval = await getApproval(userId, approvalId);
  if (approval.status !== 'PENDING') {
    throw AppError.conflict('approval_not_pending', `Approval is already ${approval.status.toLowerCase()}`);
  }
  if (approval.expires_at.getTime() <= Date.now()) {
    await expireStaleApprovals();
    throw AppError.conflict('approval_expired', 'Approval has expired (30-minute window)');
  }
  // Atomic decide: the status predicate makes concurrent APPROVE/REJECT calls
  // mutually exclusive — exactly one wins; the loser sees rowCount 0 instead
  // of silently overwriting the winner (last-writer-wins).
  const decided = await withTenant<{ rowCount: number | null }>(userId, (q) =>
    q
      .query(
        `UPDATE approvals SET status = $2, decision = $3, decided_by = $4, decided_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [approvalId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decision, userId],
      )
      .then((r) => ({ rowCount: r.rowCount })),
  );
  if ((decided.rowCount ?? 0) === 0) {
    throw AppError.conflict(
      'approval_not_pending',
      'Approval is no longer pending (a concurrent decision was recorded first)',
    );
  }
  await recordAudit({
    action: decision === 'APPROVE' ? AuditAction.APPROVAL_GRANTED : AuditAction.APPROVAL_REJECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'approval',
    resourceId: approvalId,
    detail: { reason: reason ?? null, taskId: approval.task_id ?? null },
  });

  // Task follow-up is best-effort convergence: the human decision above is
  // already atomically recorded. A task that moved on concurrently must not
  // be yanked across states by a late link write — such skips are audited.
  if (approval.task_id) {
    if (decision === 'APPROVE') {
      try {
        const { approveLinkTask, getTaskInternal, setTaskStatus } = await import('./tasks.js');
        await approveLinkTask(approval.task_id, approvalId);
        if ((await getTaskInternal(approval.task_id)).execution_mode === 'LOCAL') {
          await setTaskStatus(approval.task_id, 'WAITING_FOR_LOCAL_AGENT');
        } else {
          const { enqueueTask } = await import('../../shared/queue.js');
          await enqueueTask(approval.task_id);
        }
      } catch (err) {
        await recordAudit({
          action: AuditAction.APPROVAL_GRANTED,
          actorUserId: userId,
          scope: 'USER',
          tenantId: userId,
          resourceType: 'task',
          resourceId: approval.task_id,
          detail: { note: 'task link skipped: task moved on concurrently', error: err instanceof Error ? err.message : String(err) },
        });
      }
    } else {
      const current = await withTenant<{ status: string } | null>(userId, (q) =>
        q.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [approval.task_id]).then((r) => r.rows[0] ?? null),
      );
      if (current?.status) guardTransition(current.status, 'CANCELLED');
      // Conditional: cancel from a cancellable state only — never clobber a
      // concurrently COMPLETED/CANCELLED task. The rejection itself stands.
      const cancelled = await withTenant<{ rowCount: number | null }>(userId, (q) =>
        q
          .query(
            `UPDATE tasks SET status = 'CANCELLED', error_code = 'approval_rejected', completed_at = now(),
                              updated_at = now()
              WHERE id = $1 AND status IN ('WAITING_APPROVAL','CREATED','PLANNED','CHANGED','RUNNING')`,
            [approval.task_id],
          )
          .then((r) => ({ rowCount: r.rowCount })),
      );
      if ((cancelled.rowCount ?? 0) === 0) {
        await recordAudit({
          action: AuditAction.APPROVAL_REJECTED,
          actorUserId: userId,
          scope: 'USER',
          tenantId: userId,
          resourceType: 'task',
          resourceId: approval.task_id,
          detail: { note: 'task left a cancellable state concurrently; rejection recorded on the approval only' },
        });
      }
    }
  }
  return getApproval(userId, approvalId);
}

/** Watchdog: expire stale approvals (returns count). Each expiry is audited. */
export async function expireStaleApprovals(): Promise<number> {
  const result = await withSystem((q) =>
    q.query(
      `UPDATE approvals SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= now() RETURNING id`,
    ),
  );
  const count = result.rowCount ?? 0;
  if (result.rows) {
    for (const row of result.rows as { id: string }[]) {
      await recordAudit({
        action: AuditAction.APPROVAL_EXPIRED,
        actorUserId: null,
        scope: 'SYSTEM',
        tenantId: null,
        resourceType: 'approval',
        resourceId: row.id,
        detail: { reason: 'expiry sweep' },
      });
    }
  }
  return count;
}

/** Reject pending approvals for a task (used on task cancel). */
export async function cancelPendingApprovalsForTask(taskId: string): Promise<void> {
  await withSystem((q) =>
    q.query(
      `UPDATE approvals SET status = 'REVOKED', decision = 'REJECT' WHERE task_id = $1 AND status = 'PENDING'`,
      [taskId],
    ),
  );
}

export async function pendingApprovalCount(userId: string): Promise<number> {
  const row = await withTenant<{ n: number } | null>(userId, (q) =>
    q.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM approvals WHERE owner_id = $1 AND status = $2', [userId, 'PENDING']).then((r) => r.rows[0] ?? null),
  );
  return row?.n ?? 0;
}

export { Timeouts, RiskLevel, ApprovalExecutionState };

// ---------------------------------------------------------------------------
// Phase 4C — server-authoritative Approval Center + human-gate execution.
// The server decides EVERYTHING: whether an approval is needed, who may
// approve, whether the approval still holds at execution time, and what the
// approved action may touch. A client can never claim "approved" itself.
// ---------------------------------------------------------------------------

export interface ApprovalResourceInput {
  type: string;
  ref: string;
  detail?: string;
}

export interface ApprovalProposal {
  taskId?: string;
  actionType: string;
  riskLevel?: Risky;
  coworker?: string;
  model?: string;
  justification: string;
  affectedResources: ApprovalResourceInput[];
  proposedAction: Record<string, unknown>;
  expiresInMs?: number;
  batchGroup?: string;
}

export interface ApprovalExecutionRequest {
  tool: string;
  input: Record<string, unknown>;
  deviceId?: string;
}

export interface ApprovalProposeResult {
  approval: ApprovalRow | null;
  autoApproved: boolean;
}

function resourceRefs(row: ApprovalRow): string[] {
  const raw = row.affected_resources;
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => (r && typeof r === 'object' && typeof (r as ApprovalResourceInput).ref === 'string' ? (r as ApprovalResourceInput).ref : String(r)));
}

function sameResources(a: ApprovalRow, b: ApprovalResourceInput[]): boolean {
  const refsA = resourceRefs(a).slice().sort();
  const refsB = b.map((r) => r.ref).slice().sort();
  return refsA.length === refsB.length && refsA.every((r, i) => r === refsB[i]);
}

/**
 * Propose an action for human-gate approval. Duplicate PENDING proposals
 * (same action type + same affected resources) return the existing approval
 * instead of creating a second one. The default window is 30 minutes (spec);
 * an explicit longer window is capped at 30 minutes.
 */
export async function proposeApproval(
  userId: string,
  proposal: ApprovalProposal,
): Promise<ApprovalProposeResult> {
  const actionType = proposal.actionType;
  const resources = proposal.affectedResources;
  const risk = proposal.riskLevel ?? RISK_BY_ACTION[actionType] ?? 'HIGH';
  if (!CANONICAL_TOOL[actionType]) {
    throw AppError.badRequest('unknown_action_type', `Action type ${actionType} is not supported`);
  }

  const pending = await withTenant<ApprovalRow[]>(userId, (q) =>
    q
      .query<ApprovalRow>(
        `SELECT * FROM approvals WHERE owner_id = $1 AND action_type = $2 AND status = 'PENDING' ORDER BY created_at DESC`,
        [userId, actionType],
      )
      .then((r) => r.rows),
  );
  for (const existing of pending) {
    if (sameResources(existing, resources)) {
      return { approval: existing, autoApproved: false };
    }
  }

  const id = newId(PREFIX.APPROVAL);
  const expiresIn = Math.min(
    proposal.expiresInMs ?? Timeouts.APPROVAL_DEFAULT_EXPIRY_MS,
    Timeouts.APPROVAL_DEFAULT_EXPIRY_MS,
  );
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO approvals
         (id, task_id, owner_id, detail, risk_level, status, expires_at,
          action_type, coworker, model, justification, affected_resources, proposed_action, batch_group)
       VALUES ($1,$2,$3,$4::jsonb,$5,'PENDING', now() + ($6 || ' milliseconds')::interval,
               $7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)`,
      [
        id,
        proposal.taskId ?? null,
        userId,
        JSON.stringify({ justification: proposal.justification }),
        risk,
        expiresIn,
        actionType,
        proposal.coworker ?? null,
        proposal.model ?? null,
        proposal.justification,
        JSON.stringify(resources),
        JSON.stringify(proposal.proposedAction ?? {}),
        proposal.batchGroup ?? null,
      ],
    ),
  );
  if (resources.length > 0) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    resources.forEach((r, i) => {
      const base = i * 4;
      tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
      values.push(newId(PREFIX.APPROVAL + '_res'), id, r.type, r.ref, JSON.stringify({ detail: r.detail ?? null }));
    });
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO approval_resources (id, approval_id, resource_type, resource_ref, detail) VALUES ${tuples.join(',')}`,
        values,
      ),
    );
  }
  await recordAudit({
    action: AuditAction.APPROVAL_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'approval',
    resourceId: id,
    detail: {
      actionType,
      risk,
      taskId: proposal.taskId ?? null,
      resources: resources.map((r) => r.ref),
    },
  });
  return { approval: await getApproval(userId, id), autoApproved: false };
}

/**
 * Human-gate execution: the server revalidates EVERYTHING before any tool runs —
 * the approval exists and belongs to this user, is APPROVED, is not expired,
 * the tool matches the approved action type, the touched resource is within the
 * approved resources, the policy engine still allows the call (approval never
 * bypasses policy), capabilities are still valid, and terminal/remote execution
 * still has a paired, online device with an active remote session. The result
 * of the tool call is recorded back on the approval (EXECUTED + SUCCEEDED/FAILED).
 */
export async function executeApprovedAction(
  userId: string,
  approvalId: string,
  execution: ApprovalExecutionRequest,
): Promise<ApprovalRow> {
  const approval = await getApproval(userId, approvalId);
  if (approval.status !== 'APPROVED') {
    throw AppError.conflict('approval_not_approved', `Approval is ${approval.status.toLowerCase()}; only APPROVED approvals may execute`);
  }
  if (approval.expires_at.getTime() <= Date.now()) {
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE approvals SET status = 'EXPIRED', execution_status = 'FAILED', execution_completed_at = now()
          WHERE id = $1 AND status = 'APPROVED'`,
        [approvalId],
      ),
    );
    throw AppError.conflict('approval_expired', 'Approval has expired and can no longer execute');
  }

  const actionType = approval.action_type ?? 'batch';
  const allowedTools = CANONICAL_TOOL[actionType] ?? [];
  if (!allowedTools.includes(execution.tool)) {
    throw AppError.conflict(
      'approval_action_mismatch',
      `Approval for ${actionType} does not cover tool ${execution.tool}`,
    );
  }

  const approvedRefs = resourceRefs(approval);
  const execRef = executionRef(execution);
  if (execRef && approvedRefs.length > 0 && !approvedRefs.includes(execRef)) {
    throw AppError.conflict(
      'approval_resource_mismatch',
      `Resource ${execRef} is not covered by this approval`,
    );
  }

  const decision = evaluateToolCall({ tool: execution.tool, input: execution.input, userId });
  if (!decision.allowed) throw policyDeniedError(decision);

  if (actionType === ApprovalActionType.TERMINAL_EXEC || actionType === ApprovalActionType.REMOTE_EXEC) {
    const deviceId = execution.deviceId;
    if (!deviceId) throw AppError.badRequest('device_required', 'A paired device is required for terminal/remote execution');
    const device = await requirePairedDevice(userId, deviceId);
    const hub = agentWs();
    requireAgentOnline(userId, deviceId, (u, d) => hub.isOnline(u, d));
    if (actionType === ApprovalActionType.REMOTE_EXEC) await requireRemoteSession(userId, deviceId);
    void device;
  }

  // Atomic execution claim: concurrent execute calls are mutually exclusive.
  // Exactly one caller transitions NULL/FAILED -> RUNNING; the loser gets a
  // conflict instead of running the tool a second time (double side effects).
  // Retry after FAILED still works; retry after SUCCEEDED is already blocked
  // by the APPROVED check above (status becomes EXECUTED).
  const claimed = await withTenant<{ rowCount: number | null }>(userId, (q) =>
    q
      .query(
        `UPDATE approvals SET execution_status = 'RUNNING', execution_started_at = now()
          WHERE id = $1 AND status = 'APPROVED'
            AND (execution_status IS NULL OR execution_status <> 'RUNNING')`,
        [approvalId],
      )
      .then((r) => ({ rowCount: r.rowCount })),
  );
  if ((claimed.rowCount ?? 0) === 0) {
    throw AppError.conflict(
      'approval_execution_conflict',
      'Approval execution is already running or is no longer executable',
    );
  }
  await recordAudit({
    action: AuditAction.APPROVAL_EXECUTION_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'approval',
    resourceId: approvalId,
    detail: { tool: execution.tool, deviceId: execution.deviceId ?? null },
  });

  try {
    const { runRegisteredTool } = await import('./toolcalls.js');
    const output = await runRegisteredTool(execution.tool, execution.input, { userId });
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE approvals SET status = 'EXECUTED', execution_status = 'SUCCEEDED',
                execution_completed_at = now(), execution_result = $2::jsonb, audit_reference = $3
          WHERE id = $1`,
        [approvalId, JSON.stringify(output ?? {}), `tool:${execution.tool}`],
      ),
    );
    await recordAudit({
      action: AuditAction.APPROVAL_EXECUTION_SUCCEEDED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'approval',
      resourceId: approvalId,
      detail: { tool: execution.tool, output },
    });
  } catch (err) {
    incMetric('security.approvals_failed');
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE approvals SET status = 'EXECUTED', execution_status = 'FAILED',
                execution_completed_at = now(), execution_result = $2::jsonb
          WHERE id = $1`,
        [approvalId, JSON.stringify({ error: message })],
      ),
    );
    await recordAudit({
      action: AuditAction.APPROVAL_EXECUTION_FAILED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'approval',
      resourceId: approvalId,
      detail: { tool: execution.tool, error: message },
    });
  }
  return getApproval(userId, approvalId);
}

function executionRef(execution: ApprovalExecutionRequest): string | null {
  const input = execution.input ?? {};
  for (const key of ['path', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}