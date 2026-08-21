/**
 * CodeConClave — workflow recipes (Stage 26D).
 * Reusable templates: GitHub issue → agent → notification, Sentry error →
 * Debugger → task → approval, PR → Reviewer + Security + Tester, scheduled
 * check → agent → notification. Recipes are plain JSON templates with
 * {{payload.*}} placeholders; instantiating a recipe validates every
 * placeholder and copies it into a real, editable automation rule that still
 * flows through the existing plugin permission model and approval pipeline.
 */
import { pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { validatePlaceholders } from './templates.js';
import { createRule, type RuleInput } from './rules.js';

export interface WorkflowRecipe {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  event_source: string;
  event_type: string;
  conditions: Record<string, unknown>;
  template: Array<Record<string, unknown>>;
  system: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const SYSTEM_RECIPES: Array<Omit<WorkflowRecipe, 'id' | 'owner_id' | 'system' | 'version' | 'created_at' | 'updated_at'>> = [
  {
    name: 'GitHub issue → agent → notification',
    description: 'When a GitHub issue opens, dispatch a CODER agent to investigate and notify the workspace.',
    event_source: 'github',
    event_type: 'issue.opened',
    conditions: { 'payload.action': 'opened' },
    template: [
      { type: 'create_task', agentId: '{{payload.agentId}}', objective: 'Investigate and triage GitHub issue: {{payload.issue.title}}', description: 'Issue body: {{payload.issue.body}}' },
      { type: 'notify', notificationType: 'AUTOMATION_RUN_COMPLETED', title: 'Triage started for #{{payload.issue.number}}', body: '{{payload.issue.title}}' },
    ],
  },
  {
    name: 'Sentry error → Debugger → task → approval',
    description: 'When a new Sentry error fires, spawn a DEBUGGER task that requires approval before execution.',
    event_source: 'plugin',
    event_type: 'sentry.error',
    conditions: { 'payload.level': { op: 'in', value: ['error', 'fatal'] } },
    template: [
      { type: 'create_task', agentId: '{{payload.agentId}}', objective: 'Debug and fix Sentry error: {{payload.error.title}}', description: '{{payload.error.message}}', requireApproval: true },
      { type: 'notify', notificationType: 'AUTOMATION_RUN_FAILED', title: 'Sentry error triaged', body: '{{payload.error.title}}' },
    ],
  },
  {
    name: 'PR → Reviewer + Security + Tester',
    description: 'When a pull request opens, queue Reviewer, Security and Tester agents in sequence.',
    event_source: 'github',
    event_type: 'pull_request.opened',
    conditions: {},
    template: [
      { type: 'create_task', agentId: '{{payload.agentIdReviewer}}', objective: 'Review PR #{{payload.pull_request.number}}: {{payload.pull_request.title}}', role: 'REVIEWER' },
      { type: 'create_task', agentId: '{{payload.agentIdSecurity}}', objective: 'Security review of PR #{{payload.pull_request.number}}', role: 'SECURITY' },
      { type: 'create_task', agentId: '{{payload.agentIdTester}}', objective: 'Test PR #{{payload.pull_request.number}}', role: 'TESTER' },
      { type: 'notify', notificationType: 'AUTOMATION_RUN_COMPLETED', title: 'PR review pipeline started', body: '{{payload.pull_request.title}}' },
    ],
  },
  {
    name: 'Scheduled check → agent → notification',
    description: 'On every scheduled check execution, run an agent against the schedule title and notify.',
    event_source: 'schedule',
    event_type: 'schedule.executed',
    conditions: {},
    template: [
      { type: 'create_task', agentId: '{{payload.agentId}}', objective: 'Run scheduled check: {{payload.schedule.title}}' },
      { type: 'notify', notificationType: 'AUTOMATION_RUN_COMPLETED', title: 'Scheduled check ran', body: '{{payload.schedule.title}}' },
    ],
  },
];

function mapRecipe(row: Record<string, unknown>): WorkflowRecipe {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    event_source: String(row.event_source),
    event_type: String(row.event_type),
    conditions: (row.conditions as Record<string, unknown>) ?? {},
    template: Array.isArray(row.template) ? (row.template as Array<Record<string, unknown>>) : [],
    system: Boolean(row.system),
    version: Number(row.version ?? 1),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

/** Seed system recipes (idempotent, like the agent catalogue seed). */
export async function seedSystemRecipes(): Promise<void> {
  const existing = await queryMany<{ id: string }>(
    `SELECT id FROM workflow_recipes WHERE system = true AND owner_id = 'system' LIMIT 1`,
    [],
  );
  if (existing[0]) return;
  for (const r of SYSTEM_RECIPES) {
    const id = newId(PREFIX.WORKFLOW_RECIPE);
    await pool.query(
      `INSERT INTO workflow_recipes (id, owner_id, name, description, event_source, event_type, conditions, template, system)
       VALUES ($1,'system',$2,$3,$4,$5,$6::jsonb,$7::jsonb,true)`,
      [id, r.name, r.description, r.event_source, r.event_type, JSON.stringify(r.conditions), JSON.stringify(r.template)],
    );
  }
}

export async function listRecipes(userId: string): Promise<WorkflowRecipe[]> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM workflow_recipes
     WHERE owner_id = $1 OR (system = true AND owner_id = 'system')
     ORDER BY system ASC, name ASC`,
    [userId],
  );
  return rows.map(mapRecipe);
}

export async function getRecipe(userId: string, recipeId: string): Promise<WorkflowRecipe> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM workflow_recipes
     WHERE id = $1 AND (owner_id = $2 OR (system = true AND owner_id = 'system'))`,
    [recipeId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Workflow recipe');
  return mapRecipe(rows[0]);
}

export async function deleteRecipe(userId: string, recipeId: string): Promise<void> {
  const recipe = await getRecipe(userId, recipeId);
  if (recipe.system) throw AppError.conflict('system_recipe_readonly', 'System recipes cannot be deleted');
  await pool.query('DELETE FROM workflow_recipes WHERE id = $1 AND owner_id = $2', [recipeId, userId]);
  await recordAudit({
    action: AuditAction.WORKFLOW_RECIPE_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'workflow_recipe',
    resourceId: recipeId,
    detail: { name: recipe.name },
  });
}

/**
 * Instantiate a recipe into a real automation rule. Overrides let the caller
 * bind agents/projects; every template placeholder is validated before the
 * rule is created so a rule can never reference an unknown path.
 */
export async function instantiateRecipe(
  userId: string,
  recipeId: string,
  overrides: { name?: string; agentIds?: Record<string, string>; projectId?: string; requireApproval?: boolean } = {},
): Promise<ReturnType<typeof createRule>> {
  const recipe = await getRecipe(userId, recipeId);
  const actions = structuredClone(recipe.template);
  for (const a of actions) {
    if (overrides.agentIds) {
      for (const [key, value] of Object.entries(overrides.agentIds)) {
        if (typeof a.agentId === 'string') a.agentId = a.agentId.replace(`{{payload.${key}}}`, value);
      }
    }
  }
  validatePlaceholders(actions);
  validatePlaceholders(recipe.conditions);
  const input: RuleInput = {
    name: overrides.name ?? recipe.name,
    description: recipe.description ?? undefined,
    eventSource: recipe.event_source as RuleInput['eventSource'],
    eventType: recipe.event_type,
    conditions: recipe.conditions,
    actions,
    recipeId: recipe.id,
    projectId: overrides.projectId,
    requireApproval: overrides.requireApproval ?? recipe.template.some((a) => a.requireApproval === true),
  };
  const rule = await createRule(userId, input);
  await recordAudit({
    action: AuditAction.WORKFLOW_RECIPE_INSTANTIATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'workflow_recipe',
    resourceId: recipe.id,
    detail: { ruleId: rule.id, recipeName: recipe.name },
  });
  return rule;
}