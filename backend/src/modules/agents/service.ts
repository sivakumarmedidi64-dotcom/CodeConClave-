/**
 * CodeConClave - multi-agent workspace (Stage 25.5).
 *
 * Specialized AI agents collaborate through the EXISTING planner -> task graph
 * -> permissions -> approval -> execution -> audit -> memory -> verification
 * pipeline. An agent run fans out into bounded tasks (tasks.agent_run_id);
 * tasks are claimed and executed by the existing worker; the run's lifecycle
 * (THINKING -> RUNNING -> WAITING_FOR_APPROVAL / WAITING_FOR_DEPENDENCY ->
 * COMPLETED / FAILED / BLOCKED) is accounted from real task transitions.
 *
 * Bounds enforced server-side: max_tasks_per_run (fan-out cap), max_retries
 * (run-level retry budget), budget_usd (spent from model_usage_logs of the
 * run's tasks), deadline_at (hard wall clock). No infinite loops: every
 * transition is terminal-driven and every bound is checked on every
 * accounting tick.
 *
 * Model selection is role-routed through the gateway (existing eligibility:
 * entitlement, health, capabilities, budget) - an agent's model_id must be in
 * the eligible set; otherwise routing picks the ranked eligible model.
 */
import { pool, queryMany, queryOne } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, NotificationType, AgentTrustLevel, AGENT_TRUST_LABELS } from '@codeconclave/shared';
import type { PlanId, AgentTrustLevel as AgentTrustLevelType } from '@codeconclave/shared';
import { notify } from '../notifications/service.js';
import { createMemory } from '../memory/service.js';
import { createTask, setTaskStatus, addTaskDependency } from '../execution/tasks.js';
import { eligibleModels } from '../ai/gateway.js';
import { FREE_LIMITS, PRO_LIMITS, TEAM_LIMITS, effectivePlan } from '../entitlements/service.js';

export const AGENT_ROLES = [
  'ARCHITECT',
  'CODER',
  'DEBUGGER',
  'RESEARCHER',
  'REVIEWER',
  'TESTER',
  'SECURITY',
  'DEVOPS',
  'UI_UX',
  'DOCUMENTATION',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_TRUST_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type AgentTrustLevelValue = (typeof AGENT_TRUST_LEVELS)[number];

/** Plan maximum trust (server-authoritative policy). Effective trust is
 *  min(stored, plan max) — computed at every enforcement point, never by the
 *  client. */
export const MAX_TRUST_BY_PLAN: Record<PlanId, AgentTrustLevelValue> = {
  free: 'L1',
  pro: 'L3',
  team: 'L3',
  enterprise: 'L4',
};

export function validTrustLevel(level: string): level is AgentTrustLevelValue {
  return (AGENT_TRUST_LEVELS as readonly string[]).includes(level);
}

export function clampTrust(stored: string, planMax: AgentTrustLevelValue): AgentTrustLevelValue {
  if (!validTrustLevel(stored)) return planMax;
  const order = AGENT_TRUST_LEVELS;
  return order[Math.min(order.indexOf(stored as AgentTrustLevelValue), order.indexOf(planMax))] ?? planMax;
}

/** Effective trust for an agent, clamped by the user's plan. */
export async function effectiveTrustLevel(userId: string, stored: string): Promise<AgentTrustLevelValue> {
  const plan = await effectivePlan(userId);
  return clampTrust(stored, MAX_TRUST_BY_PLAN[plan]);
}

export const AGENT_RUN_STATES = [
  'IDLE',
  'THINKING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'WAITING_FOR_DEPENDENCY',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
] as const;

/** Role -> gateway routing (existing RouteOptions surface). */
export const ROLE_ROUTING: Record<AgentRole, { computeClass: 'A' | 'B' | 'C'; coding: boolean; label: string; description: string }> = {
  ARCHITECT: { computeClass: 'C', coding: false, label: 'Architect', description: 'System design and architecture planning' },
  CODER: { computeClass: 'B', coding: true, label: 'Coder', description: 'Implements changes from designs' },
  DEBUGGER: { computeClass: 'B', coding: true, label: 'Debugger', description: 'Diagnoses and fixes failures' },
  RESEARCHER: { computeClass: 'A', coding: false, label: 'Researcher', description: 'Gathers facts and context' },
  REVIEWER: { computeClass: 'C', coding: false, label: 'Reviewer', description: 'Independent review of diffs and outputs' },
  TESTER: { computeClass: 'B', coding: false, label: 'Tester', description: 'Generates and runs tests' },
  SECURITY: { computeClass: 'C', coding: false, label: 'Security', description: 'Threat model and secret hygiene' },
  DEVOPS: { computeClass: 'B', coding: true, label: 'DevOps', description: 'Build, deploy and operations' },
  UI_UX: { computeClass: 'A', coding: false, label: 'UI/UX', description: 'Interface and experience design' },
  DOCUMENTATION: { computeClass: 'A', coding: false, label: 'Documentation', description: 'Docs, runbooks and handoffs' },
};

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  role: string;
  objective: string | null;
  capabilities: string[];
  model_provider: string | null;
  model_id: string | null;
  max_tasks_per_run: number;
  max_retries: number;
  status: string;
  current_run_id: string | null;
  trust_level: string;
  /** Server-derived: stored intent clamped by the owner's plan. */
  effective_trust_level?: AgentTrustLevelValue;
  created_at: Date;
  updated_at: Date;
}

export interface AgentRunRow {
  id: string;
  agent_id: string;
  owner_id: string;
  project_id: string | null;
  status: string;
  objective: string | null;
  current_task_id: string | null;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  retries_used: number;
  budget_usd: number;
  spent_usd: number;
  deadline_at: Date | null;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export function validAgentRole(role: string): role is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(role);
}

function validAgentState(state: string): boolean {
  return (AGENT_RUN_STATES as readonly string[]).includes(state);
}

async function limitsFor(userId: string): Promise<{ MAX_AGENTS: number; AGENT_MAX_TASKS_PER_RUN: number; AGENT_MAX_BUDGET_USD: number }> {
  const plan = await effectivePlan(userId);
  return plan === 'pro' ? PRO_LIMITS : plan === 'team' ? TEAM_LIMITS : FREE_LIMITS;
}

// ---------------------------------------------------------------- CRUD

export async function listAgents(userId: string): Promise<AgentRow[]> {
  const rows = await queryMany<AgentRow>(
    `SELECT a.*, r.status AS run_status, r.objective AS run_objective, r.completed_tasks, r.total_tasks, r.failed_tasks, r.spent_usd
     FROM ai_agents a
     LEFT JOIN ai_agent_runs r ON r.id = a.current_run_id
     WHERE a.owner_id = $1 ORDER BY a.created_at DESC`,
    [userId],
  );
  const planMax = MAX_TRUST_BY_PLAN[await effectivePlan(userId)];
  for (const row of rows) row.effective_trust_level = clampTrust(row.trust_level ?? 'L2', planMax);
  return rows;
}

export async function getAgent(userId: string, agentId: string): Promise<AgentRow> {
  const rows = await queryMany<AgentRow>('SELECT * FROM ai_agents WHERE id = $1 AND owner_id = $2', [agentId, userId]);
  if (!rows[0]) throw AppError.notFound('Agent');
  const agent = rows[0];
  agent.effective_trust_level = clampTrust(agent.trust_level ?? 'L2', MAX_TRUST_BY_PLAN[await effectivePlan(userId)]);
  return agent;
}

async function assertModelEligible(userId: string, role: AgentRole, modelId: string | null | undefined): Promise<{ modelId: string | null }> {
  if (!modelId) return { modelId: null };
  const routing = ROLE_ROUTING[role];
  const eligible = await eligibleModels(userId, { computeClass: routing.computeClass, coding: routing.coding });
  const match = eligible.find((m) => m.modelId === modelId);
  if (!match) {
    throw AppError.badRequest(
      'model_not_eligible',
      `Model ${modelId} is not eligible for role ${role} (not configured, unhealthy, or below entitlement/capability).`,
    );
  }
  return { modelId: match.modelId };
}

export async function createAgent(
  userId: string,
  input: {
    name: string;
    role: string;
    objective?: string;
    capabilities?: string[];
    modelProvider?: string | null;
    modelId?: string | null;
    maxTasksPerRun?: number;
    maxRetries?: number;
    trustLevel?: string;
  },
): Promise<AgentRow> {
  if (!validAgentRole(input.role)) throw AppError.badRequest('invalid_agent_role', `Unknown agent role: ${input.role}`);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw AppError.badRequest('agent_name_required', 'Agent name is required');
  const limits = await limitsFor(userId);
  const existing = await queryMany<{ n: number }>('SELECT count(*)::int AS n FROM ai_agents WHERE owner_id = $1', [userId]);
  if ((existing[0]?.n ?? 0) >= limits.MAX_AGENTS) {
    throw AppError.badRequest('agent_limit_reached', `Plan allows at most ${limits.MAX_AGENTS} agents`);
  }
  const { modelId } = await assertModelEligible(userId, input.role, input.modelId);
  const maxTasks = Math.min(Math.max(input.maxTasksPerRun ?? 3, 1), 20, limits.AGENT_MAX_TASKS_PER_RUN);
  const maxRetries = Math.min(Math.max(input.maxRetries ?? 1, 0), 5);
  // Trust is server-clamped by plan on create; the stored value is the intent,
  // the effective value is derived at every enforcement point.
  const plan = await effectivePlan(userId);
  const planMax = MAX_TRUST_BY_PLAN[plan];
  const trustLevel = clampTrust(input.trustLevel ?? 'L2', planMax);
  const id = newId(PREFIX.AGENT);
  await pool.query(
    `INSERT INTO ai_agents (id, owner_id, name, role, objective, capabilities, model_provider, model_id, max_tasks_per_run, max_retries, trust_level)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
    [
      id,
      userId,
      name,
      input.role,
      input.objective?.trim().slice(0, 2000) ?? null,
      JSON.stringify(Array.isArray(input.capabilities) ? input.capabilities.slice(0, 20) : []),
      input.modelProvider ?? null,
      modelId,
      maxTasks,
      maxRetries,
      trustLevel,
    ],
  );
  const row = (await queryMany<AgentRow>('SELECT * FROM ai_agents WHERE id = $1', [id]))[0] ?? {
    id,
    owner_id: userId,
    name,
    role: input.role,
    objective: input.objective?.trim().slice(0, 2000) ?? null,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities.slice(0, 20) : [],
    model_provider: input.modelProvider ?? null,
    model_id: modelId,
    max_tasks_per_run: maxTasks,
    max_retries: maxRetries,
    status: 'IDLE',
    current_run_id: null,
    trust_level: trustLevel,
    created_at: new Date(),
    updated_at: new Date(),
  };
  row.effective_trust_level = trustLevel;
  await recordAudit({
    action: AuditAction.AGENT_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ai_agent',
    resourceId: id,
    detail: { role: input.role, modelId, trustLevel },
  });
  return row;
}

/** Change an agent's trust level. Owner-only, audited, server-clamped: a
 *  request above the plan maximum is rejected (never silently downgraded). */
export async function setAgentTrust(userId: string, agentId: string, level: string): Promise<AgentRow> {
  const agent = await getAgent(userId, agentId);
  if (!validTrustLevel(level)) {
    throw AppError.badRequest('invalid_trust_level', `Unknown trust level: ${level}`);
  }
  const planMax = MAX_TRUST_BY_PLAN[await effectivePlan(userId)];
  if (AGENT_TRUST_LEVELS.indexOf(level as AgentTrustLevelValue) > AGENT_TRUST_LEVELS.indexOf(planMax)) {
    throw AppError.badRequest(
      'trust_above_plan',
      `Trust level ${level} exceeds the maximum for your plan (${planMax}).`,
    );
  }
  await pool.query('UPDATE ai_agents SET trust_level = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', [level, agentId, userId]);
  await recordAudit({
    action: AuditAction.AGENT_TRUST_CHANGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ai_agent',
    resourceId: agentId,
    detail: { from: agent.trust_level ?? 'L2', to: level },
  });
  return getAgent(userId, agentId);
}

export async function updateAgent(
  userId: string,
  agentId: string,
  input: { name?: string; objective?: string; capabilities?: string[]; modelId?: string | null; maxTasksPerRun?: number; maxRetries?: number },
): Promise<AgentRow> {
  const agent = await getAgent(userId, agentId);
  const role = agent.role as AgentRole;
  const fields: string[] = ['updated_at = now()'];
  const params: unknown[] = [agentId, userId];
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 120);
    if (!name) throw AppError.badRequest('agent_name_required', 'Agent name is required');
    params.push(name);
    fields.push(`name = $${params.length}`);
  }
  if (input.objective !== undefined) {
    params.push(input.objective.trim().slice(0, 2000) || null);
    fields.push(`objective = $${params.length}`);
  }
  if (input.capabilities !== undefined) {
    params.push(JSON.stringify(input.capabilities.slice(0, 20)));
    fields.push(`capabilities = $${params.length}::jsonb`);
  }
  if (input.modelId !== undefined) {
    const { modelId } = await assertModelEligible(userId, role, input.modelId);
    params.push(modelId);
    fields.push(`model_id = $${params.length}`);
    const modelProvider = modelId ? (await getModelProvider(modelId)) : null;
    params.push(modelProvider);
    fields.push(`model_provider = $${params.length}`);
  }
  if (input.maxTasksPerRun !== undefined) {
    const limits = await limitsFor(userId);
    params.push(Math.min(Math.max(input.maxTasksPerRun, 1), 20, limits.AGENT_MAX_TASKS_PER_RUN));
    fields.push(`max_tasks_per_run = $${params.length}`);
  }
  if (input.maxRetries !== undefined) {
    params.push(Math.min(Math.max(input.maxRetries, 0), 5));
    fields.push(`max_retries = $${params.length}`);
  }
  await pool.query(`UPDATE ai_agents SET ${fields.join(', ')} WHERE id = $1 AND owner_id = $2`, params);
  await recordAudit({
    action: AuditAction.AGENT_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ai_agent',
    resourceId: agentId,
    detail: { role, fields: fields.filter((f) => !f.includes('updated_at')) },
  });
  return getAgent(userId, agentId);
}

async function getModelProvider(modelId: string): Promise<string | null> {
  const rows = await queryMany<{ provider_id: string }>('SELECT provider_id FROM ai_model_registry WHERE model_id = $1', [modelId]);
  return rows[0]?.provider_id ?? null;
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  const agent = await getAgent(userId, agentId);
  if (agent.status !== 'IDLE' && agent.current_run_id) {
    throw AppError.conflict('agent_busy', 'Agent has an active run; cancel or wait for it to finish');
  }
  await pool.query('DELETE FROM ai_agents WHERE id = $1 AND owner_id = $2', [agentId, userId]);
  await recordAudit({
    action: AuditAction.AGENT_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ai_agent',
    resourceId: agentId,
    detail: { role: agent.role },
  });
}

// ---------------------------------------------------------------- runs

export async function listRuns(userId: string, agentId?: string): Promise<AgentRunRow[]> {
  const agentClause = agentId ? 'AND agent_id = $2' : '';
  const params: unknown[] = [userId];
  if (agentId) params.push(agentId);
  return queryMany<AgentRunRow>(
    `SELECT * FROM ai_agent_runs WHERE owner_id = $1 ${agentClause} ORDER BY created_at DESC LIMIT 50`,
    params,
  );
}

export async function getRun(userId: string, runId: string): Promise<AgentRunRow> {
  const rows = await queryMany<AgentRunRow>('SELECT * FROM ai_agent_runs WHERE id = $1 AND owner_id = $2', [runId, userId]);
  if (!rows[0]) throw AppError.notFound('AgentRun');
  return rows[0];
}

export async function getRunInternal(runId: string): Promise<AgentRunRow> {
  const rows = await queryMany<AgentRunRow>('SELECT * FROM ai_agent_runs WHERE id = $1', [runId]);
  if (!rows[0]) throw AppError.notFound('AgentRun');
  return rows[0];
}

async function setRunState(runId: string, status: string, error?: string | null): Promise<void> {
  const fields: string[] = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [runId, status];
  if (status === 'RUNNING' || status === 'THINKING') fields.push('started_at = COALESCE(started_at, now())');
  if (['COMPLETED', 'FAILED', 'BLOCKED'].includes(status)) fields.push('completed_at = now()');
  if (error !== undefined) {
    params.push(error);
    fields.push(`error = $${params.length}`);
  }
  await pool.query(`UPDATE ai_agent_runs SET ${fields.join(', ')} WHERE id = $1`, params);
}

export async function startRun(
  userId: string,
  agentId: string,
  input: { projectId?: string; objective?: string; subtasks?: { title: string; description?: string }[]; budgetUsd?: number; deadlineMinutes?: number; requireApproval?: boolean },
): Promise<AgentRunRow> {
  const { assertAutonomyEnabled } = await import('../control/killSwitch.js');
  await assertAutonomyEnabled(userId, 'AGENTS');
  const agent = await getAgent(userId, agentId);
  if (agent.status !== 'IDLE') throw AppError.conflict('agent_busy', 'Agent already has an active run');
  // Marketplace agents that are disabled must not execute (server-authoritative).
  const { assertInstalledAgentEnabled } = await import('./marketplace.js');
  await assertInstalledAgentEnabled(userId, agentId);
  const limits = await limitsFor(userId);
  const objective = input.objective?.trim().slice(0, 2000);
  if (!objective) throw AppError.badRequest('objective_required', 'An objective is required');

  // Trust enforcement: an UNMANAGED (L0) agent never auto-executes — every
  // task it produces is approval-gated (HIGH risk). The effective level is
  // server-derived from stored intent clamped by the plan.
  const trustLevel = await effectiveTrustLevel(userId, agent.trust_level ?? 'L2');

  if (input.projectId) {
    const projects = await queryMany<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
      [input.projectId, userId],
    );
    if (!projects[0]) throw AppError.notFound('Project');
  }

  // Fan-out: bounded by the agent's max_tasks_per_run AND the plan limit.
  const subtasks = (input.subtasks ?? [{ title: objective }])
    .slice(0, Math.min(agent.max_tasks_per_run, limits.AGENT_MAX_TASKS_PER_RUN))
    .map((s, i) => ({ title: (s.title ?? objective).trim().slice(0, 200) || `Step ${i + 1}: ${objective}`, description: s.description?.trim().slice(0, 2000) ?? null }));

  const runId = newId(PREFIX.AGENT_RUN);
  const budget = Math.min(input.budgetUsd ?? limits.AGENT_MAX_BUDGET_USD, Math.max(limits.AGENT_MAX_BUDGET_USD, 0.1));
  const deadlineMinutes = Math.min(Math.max(input.deadlineMinutes ?? 120, 5), 24 * 60);
  const deadlineAt = new Date(Date.now() + deadlineMinutes * 60_000);
  await pool.query(
    `INSERT INTO ai_agent_runs (id, agent_id, owner_id, project_id, status, objective, total_tasks, budget_usd, deadline_at)
     VALUES ($1,$2,$3,$4,'THINKING',$5,$6,$7, now() + make_interval(mins => $8))`,
    [runId, agentId, userId, input.projectId ?? null, objective, subtasks.length, budget, deadlineMinutes],
  );

  // Create the run's tasks through the EXISTING task engine (permissions,
  // approvals, audit, notifications all inherited). Sequential dependency
  // chain gives WAITING_FOR_DEPENDENCY naturally.
  let previousTaskId: string | null = null;
  const taskIds: string[] = [];
  for (const [i, subtask] of subtasks.entries()) {
    const task = await createTask({
      userId,
      projectId: input.projectId ?? (await defaultProjectId(userId)),
      title: subtask.title,
      description: subtask.description ?? objective,
      riskLevel: input.requireApproval || trustLevel === 'L0' ? 'HIGH' : 'MEDIUM',
      maxAttempts: Math.min(agent.max_retries + 1, 5),
      priority: 100 - i,
    });
    await pool.query(`UPDATE tasks SET agent_run_id = $1 WHERE id = $2`, [runId, task.id]);
    if (previousTaskId) await addTaskDependency(task.id, previousTaskId);
    previousTaskId = task.id;
    taskIds.push(task.id);
  }

  await setRunState(runId, 'RUNNING');
  await pool.query(`UPDATE ai_agents SET status = 'RUNNING', current_run_id = $1 WHERE id = $2`, [runId, agentId]);
  await recordAudit({
    action: AuditAction.AGENT_RUN_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ai_agent_run',
    resourceId: runId,
    detail: { agentId, tasks: taskIds.length, budgetUsd: budget, trustLevel },
  });
  const now = new Date();
  return {
    id: runId,
    agent_id: agentId,
    owner_id: userId,
    project_id: input.projectId ?? null,
    status: 'RUNNING',
    objective,
    current_task_id: null,
    total_tasks: subtasks.length,
    completed_tasks: 0,
    failed_tasks: 0,
    retries_used: 0,
    budget_usd: budget,
    spent_usd: 0,
    deadline_at: deadlineAt,
    error: null,
    started_at: now,
    completed_at: null,
    created_at: now,
  };
}

async function defaultProjectId(userId: string): Promise<string> {
  const rows = await queryMany<{ id: string }>(
    'SELECT id FROM projects WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
    [userId],
  );
  if (!rows[0]) throw AppError.badRequest('project_required', 'Agent runs require a project (create one first)');
  return rows[0].id;
}

export async function cancelRun(userId: string, runId: string): Promise<AgentRunRow> {
  const run = await getRun(userId, runId);
  if (['COMPLETED', 'FAILED', 'BLOCKED'].includes(run.status)) throw AppError.conflict('run_terminal', 'Run is already terminal');
  const tasks = await runTasks(runId);
  for (const task of tasks) {
    if (['CREATED', 'PLANNED', 'WAITING_APPROVAL', 'WAITING_FOR_LOCAL_AGENT'].includes(task.status)) {
      await setTaskStatus(task.id, 'CANCELLED', 'cancelled_by_user').catch(() => undefined);
    }
  }
  await setRunState(runId, 'FAILED', 'cancelled_by_user');
  await pool.query(`UPDATE ai_agents SET status = 'IDLE', current_run_id = NULL WHERE id = $1`, [run.agent_id]);
  await recordAudit({
    action: AuditAction.AGENT_RUN_CANCELLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ai_agent_run',
    resourceId: runId,
    detail: { agentId: run.agent_id },
  });
  return { ...run, status: 'FAILED', error: 'cancelled_by_user', completed_at: new Date() };
}

export async function runTasks(runId: string): Promise<Array<{ id: string; status: string; title: string; attempted: boolean }>> {
  return queryMany<{ id: string; status: string; title: string; attempted: boolean }>(
    `SELECT id, status, title, (attempt_count > 0) AS attempted FROM tasks WHERE agent_run_id = $1 ORDER BY priority DESC, created_at ASC`,
    [runId],
  );
}

async function runSpend(runId: string): Promise<number> {
  const rows = await queryMany<{ total: string }>(
    `SELECT COALESCE(SUM(m.estimated_cost_usd),0) AS total
     FROM model_usage_logs m JOIN tasks t ON t.id = m.task_id
     WHERE t.agent_run_id = $1`,
    [runId],
  );
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------- accounting hook
/**
 * Called by the task engine whenever a task belonging to an agent run changes
 * to a significant status (created/approval/terminal). Recomputed run state is
 * authoritative; bounds are enforced on every tick. Never throws: accounting
 * must never break the task engine.
 */
export async function agentTaskChanged(taskId: string): Promise<void> {
  try {
    const rows = await queryMany<{ agent_run_id: string | null }>(
      'SELECT agent_run_id FROM tasks WHERE id = $1 AND agent_run_id IS NOT NULL',
      [taskId],
    );
    if (!rows[0]?.agent_run_id) return;
    await recomputeRun(rows[0].agent_run_id);
  } catch (err) {
    // Accounting is best-effort; the task engine is the source of truth.
  }
}

export async function recomputeRun(runId: string): Promise<void> {
  const run = await getRunInternal(runId).catch(() => null);
  if (!run || ['COMPLETED', 'FAILED', 'BLOCKED'].includes(run.status)) return;
  const agent = await queryOne<AgentRow>('SELECT * FROM ai_agents WHERE id = $1', [run.agent_id]);
  if (!agent) return;
  const tasks = await runTasks(runId);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
  const failed = tasks.filter((t) => ['FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED'].includes(t.status)).length;
  const waitingApproval = tasks.find((t) => t.status === 'WAITING_APPROVAL');
  const pendingWithDeps = tasks.find((t) => t.status === 'CREATED' || t.status === 'PLANNED');
  const retriesUsed = tasks.filter((t) => t.attempted).length;
  const spent = await runSpend(runId);
  const deadlinePassed = run.deadline_at !== null && run.deadline_at.getTime() <= Date.now();
  const overBudget = spent > run.budget_usd;
  const overRetries = agent.max_retries > 0 && retriesUsed > agent.max_retries;

  await pool.query(
    `UPDATE ai_agent_runs SET completed_tasks = $2, failed_tasks = $3, retries_used = $4, spent_usd = $5 WHERE id = $1`,
    [runId, completed, failed, Math.max(0, retriesUsed - 1), spent],
  );

  let nextStatus: string;
  let error: string | null = null;
  if (deadlinePassed) {
    nextStatus = 'BLOCKED';
    error = 'deadline_exceeded';
  } else if (overBudget) {
    nextStatus = 'BLOCKED';
    error = 'budget_exceeded';
  } else if (overRetries) {
    nextStatus = 'BLOCKED';
    error = 'retry_budget_exceeded';
  } else if (completed + failed >= total && total > 0) {
    nextStatus = failed > 0 && completed === 0 ? 'FAILED' : failed > 0 && completed < total ? 'RUNNING' : failed > 0 ? 'FAILED' : 'COMPLETED';
    if (nextStatus === 'FAILED') error = 'task_failed';
  } else if (waitingApproval) {
    nextStatus = 'WAITING_FOR_APPROVAL';
  } else if (pendingWithDeps) {
    nextStatus = 'RUNNING';
  } else if (total === 0) {
    nextStatus = 'COMPLETED';
    error = 'no_tasks';
  } else {
    nextStatus = 'RUNNING';
  }

  if (nextStatus !== run.status) {
    await setRunState(runId, nextStatus, error);
    const terminal = nextStatus === 'COMPLETED' || nextStatus === 'FAILED' || nextStatus === 'BLOCKED';
    await pool.query(
      terminal
        ? `UPDATE ai_agents SET status = 'IDLE', current_run_id = NULL, updated_at = now() WHERE id = $1`
        : `UPDATE ai_agents SET status = $2, updated_at = now() WHERE id = $1`,
      terminal ? [agent.id] : [agent.id, nextStatus],
    );
    if (terminal) {
      await notify(
        run.owner_id,
        nextStatus === 'COMPLETED' ? NotificationType.AGENT_COMPLETED : nextStatus === 'FAILED' ? NotificationType.AGENT_FAILED : NotificationType.AGENT_BLOCKED,
        nextStatus === 'COMPLETED' ? 'Agent completed' : nextStatus === 'FAILED' ? 'Agent failed' : 'Agent blocked',
        {
          body: `${agent.name}: ${run.objective ?? run.id}`,
          resourceType: 'ai_agent_run',
          resourceId: runId,
          metadata: { status: nextStatus, error },
        },
      );
      // One meaningful memory per run (never per trivial event).
      try {
        await createMemory(run.owner_id, {
          projectId: run.project_id ?? undefined,
          type: 'EPISODIC',
          source: 'AI_INFERRED',
          content: `Agent ${agent.name} (${agent.role}) ${nextStatus.toLowerCase()}: ${run.objective ?? ''}`,
          confidence: 0.7,
          provenance: `agent_run:${runId}`,
          structured: { agentId: agent.id, role: agent.role, runId, status: nextStatus, tasksCompleted: completed, tasksFailed: failed },
        });
      } catch {
        /* memory is best-effort */
      }
      await recordAudit({
        action: nextStatus === 'COMPLETED' ? AuditAction.AGENT_RUN_COMPLETED : AuditAction.AGENT_RUN_FAILED,
        actorUserId: run.owner_id,
        scope: 'USER',
        tenantId: run.owner_id,
        resourceType: 'ai_agent_run',
        resourceId: runId,
        detail: { agentId: agent.id, status: nextStatus, error, spentUsd: spent, tasksCompleted: completed, tasksFailed: failed },
      });
    }
  } else {
    await pool.query(`UPDATE ai_agent_runs SET updated_at = now() WHERE id = $1`, [runId]);
  }
}

/**
 * Watchdog sweep: recompute every non-terminal run so deadline/retry/budget
 * bounds are enforced even when no task transition happens (e.g. a task that
 * is stuck in the queue). Terminal runs are left untouched.
 */
export async function sweepAgentRuns(): Promise<number> {
  const runs = await queryMany<AgentRunRow>(
    `SELECT * FROM ai_agent_runs WHERE status IN ('THINKING','RUNNING','WAITING_FOR_APPROVAL','WAITING_FOR_DEPENDENCY') LIMIT 100`,
  );
  for (const run of runs) {
    await recomputeRun(run.id);
  }
  return runs.length;
}

/** Suggested model for a role: the top eligible model per the role's routing. */
export async function suggestedModelForRole(userId: string, role: AgentRole): Promise<{ modelId: string | null; providerId: string | null }> {
  const routing = ROLE_ROUTING[role];
  const eligible = await eligibleModels(userId, { computeClass: routing.computeClass, coding: routing.coding });
  const best = eligible[0];
  return { modelId: best?.modelId ?? null, providerId: best?.providerId ?? null };
}

export function roleCatalog(): Array<{ role: AgentRole; label: string; description: string; computeClass: string; coding: boolean }> {
  return AGENT_ROLES.map((role) => {
    const r = ROLE_ROUTING[role];
    return { role, label: r.label, description: r.description, computeClass: r.computeClass, coding: r.coding };
  });
}

export function isAgentRunState(s: string): boolean {
  return validAgentState(s);
}
