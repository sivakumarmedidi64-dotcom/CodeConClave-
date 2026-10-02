/**
 * CodeConClave — automation rules (Stage 26D).
 * CRUD + lifecycle for event-driven automation rules. Every mutation is
 * audited and tenant-scoped. Rules never run by themselves — they are matched
 * by events.ts / executor.ts against real events from the existing scheduler,
 * task engine, plugins, deployments and webhooks.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';

export const EVENT_SOURCES = ['schedule', 'task_completed', 'github', 'plugin', 'deployment', 'webhook'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const RULE_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const TRIGGER_MODES = ['auto', 'manual'] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

export interface AutomationRule {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  status: RuleStatus;
  event_source: EventSource;
  event_type: string;
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  recipe_id: string | null;
  project_id: string | null;
  trigger_mode: TriggerMode;
  require_approval: boolean;
  max_runs_per_hour: number;
  cooldown_ms: number;
  run_count: number;
  run_count_reset_at: Date;
  last_run_at: Date | null;
  last_run_status: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RuleInput {
  name?: string;
  description?: string | null;
  eventSource?: EventSource;
  eventType?: string;
  conditions?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  recipeId?: string | null;
  projectId?: string | null;
  triggerMode?: TriggerMode;
  requireApproval?: boolean;
  maxRunsPerHour?: number;
  cooldownMs?: number;
}

const MAX_ACTIONS = 10;

export function rowToRule(row: Record<string, unknown>): AutomationRule {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    status: row.status as RuleStatus,
    event_source: row.event_source as EventSource,
    event_type: String(row.event_type),
    conditions: (row.conditions as Record<string, unknown>) ?? {},
    actions: Array.isArray(row.actions) ? (row.actions as Array<Record<string, unknown>>) : [],
    recipe_id: row.recipe_id ? String(row.recipe_id) : null,
    project_id: row.project_id ? String(row.project_id) : null,
    trigger_mode: (row.trigger_mode ?? 'auto') as TriggerMode,
    require_approval: Boolean(row.require_approval),
    max_runs_per_hour: Number(row.max_runs_per_hour ?? 10),
    cooldown_ms: Number(row.cooldown_ms ?? 0),
    run_count: Number(row.run_count ?? 0),
    run_count_reset_at: new Date(row.run_count_reset_at as string),
    last_run_at: row.last_run_at ? new Date(row.last_run_at as string) : null,
    last_run_status: row.last_run_status ? String(row.last_run_status) : null,
    last_error: row.last_error ? String(row.last_error) : null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

async function getOwnedRule(userId: string, ruleId: string): Promise<AutomationRule> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM automation_rules WHERE id = $1 AND owner_id = $2', [ruleId, userId],
    )).rows,
  );
  if (!rows[0]) throw AppError.notFound('Automation rule');
  return rowToRule(rows[0]);
}

function validateInput(input: RuleInput): void {
  if (!input.name?.trim()) throw AppError.badRequest('rule_name_required', 'Rule name is required');
  if (!input.eventSource || !EVENT_SOURCES.includes(input.eventSource)) {
    throw AppError.badRequest('invalid_event_source', `eventSource must be one of ${EVENT_SOURCES.join(', ')}`);
  }
  if (!input.eventType?.trim()) throw AppError.badRequest('event_type_required', 'eventType is required');
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > MAX_ACTIONS) {
    throw AppError.badRequest('invalid_actions', `actions must contain 1-${MAX_ACTIONS} entries`);
  }
  const known = new Set(['create_task', 'run_schedule', 'notify', 'plugin_action', 'escalate']);
  for (const a of input.actions) {
    if (!a || typeof a !== 'object' || !known.has(String(a.type))) {
      throw AppError.badRequest('invalid_action', `Unsupported action type in actions`);
    }
  }
  if (input.triggerMode !== undefined && !TRIGGER_MODES.includes(input.triggerMode)) {
    throw AppError.badRequest('invalid_trigger_mode', `triggerMode must be one of ${TRIGGER_MODES.join(', ')}`);
  }
  if (input.requireApproval !== undefined && typeof input.requireApproval !== 'boolean') {
    throw AppError.badRequest('invalid_require_approval', 'requireApproval must be a boolean');
  }
  if (input.maxRunsPerHour !== undefined && (!Number.isInteger(input.maxRunsPerHour) || input.maxRunsPerHour < 1 || input.maxRunsPerHour > 10000)) {
    throw AppError.badRequest('invalid_max_runs', 'maxRunsPerHour must be an integer between 1 and 10000');
  }
  if (input.cooldownMs !== undefined && (!Number.isInteger(input.cooldownMs) || input.cooldownMs < 0)) {
    throw AppError.badRequest('invalid_cooldown', 'cooldownMs must be a non-negative integer');
  }
}

function jsonb(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

export async function createRule(userId: string, input: RuleInput): Promise<AutomationRule> {
  const { assertAutonomyEnabled } = await import('../control/killSwitch.js');
  await assertAutonomyEnabled(userId, 'AUTONOMY');
  validateInput(input);
  const id = newId(PREFIX.AUTOMATION_RULE);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO automation_rules
         (id, owner_id, name, description, status, event_source, event_type, conditions, actions,
          recipe_id, project_id, trigger_mode, require_approval, max_runs_per_hour, cooldown_ms)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
      [
        id, userId, input.name!.trim(), input.description ?? null,
        input.eventSource, input.eventType!.trim(), jsonb(input.conditions ?? {}), jsonb(input.actions!),
        input.recipeId ?? null, input.projectId ?? null, input.triggerMode ?? 'auto',
        input.requireApproval ?? false, input.maxRunsPerHour ?? 10, input.cooldownMs ?? 60_000,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.AUTOMATION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'automation_rule',
    resourceId: id,
    detail: { eventSource: input.eventSource, eventType: input.eventType, actions: input.actions!.length, triggerMode: input.triggerMode ?? 'auto' },
  });
  return getOwnedRule(userId, id);
}

export async function updateRule(userId: string, ruleId: string, input: Partial<RuleInput>): Promise<AutomationRule> {
  const existing = await getOwnedRule(userId, ruleId);
  validateInput({
    name: input.name ?? existing.name,
    eventSource: input.eventSource ?? existing.event_source,
    eventType: input.eventType ?? existing.event_type,
    actions: input.actions ?? existing.actions,
    conditions: input.conditions ?? existing.conditions,
    triggerMode: input.triggerMode ?? existing.trigger_mode,
    requireApproval: input.requireApproval ?? existing.require_approval,
    maxRunsPerHour: input.maxRunsPerHour ?? existing.max_runs_per_hour,
    cooldownMs: input.cooldownMs ?? existing.cooldown_ms,
  });
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE automation_rules SET
         name = $2, description = $3, event_source = $4, event_type = $5,
         conditions = $6::jsonb, actions = $7::jsonb, project_id = $8,
         trigger_mode = $9, require_approval = $10, max_runs_per_hour = $11,
         cooldown_ms = $12, updated_at = now()
       WHERE id = $1 AND owner_id = $13`,
      [
        ruleId, input.name?.trim() ?? existing.name, input.description ?? existing.description,
        input.eventSource ?? existing.event_source, input.eventType ?? existing.event_type,
        jsonb(input.conditions ?? existing.conditions), jsonb(input.actions ?? existing.actions),
        input.projectId ?? existing.project_id, input.triggerMode ?? existing.trigger_mode,
        input.requireApproval ?? existing.require_approval, input.maxRunsPerHour ?? existing.max_runs_per_hour,
        input.cooldownMs ?? existing.cooldown_ms, userId,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.AUTOMATION_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'automation_rule',
    resourceId: ruleId,
    detail: { fields: Object.keys(input) },
  });
  return getOwnedRule(userId, ruleId);
}

export async function setRuleStatus(userId: string, ruleId: string, status: RuleStatus): Promise<AutomationRule> {
  const rule = await getOwnedRule(userId, ruleId);
  if (rule.status === status) return rule;
  if (status === 'ACTIVE' && rule.status === 'DISABLED') {
    // Re-enabling resets the loop budget so a previously throttled rule starts fresh.
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE automation_rules SET status = $2, run_count = 0, run_count_reset_at = now(), last_error = NULL, updated_at = now()
         WHERE id = $1 AND owner_id = $3`,
        [ruleId, status, userId],
      ),
    );
  } else {
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE automation_rules SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
        [ruleId, status, userId],
      ),
    );
  }
  const action =
    status === 'ACTIVE' ? AuditAction.AUTOMATION_ENABLED
      : status === 'PAUSED' ? AuditAction.AUTOMATION_PAUSED
        : AuditAction.AUTOMATION_DISABLED;
  await recordAudit({
    action,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'automation_rule',
    resourceId: ruleId,
    detail: { from: rule.status, to: status },
  });
  return getOwnedRule(userId, ruleId);
}

export async function deleteRule(userId: string, ruleId: string): Promise<void> {
  const rule = await getOwnedRule(userId, ruleId);
  await withTenant(userId, (q) =>
    q.query('DELETE FROM automation_rules WHERE id = $1 AND owner_id = $2', [ruleId, userId]),
  );
  await recordAudit({
    action: AuditAction.AUTOMATION_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'automation_rule',
    resourceId: ruleId,
    detail: { name: rule.name, eventSource: rule.event_source, eventType: rule.event_type },
  });
}

export async function listRules(userId: string, includeDisabled = false): Promise<AutomationRule[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      `SELECT * FROM automation_rules
       WHERE owner_id = $1 ${includeDisabled ? '' : "AND status = 'ACTIVE'"}
       ORDER BY created_at DESC`,
      [userId],
    )).rows,
  );
  return rows.map(rowToRule);
}

export async function listRuleRuns(userId: string, ruleId: string, limit = 50): Promise<Record<string, unknown>[]> {
  return withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      `SELECT * FROM automation_runs WHERE automation_id = $1 AND owner_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [ruleId, userId, Math.min(Math.max(limit, 1), 200)],
    )).rows,
  );
}

export { getOwnedRule };