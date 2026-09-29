/**
 * CodeConClave — Smart Escalation (Stage 26D).
 * A single, deduplicated escalation boundary for ANY failing work — goals,
 * schedules, automation runs or tasks. The decision UI renders context,
 * evidence, attempts, error, options, recommendation, risk and known cost from
 * the persisted escalation row. Decisions route goal escalations back through
 * the Stage 26C goal decision handler and handle automation/schedule/task
 * escalations here.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { setRuleStatus } from './rules.js';
import { setScheduleEnabled } from '../scheduling/service.js';
import type { EventContext } from './executor.js';

export type EscalationTriggerReason =
  | 'repeated_failure' | 'low_confidence' | 'blocked_permission' | 'budget_risk'
  | 'deadline_risk' | 'ambiguous_decision' | 'unavailable_dependency'
  | 'plugin_unavailable' | 'automation_escalation' | 'no_evidence';

export interface EscalationRow {
  id: string;
  owner_id: string;
  goal_id: string | null;
  schedule_id: string | null;
  automation_id: string | null;
  task_id: string | null;
  issue: string;
  evidence: Array<Record<string, unknown>>;
  attempted_actions: string[];
  options: string[];
  recommendation: string | null;
  risk: string;
  trigger_reason: string | null;
  cost_usd: number | null;
  status: string;
  user_decision: string | null;
  decision_note: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface EscalationInput {
  targetType: 'goal' | 'schedule' | 'automation' | 'task';
  targetId: string;
  triggerReason?: EscalationTriggerReason;
  issue: string;
  evidence?: Array<Record<string, unknown>>;
  attemptedActions?: string[];
  options?: string[];
  recommendation?: string;
  risk?: string;
  costUsd?: number;
}

function mapEscalation(row: Record<string, unknown>): EscalationRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    goal_id: row.goal_id ? String(row.goal_id) : null,
    schedule_id: row.schedule_id ? String(row.schedule_id) : null,
    automation_id: row.automation_id ? String(row.automation_id) : null,
    task_id: row.task_id ? String(row.task_id) : null,
    issue: String(row.issue),
    evidence: Array.isArray(row.evidence) ? (row.evidence as Array<Record<string, unknown>>) : [],
    attempted_actions: Array.isArray(row.attempted_actions) ? row.attempted_actions.map(String) : [],
    options: Array.isArray(row.options) ? row.options.map(String) : [],
    recommendation: row.recommendation ? String(row.recommendation) : null,
    risk: String(row.risk),
    trigger_reason: row.trigger_reason ? String(row.trigger_reason) : null,
    cost_usd: row.cost_usd != null ? Number(row.cost_usd) : null,
    status: String(row.status),
    user_decision: row.user_decision ? String(row.user_decision) : null,
    decision_note: row.decision_note ? String(row.decision_note) : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at as string) : null,
    created_at: new Date(row.created_at as string),
  };
}

const OPTIONS = ['APPROVE', 'REJECT', 'RETRY', 'EDIT_PLAN', 'PAUSE', 'CANCEL'];

/** Create an escalation with dedup: one OPEN escalation per target at a time. */
export async function smartEscalate(userId: string, input: EscalationInput): Promise<EscalationRow> {
  if (!input.issue.trim()) throw AppError.badRequest('issue_required', 'issue is required');
  const risk = input.risk ?? 'MEDIUM';
  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(risk)) throw AppError.badRequest('invalid_risk', 'Invalid risk level');

  const columns: string[] = ['id', 'owner_id', 'issue', 'evidence', 'attempted_actions', 'options', 'recommendation', 'risk', 'trigger_reason', 'cost_usd', 'status'];
  const params: unknown[] = [
    newId(PREFIX.ESCALATION), userId, input.issue.trim(),
    JSON.stringify(input.evidence ?? []), JSON.stringify(input.attemptedActions ?? []),
    JSON.stringify(input.options ?? OPTIONS), input.recommendation ?? null, risk,
    input.triggerReason ?? null, input.costUsd ?? null, 'OPEN',
  ];
  const targetCol: Partial<Record<EscalationInput['targetType'], string>> = {
    goal: 'goal_id', schedule: 'schedule_id', automation: 'automation_id', task: 'task_id',
  };
  const col = targetCol[input.targetType]!;
  const dupCheck = await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q
      .query<Record<string, unknown>>(
        `SELECT id FROM escalations WHERE owner_id = $1 AND status = 'OPEN' AND ${col} = $2 LIMIT 1`,
        [userId, input.targetId],
      )
      .then((r) => r.rows),
  );
  if (dupCheck[0]) {
    const existing = await getEscalation(userId, String(dupCheck[0].id));
    return existing;
  }

  columns.push(col);
  params.push(input.targetId);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO escalations (${columns.join(', ')}) VALUES (${placeholders})`,
      params,
    ),
  );
  const esc = await getEscalation(userId, String(params[0]));

  await recordAudit({
    action: AuditAction.AUTOMATION_ESCALATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'escalation',
    resourceId: esc.id,
    detail: { targetType: input.targetType, targetId: input.targetId, triggerReason: input.triggerReason ?? null, risk },
  });
  await notify(userId, NotificationType.AUTOMATION_ESCALATION_NEEDS_DECISION, `Automation needs a decision: ${input.issue}`, {
    body: input.issue,
    resourceType: 'escalation',
    resourceId: esc.id,
  });
  return esc;
}

export async function getEscalation(userId: string, escalationId: string): Promise<EscalationRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q
      .query<Record<string, unknown>>(
        'SELECT * FROM escalations WHERE id = $1 AND owner_id = $2', [escalationId, userId],
      )
      .then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Escalation');
  return mapEscalation(rows[0]);
}

export async function listEscalations(userId: string, status?: string): Promise<EscalationRow[]> {
  const params: unknown[] = [userId];
  let clause = '';
  if (status) {
    params.push(status);
    clause = `AND status = $${params.length}`;
  }
  const rows = await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q
      .query<Record<string, unknown>>(
        `SELECT * FROM escalations WHERE owner_id = $1 ${clause}
         ORDER BY (status = 'OPEN') DESC, created_at DESC LIMIT 100`,
        params,
      )
      .then((r) => r.rows),
  );
  return rows.map(mapEscalation);
}

function targetOf(esc: EscalationRow): { type: EscalationInput['targetType']; id: string } | null {
  if (esc.goal_id) return { type: 'goal', id: esc.goal_id };
  if (esc.automation_id) return { type: 'automation', id: esc.automation_id };
  if (esc.schedule_id) return { type: 'schedule', id: esc.schedule_id };
  if (esc.task_id) return { type: 'task', id: esc.task_id };
  return null;
}

async function markResolved(esc: EscalationRow, decision: string, note: string | null): Promise<void> {
  await withTenant(esc.owner_id, (q) =>
    q.query(
      `UPDATE escalations SET status = 'RESOLVED', user_decision = $2, decision_note = $3, resolved_at = now()
       WHERE id = $1 AND owner_id = $4`,
      [esc.id, decision, note, esc.owner_id],
    ),
  );
}

/** Re-run a failed automation for an event after deleting the failed run row. */
async function retryAutomation(esc: EscalationRow, userId: string): Promise<void> {
  if (!esc.automation_id) return;
  const eventCtx = esc.evidence.find((e) => e.kind === 'event_context') as
    | { source: string; eventId: string; eventType: string } | undefined;
  if (!eventCtx?.eventId) return;
  await withTenant(userId, (q) =>
    q.query(
      `DELETE FROM automation_runs WHERE automation_id = $1 AND event_id = $2 AND status = 'FAILED' AND owner_id = $3`,
      [esc.automation_id, eventCtx.eventId, userId],
    ),
  );
  const ctx: EventContext = {
    source: eventCtx.source as EventContext['source'],
    eventId: eventCtx.eventId,
    eventType: eventCtx.eventType,
    ownerId: userId,
    payload: (esc.evidence.find((e) => e.kind === 'event_context') as { payload?: Record<string, unknown> } | undefined)?.payload ?? {},
  };
  const { ingestEvent } = await import('./executor.js');
  await ingestEvent(ctx, { bypassDedup: true });
}

/**
 * Decide an escalation. Goal escalations are delegated to the Stage 26C
 * handler so goal semantics (plan edits, entry retries) stay unchanged.
 */
export async function decideEscalation(
  userId: string,
  escalationId: string,
  decision: string,
  note?: string,
): Promise<EscalationRow> {
  const esc = await getEscalation(userId, escalationId);
  if (esc.status !== 'OPEN') throw AppError.conflict('escalation_not_open', 'Escalation is not open');
  if (!OPTIONS.includes(decision)) throw AppError.badRequest('invalid_decision', `Decision must be one of ${OPTIONS.join(', ')}`);

  if (esc.goal_id) {
    const { decideEscalation: decideGoalEscalation } = await import('../scheduling/goals.js');
    return (await decideGoalEscalation(userId, escalationId, decision as 'APPROVE' | 'REJECT' | 'EDIT_PLAN' | 'RETRY' | 'PAUSE' | 'CANCEL', note)) as unknown as EscalationRow;
  }

  await markResolved(esc, decision, note ?? null);
  await recordAudit({
    action: AuditAction.AUTOMATION_ESCALATION_DECIDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'escalation',
    resourceId: esc.id,
    detail: { decision, note: note ?? null, targetType: targetOf(esc)?.type ?? null, targetId: targetOf(esc)?.id ?? null },
  });

  const target = targetOf(esc);
  if (target?.type === 'automation') {
    if (decision === 'RETRY' || decision === 'APPROVE') {
      await retryAutomation(esc, userId);
    } else if (decision === 'PAUSE' || decision === 'EDIT_PLAN') {
      await setRuleStatus(userId, target.id, 'PAUSED');
      await notify(userId, NotificationType.AUTOMATION_PAUSED, 'Automation paused', {
        body: `${decision === 'EDIT_PLAN' ? 'Edit the rule' : 'Paused'} after escalation ${escalationId}.`,
        resourceType: 'automation_rule',
        resourceId: target.id,
      });
    } else if (decision === 'REJECT' || decision === 'CANCEL') {
      await setRuleStatus(userId, target.id, 'DISABLED');
      await withTenant(userId, (q) =>
        q.query(
          `UPDATE automation_runs SET status = 'CANCELLED', completed_at = now()
           WHERE automation_id = $1 AND status IN ('RUNNING','WAITING_FOR_APPROVAL') AND owner_id = $2`,
          [target.id, userId],
        ),
      );
    }
  } else if (target?.type === 'schedule') {
    if (decision === 'REJECT' || decision === 'CANCEL') {
      await setScheduleEnabled(userId, target.id, false);
    }
  } else if (target?.type === 'task' && (decision === 'REJECT' || decision === 'CANCEL')) {
    const { cancelTask } = await import('../execution/tasks.js');
    await cancelTask(userId, target.id, note ?? 'escalation_rejected');
  }

  return getEscalation(userId, esc.id);
}

/** Watchdog: keep escalation scans cheap (re-export for scheduling sweep reuse). */
export async function openEscalationCount(userId: string): Promise<number> {
  const rows = await withTenant<{ n: number }[]>(userId, (q) =>
    q
      .query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM escalations WHERE owner_id = $1 AND status = $2',
        [userId, 'OPEN'],
      )
      .then((r) => r.rows),
  );
  return rows[0]?.n ?? 0;
}