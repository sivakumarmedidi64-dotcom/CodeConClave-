/**
 * CodeConClave — automation event pipeline + executor (Stage 26D).
 *
 * EVENT → VALIDATE SOURCE → AUTHENTICATE → TENANT RESOLVE → CHECK CONDITIONS →
 * CHECK PERMISSIONS → CREATE/UPDATE TASK → OPTIONAL APPROVAL → EXECUTE →
 * VERIFY → AUDIT
 *
 * Authentication happens before this layer (webhooks.ts for external sources;
 * the calling engine for internal sources). Tenant resolve maps the event to
 * an owner_id. Every event is de-duplicated once globally (event_log UNIQUE
 * source+event_id) and once per rule (automation_runs UNIQUE automation+event).
 * Execution reuses the existing startRun / createTask / runNow /
 * executePluginAction / createApproval / notify / recordAudit pipeline.
 */
import { pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { startRun } from '../agents/service.js';
import { createTask } from '../execution/tasks.js';
import { createApproval, decideApproval } from '../execution/approvals.js';
import { executePluginAction } from '../plugins/engine.js';
import { runNow } from '../scheduling/service.js';
import { evaluateConditions, renderValue, validatePlaceholders, type TemplateContext } from './templates.js';
import { smartEscalate, type EscalationTriggerReason } from './escalate.js';
import type { AutomationRule } from './rules.js';

export const EVENT_SOURCES = ['schedule', 'task_completed', 'github', 'plugin', 'deployment', 'webhook'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface EventContext {
  source: EventSource;
  eventId: string;
  eventType: string;
  ownerId: string;
  payload: Record<string, unknown>;
}

export interface RunResultRow {
  id: string;
  automation_id: string;
  owner_id: string;
  status: string;
  error: string | null;
  result: Record<string, unknown>;
  approval_id: string | null;
  event_id: string;
  event_type: string;
  event_source: string;
  attempts: number;
}

export type IngestResult =
  | { status: 'duplicate' }
  | { status: 'no_rules' }
  | { status: 'processed'; processed: number; runs: RunResultRow[] }
  | { status: 'failed'; processed: number; runs: RunResultRow[] };

const MAX_RULES_PER_EVENT = 20;

function mapRunRow(row: Record<string, unknown>): RunResultRow {
  return {
    id: String(row.id),
    automation_id: String(row.automation_id),
    owner_id: String(row.owner_id),
    status: String(row.status),
    error: row.error ? String(row.error) : null,
    result: (row.result as Record<string, unknown>) ?? {},
    approval_id: row.approval_id ? String(row.approval_id) : null,
    event_id: String(row.event_id),
    event_type: String(row.event_type),
    event_source: String(row.event_source),
    attempts: Number(row.attempts ?? 0),
  };
}

function validateEvent(input: EventContext): void {
  if (!EVENT_SOURCES.includes(input.source)) throw AppError.badRequest('invalid_event_source', `source must be one of ${EVENT_SOURCES.join(', ')}`);
  if (!input.eventId || input.eventId.length > 200) throw AppError.badRequest('invalid_event_id', 'eventId is required (max 200 chars)');
  if (!input.eventType || input.eventType.length > 200) throw AppError.badRequest('invalid_event_type', 'eventType is required (max 200 chars)');
  if (!input.ownerId) throw AppError.badRequest('tenant_required', 'ownerId is required');
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw AppError.badRequest('invalid_payload', 'payload must be an object');
  }
}

/** Global replay protection: one event_id per source is ever processed. */
async function claimEventLog(ctx: EventContext): Promise<{ claimed: boolean; rowId: string }> {
  const result = await pool.query(
    `INSERT INTO event_log (id, owner_id, source, event_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (source, event_id) DO NOTHING
     RETURNING id`,
    [newId(PREFIX.EVENT), ctx.ownerId, ctx.source, ctx.eventId, ctx.eventType, JSON.stringify(ctx.payload)],
  );
  if (!result.rows[0]) return { claimed: false, rowId: '' };
  return { claimed: true, rowId: String(result.rows[0].id) };
}

async function markEventLog(rowId: string, status: string, reason: string | null): Promise<void> {
  await pool.query(
    `UPDATE event_log SET status = $2, reason = $3 WHERE id = $1`,
    [rowId, status, reason],
  );
}

/**
 * Entry point for any event. External webhooks authenticate first (webhooks.ts)
 * and then call this with a resolved ownerId. Internal engines (scheduler, task
 * engine, plugins, deployments) call this with their authenticated ownerId.
 */
export async function ingestEvent(ctx: EventContext, opts: { bypassDedup?: boolean } = {}): Promise<IngestResult> {
  validateEvent(ctx);
  const { claimed, rowId } = await claimEventLog(ctx);
  if (!claimed && !opts.bypassDedup) {
    await recordAudit({
      action: AuditAction.EVENT_DEDUPLICATED,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: ctx.ownerId,
      resourceType: 'event',
      resourceId: ctx.eventId,
      detail: { source: ctx.source, eventType: ctx.eventType },
    });
    return { status: 'duplicate' };
  }
  await recordAudit({
    action: AuditAction.EVENT_RECEIVED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: ctx.ownerId,
    resourceType: 'event',
    resourceId: ctx.eventId,
    detail: { source: ctx.source, eventType: ctx.eventType },
  });

  const rules = await findMatchingRules(ctx);
  if (rules.length === 0) {
    await markEventLog(rowId, 'SKIPPED', 'no_matching_rules');
    return { status: 'no_rules' };
  }

  const runs: RunResultRow[] = [];
  let failed = 0;
  for (const rule of rules.slice(0, MAX_RULES_PER_EVENT)) {
    const run = await processRule(rule, ctx);
    if (run) {
      runs.push(run);
      if (run.status === 'FAILED') failed++;
    }
  }
  await markEventLog(rowId, failed > 0 ? 'FAILED' : 'PROCESSED', `${runs.length} rule(s) matched`);
  return failed > 0
    ? { status: 'failed', processed: runs.length, runs }
    : { status: 'processed', processed: runs.length, runs };
}

/** Load ACTIVE rules for a tenant + event type and evaluate their conditions. */
export async function findMatchingRules(ctx: EventContext): Promise<AutomationRule[]> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM automation_rules
     WHERE owner_id = $1 AND status = 'ACTIVE' AND event_source = $2 AND event_type = $3
     ORDER BY created_at ASC LIMIT 20`,
    [ctx.ownerId, ctx.source, ctx.eventType],
  );
  const out: AutomationRule[] = [];
  for (const row of rows) {
    const rule = row as unknown as AutomationRule;
    const result = evaluateConditions(rule.conditions ?? {}, ctx.payload);
    if (result.matched) out.push(rule);
  }
  return out;
}

/** Bump the per-rule run budget with an hourly reset window. */
async function bumpRunBudget(ruleId: string, ownerId: string): Promise<void> {
  await pool.query(
    `UPDATE automation_rules
        SET run_count = run_count + 1, last_run_at = now(),
            run_count_reset_at = CASE
              WHEN run_count_reset_at <= now() - interval '1 hour' THEN now()
              ELSE run_count_reset_at
            END,
            last_run_status = 'RUNNING', last_error = NULL, updated_at = now()
      WHERE id = $1 AND owner_id = $2`,
    [ruleId, ownerId],
  );
}

/** Loop guard: throttle a rule that fires too often (infinite-loop protection). */
function loopGuard(rule: AutomationRule, now: Date): { ok: boolean; reason?: string } {
  const resetAt = new Date(rule.run_count_reset_at);
  const windowReset = isNaN(resetAt.getTime()) || resetAt.getTime() + 60 * 60 * 1000 <= now.getTime();
  const count = windowReset ? 0 : rule.run_count;
  if (count >= rule.max_runs_per_hour) {
    return { ok: false, reason: `loop_guard:max_runs_per_hour(${rule.max_runs_per_hour})` };
  }
  if (rule.cooldown_ms > 0 && rule.last_run_at) {
    const lastAt = new Date(rule.last_run_at);
    if (!isNaN(lastAt.getTime()) && now.getTime() - lastAt.getTime() < rule.cooldown_ms) {
      return { ok: false, reason: `loop_guard:cooldown(${rule.cooldown_ms}ms)` };
    }
  }
  return { ok: true };
}

async function insertRun(rule: AutomationRule, ctx: EventContext, status: string): Promise<RunResultRow | null> {
  const id = newId(PREFIX.AUTOMATION_RUN);
  const result = await pool.query(
    `INSERT INTO automation_runs
       (id, automation_id, owner_id, event_source, event_type, event_id, status, trigger_mode, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (automation_id, event_id) DO NOTHING
     RETURNING *`,
    [
      id, rule.id, ctx.ownerId, ctx.source, ctx.eventType, ctx.eventId, status, rule.trigger_mode,
      JSON.stringify({ payload: ctx.payload, event: { eventId: ctx.eventId, eventType: ctx.eventType, source: ctx.source } }),
    ],
  );
  if (!result.rows[0]) return null;
  return mapRunRow(result.rows[0]);
}

export async function updateRun(runId: string, patch: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [runId];
  for (const [k, v] of Object.entries(patch)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE automation_runs SET ${sets.join(', ')} WHERE id = $1`, params);
}

export async function getRun(userId: string, runId: string): Promise<RunResultRow> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM automation_runs WHERE id = $1 AND owner_id = $2', [runId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Automation run');
  return mapRunRow(rows[0]);
}

export async function listRuns(userId: string, limit = 100): Promise<RunResultRow[]> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM automation_runs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(mapRunRow);
}

export interface ExecutedResult {
  actions: Array<{ type: string; ok: boolean; result: Record<string, unknown>; error?: string }>;
}

/** Execute the (already rendered) actions of a rule. Throws on first failure. */
async function executeActions(
  rule: AutomationRule,
  run: RunResultRow,
  actions: Array<Record<string, unknown>>,
  ctx: EventContext,
): Promise<ExecutedResult> {
  const executed: ExecutedResult = { actions: [] };
  for (const action of actions) {
    const type = String(action.type ?? '');
    try {
      const result = await dispatchAction(rule, action, ctx);
      executed.actions.push({ type, ok: true, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      executed.actions.push({ type, ok: false, error, result: {} });
      throw new ActionExecutionError(error, type, action);
    }
  }
  return executed;
}

export class ActionExecutionError extends Error {
  actionType: string;
  action: Record<string, unknown>;
  constructor(message: string, actionType: string, action: Record<string, unknown>) {
    super(message);
    this.name = 'ActionExecutionError';
    this.actionType = actionType;
    this.action = action;
  }
}

async function dispatchAction(rule: AutomationRule, action: Record<string, unknown>, ctx: EventContext): Promise<Record<string, unknown>> {
  switch (action.type) {
    case 'create_task': {
      const agentId = action.agentId ? String(action.agentId) : null;
      const objective = String(action.objective ?? action.title ?? ctx.eventType);
      const projectId = action.projectId ? String(action.projectId) : rule.project_id ?? undefined;
      if (agentId) {
        const run = await startRun(rule.owner_id, agentId, {
          projectId: projectId ?? undefined,
          objective,
          subtasks: Array.isArray(action.subtasks) ? action.subtasks as Array<{ title: string; description?: string }> : [{ title: objective, description: action.description ? String(action.description) : undefined }],
          requireApproval: false,
        });
        return { agentRunId: run.id, objective };
      }
      if (!projectId) {
        throw AppError.badRequest('project_required', 'create_task without an agent requires a projectId');
      }
      const task = await createTask({
        userId: rule.owner_id,
        projectId,
        title: objective,
        description: action.description ? String(action.description) : null,
        executionMode: action.executionMode === 'LOCAL' ? 'LOCAL' : 'CLOUD',
      });
      return { taskId: task.id, objective };
    }
    case 'run_schedule': {
      const scheduleId = String(action.scheduleId ?? '');
      if (!scheduleId) throw AppError.badRequest('schedule_required', 'run_schedule requires scheduleId');
      const scheduleRun = await runNow(rule.owner_id, scheduleId);
      return { scheduleRunId: scheduleRun.id, scheduleId };
    }
    case 'notify': {
      const type = NotificationType[String(action.notificationType ?? 'AUTOMATION_RUN_COMPLETED') as keyof typeof NotificationType]
        ?? NotificationType.AUTOMATION_RUN_COMPLETED;
      await notify(rule.owner_id, type, String(action.title ?? 'Automation notification'), {
        body: action.body ? String(action.body) : undefined,
        resourceType: action.resourceType ? String(action.resourceType) : 'automation_rule',
        resourceId: action.resourceId ? String(action.resourceId) : rule.id,
      });
      return { notified: rule.owner_id, type };
    }
    case 'plugin_action': {
      const connectionId = String(action.connectionId ?? '');
      const pluginAction = String(action.action ?? '');
      if (!connectionId || !pluginAction) throw AppError.badRequest('plugin_action_required', 'plugin_action requires connectionId and action');
      const outcome = await executePluginAction({
        userId: rule.owner_id,
        connectionId,
        action: pluginAction,
        input: (action.input ?? {}) as Record<string, unknown>,
        taskId: undefined,
      });
      return { pluginType: outcome.pluginType, action: outcome.action, data: outcome.data };
    }
    case 'escalate': {
      const esc = await smartEscalate(rule.owner_id, {
        targetType: 'automation',
        targetId: rule.id,
        triggerReason: action.triggerReason ? String(action.triggerReason) as EscalationTriggerReason : 'automation_escalation',
        issue: action.issue ? String(action.issue) : `Automation "${rule.name}" escalated`,
        evidence: [{ kind: 'event_context', source: ctx.source, eventId: ctx.eventId, eventType: ctx.eventType }],
        attemptedActions: [String(action.type)],
        options: Array.isArray(action.options) ? action.options.map(String) : undefined,
        recommendation: action.recommendation ? String(action.recommendation) : undefined,
        risk: action.risk ? String(action.risk) : undefined,
        costUsd: typeof action.costUsd === 'number' ? action.costUsd : undefined,
      });
      return { escalationId: esc.id };
    }
    default:
      throw AppError.badRequest('invalid_action', `Unsupported action type ${action.type}`);
  }
}

/** Run one rule for one event. Returns the automation_run or null if duplicate. */
export async function processRule(rule: AutomationRule, ctx: EventContext): Promise<RunResultRow | null> {
  const now = new Date();
  const guard = loopGuard(rule, now);
  if (!guard.ok) {
    const skipped = await insertRun(rule, ctx, 'SKIPPED');
    await recordAudit({
      action: AuditAction.AUTOMATION_LOOP_GUARD,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: ctx.ownerId,
      resourceType: 'automation_rule',
      resourceId: rule.id,
      detail: { eventId: ctx.eventId, reason: guard.reason },
    });
    await notify(ctx.ownerId, NotificationType.AUTOMATION_RUN_FAILED, `Automation throttled: ${rule.name}`, {
      body: guard.reason,
      resourceType: 'automation_rule',
      resourceId: rule.id,
    });
    return skipped;
  }

  const run = await insertRun(rule, ctx, 'RUNNING');
  if (!run) return null; // duplicate (automation_id, event_id)

  await bumpRunBudget(rule.id, ctx.ownerId);
  await recordAudit({
    action: AuditAction.AUTOMATION_RULE_RAN,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: ctx.ownerId,
    resourceType: 'automation_rule',
    resourceId: rule.id,
    detail: { eventId: ctx.eventId, eventType: ctx.eventType, runId: run.id, triggerMode: rule.trigger_mode },
  });

  const templateCtx: TemplateContext = {
    payload: ctx.payload,
    event: { eventId: ctx.eventId, eventType: ctx.eventType, source: ctx.source },
  };
  const renderedActions = renderValue(rule.actions, templateCtx) as Array<Record<string, unknown>>;
  validatePlaceholders(renderedActions);

  const needsApproval = rule.require_approval || rule.trigger_mode === 'manual' || renderedActions.some((a) => a.requireApproval === true);
  if (needsApproval) {
    const approval = await createApproval({
      ownerId: ctx.ownerId,
      taskId: null,
      riskLevel: 'HIGH',
      detail: {
        kind: 'automation',
        automationId: run.automation_id,
        runId: run.id,
        ruleName: rule.name,
        eventId: ctx.eventId,
        eventType: ctx.eventType,
        actions: renderedActions.map((a) => ({ type: a.type, summary: a.objective ?? a.title ?? a.action ?? '' })),
      },
    });
    await updateRun(run.id, { status: 'WAITING_FOR_APPROVAL', approval_id: approval.id });
    await notify(ctx.ownerId, NotificationType.AGENT_APPROVAL_REQUIRED, `Automation approval required: ${rule.name}`, {
      body: `Event ${ctx.eventType} (${ctx.eventId}) triggered "${rule.name}" and needs your approval.`,
      resourceType: 'automation_rule',
      resourceId: rule.id,
    });
    return getRun(ctx.ownerId, run.id);
  }

  try {
    const executed = await executeActions(rule, run, renderedActions, ctx);
    await updateRun(run.id, {
      status: 'COMPLETED',
      result: JSON.stringify({ ...run.result, executed }),
      completed_at: new Date().toISOString(),
    });
    await pool.query(
      `UPDATE automation_rules SET last_run_status = 'COMPLETED', updated_at = now() WHERE id = $1`,
      [rule.id],
    );
    await recordAudit({
      action: AuditAction.AUTOMATION_RULE_RAN,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: ctx.ownerId,
      resourceType: 'automation_rule',
      resourceId: rule.id,
      detail: { eventId: ctx.eventId, runId: run.id, outcome: 'completed', actions: executed.actions.length },
    });
    await notify(ctx.ownerId, NotificationType.AUTOMATION_RUN_COMPLETED, `Automation completed: ${rule.name}`, {
      body: `Event ${ctx.eventType} (${ctx.eventId}) was handled.`,
      resourceType: 'automation_rule',
      resourceId: rule.id,
    });
    return getRun(ctx.ownerId, run.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (run.attempts ?? 0) + 1;
    await updateRun(run.id, {
      status: 'FAILED',
      error: message,
      attempts,
      result: JSON.stringify({ ...run.result, error: message }),
      completed_at: new Date().toISOString(),
    });
    await pool.query(
      `UPDATE automation_rules SET last_run_status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1`,
      [rule.id, message],
    );
    await recordAudit({
      action: AuditAction.AUTOMATION_RULE_FAILED,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: ctx.ownerId,
      resourceType: 'automation_rule',
      resourceId: rule.id,
      detail: { eventId: ctx.eventId, runId: run.id, attempts, error: message },
    });
    await notify(ctx.ownerId, NotificationType.AUTOMATION_RUN_FAILED, `Automation failed: ${rule.name}`, {
      body: message,
      resourceType: 'automation_rule',
      resourceId: rule.id,
    });
    const reason = classifyFailure(err, attempts);
    await smartEscalate(ctx.ownerId, {
      targetType: 'automation',
      targetId: rule.id,
      triggerReason: reason as EscalationTriggerReason,
      issue: `Automation "${rule.name}" failed after ${attempts} attempt(s): ${message}`,
      evidence: [
        { kind: 'event_context', source: ctx.source, eventId: ctx.eventId, eventType: ctx.eventType },
        { kind: 'run', runId: run.id, status: 'FAILED', attempts },
      ],
      attemptedActions: renderedActions.map((a) => String(a.type ?? '')),
      options: ['APPROVE', 'RETRY', 'EDIT_PLAN', 'PAUSE', 'CANCEL'],
      recommendation: attempts >= 3 ? 'EDIT_PLAN' : 'RETRY',
      risk: attempts >= 3 ? 'HIGH' : 'MEDIUM',
      costUsd: undefined,
    });
    return getRun(ctx.ownerId, run.id);
  }
}

function classifyFailure(err: unknown, attempts: number): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof AppError ? err.errorCode : '';
  if (code === 'forbidden' || code === 'plugin_scope_denied' || message.toLowerCase().includes('permission') || message.toLowerCase().includes('scope')) {
    return 'blocked_permission';
  }
  if (code.startsWith('plugin_') || message.toLowerCase().includes('plugin')) return 'plugin_unavailable';
  if (code === 'not_found' || message.toLowerCase().includes('not found')) return 'dependency_failure';
  if (attempts >= 2) return 'repeated_failure';
  return 'dependency_failure';
}

/** Approval gate for a WAITING_FOR_APPROVAL automation run. */
export async function decideAutomationApproval(
  userId: string,
  runId: string,
  decision: 'APPROVE' | 'REJECT',
  reason?: string,
): Promise<RunResultRow> {
  const run = await getRun(userId, runId);
  if (run.status !== 'WAITING_FOR_APPROVAL' || !run.approval_id) {
    throw AppError.conflict('no_pending_approval', 'Automation run has no pending approval');
  }
  await decideApproval(userId, run.approval_id, decision, reason);
  if (decision === 'REJECT') {
    await updateRun(run.id, { status: 'CANCELLED', error: reason ?? 'approval_rejected', completed_at: new Date().toISOString() });
    await recordAudit({
      action: AuditAction.AUTOMATION_RUN_REJECTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'automation_run',
      resourceId: run.id,
      detail: { reason: reason ?? null, eventId: run.event_id },
    });
    return getRun(userId, run.id);
  }
  await recordAudit({
    action: AuditAction.AUTOMATION_RUN_APPROVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'automation_run',
    resourceId: run.id,
    detail: { reason: reason ?? null, eventId: run.event_id },
  });
  const rule = await getRuleById(userId, run.automation_id);
  const stored = (run.result as Record<string, unknown>);
  const ctx: EventContext = {
    source: run.event_source as EventSource,
    eventId: run.event_id,
    eventType: run.event_type,
    ownerId: userId,
    payload: (stored.payload as Record<string, unknown>) ?? {},
  };
  try {
    const templateCtx: TemplateContext = {
      payload: ctx.payload,
      event: { eventId: ctx.eventId, eventType: ctx.eventType, source: ctx.source },
    };
    const renderedActions = renderValue(rule.actions, templateCtx) as Array<Record<string, unknown>>;
    const executed = await executeActions(rule, run, renderedActions, ctx);
    await updateRun(run.id, {
      status: 'COMPLETED',
      result: JSON.stringify({ ...run.result, executed }),
      completed_at: new Date().toISOString(),
    });
    await pool.query(`UPDATE automation_rules SET last_run_status = 'COMPLETED', updated_at = now() WHERE id = $1`, [rule.id]);
    await recordAudit({
      action: AuditAction.AUTOMATION_RULE_RAN,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: userId,
      resourceType: 'automation_rule',
      resourceId: rule.id,
      detail: { eventId: ctx.eventId, runId: run.id, outcome: 'completed', approved: true },
    });
    await notify(userId, NotificationType.AUTOMATION_RUN_COMPLETED, `Automation completed: ${rule.name}`, {
      body: `Approved automation run for ${ctx.eventType} (${ctx.eventId}) completed.`,
      resourceType: 'automation_rule',
      resourceId: rule.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateRun(run.id, { status: 'FAILED', error: message, completed_at: new Date().toISOString() });
    await recordAudit({
      action: AuditAction.AUTOMATION_RULE_FAILED,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: userId,
      resourceType: 'automation_rule',
      resourceId: rule.id,
      detail: { eventId: ctx.eventId, runId: run.id, error: message, approved: true },
    });
    await notify(userId, NotificationType.AUTOMATION_RUN_FAILED, `Automation failed: ${rule.name}`, {
      body: message,
      resourceType: 'automation_rule',
      resourceId: rule.id,
    });
  }
  return getRun(userId, run.id);
}

async function getRuleById(userId: string, ruleId: string): Promise<AutomationRule> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM automation_rules WHERE id = $1 AND owner_id = $2', [ruleId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Automation rule');
  return rows[0] as unknown as AutomationRule;
}

/** Watchdog: expire processed event logs older than 7 days and reset stale rule budgets. */
export async function sweepAutomations(): Promise<{ expiredEvents: number; resetBudgets: number }> {
  const events = await pool.query(
    `DELETE FROM event_log WHERE created_at < now() - interval '7 days'`,
  );
  const budgets = await pool.query(
    `UPDATE automation_rules
        SET run_count = 0, run_count_reset_at = now(), updated_at = now()
      WHERE run_count_reset_at <= now() - interval '1 hour'`,
  );
  return { expiredEvents: events.rowCount ?? 0, resetBudgets: budgets.rowCount ?? 0 };
}