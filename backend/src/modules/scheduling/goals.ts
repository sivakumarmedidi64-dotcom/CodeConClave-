/**
 * CodeConClave — Goal Mode (Stage 26C).
 * A goal is a high-level intent that is planned into a task graph and executed
 * through the EXISTING agent engine. Flow:
 *   DRAFT → PLANNING → PLAN_READY → WAITING_FOR_APPROVAL → RUNNING → COMPLETED
 *                                                          |-> BLOCKED → WAITING_FOR_HUMAN_DECISION
 *                                                          |-> FAILED / CANCELLED / PAUSED
 * Progress is derived from REAL task-graph state (per-entry agent-run status
 * folded onto the persisted plan) — percentages are never fabricated.
 * COMPLETED requires evidence; a goal with no evidence stays BLOCKED.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { listAgents, getAgent, startRun, cancelRun } from '../agents/service.js';
import { createApproval, decideApproval } from '../execution/approvals.js';
import { createMemory } from '../memory/service.js';
import { getSchedule } from './service.js';
import { retrieveDnaForPrompt } from '../dna/service.js';
import { detectConflict } from '../memory/decisions.js';
import { completeWithFallback } from '../ai/gateway.js';

export type GoalStatus =
  | 'DRAFT' | 'PLANNING' | 'PLAN_READY' | 'WAITING_FOR_APPROVAL' | 'RUNNING'
  | 'PAUSED' | 'BLOCKED' | 'WAITING_FOR_HUMAN_DECISION' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type EntryStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';

export interface PlanEntry {
  id: string;
  title: string;
  description: string | null;
  role: string | null;
  agentId: string | null;
  dependsOn: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: EntryStatus;
  runId: string | null;
  taskIds: string[];
  attempts: number;
  error: string | null;
}

export interface GoalRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  objective: string;
  success_criteria: string[];
  constraints: string[];
  status: GoalStatus;
  plan: PlanEntry[];
  progress: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  blockers: Record<string, unknown>[];
  budget_usd: number;
  spent_usd: number;
  deadline_at: Date | null;
  estimated_cost_usd: number | null;
  require_approval: boolean;
  approval_id: string | null;
  approved_at: Date | null;
  error: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GoalInput {
  title: string;
  objective: string;
  successCriteria?: string[];
  constraints?: string[];
  projectId?: string | null;
  budgetUsd?: number;
  deadlineAt?: string | null;
  requireApproval?: boolean;
}

function mapGoal(row: Record<string, unknown>): GoalRow {
  const plan = Array.isArray(row.plan) ? (row.plan as PlanEntry[]) : [];
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    project_id: row.project_id ? String(row.project_id) : null,
    title: String(row.title),
    objective: String(row.objective),
    success_criteria: Array.isArray(row.success_criteria) ? row.success_criteria.map(String) : [],
    constraints: Array.isArray(row.constraints) ? row.constraints.map(String) : [],
    status: row.status as GoalStatus,
    plan,
    progress: (row.progress as Record<string, unknown>) ?? {},
    evidence: Array.isArray(row.evidence) ? (row.evidence as Record<string, unknown>[]) : [],
    blockers: Array.isArray(row.blockers) ? (row.blockers as Record<string, unknown>[]) : [],
    budget_usd: Number(row.budget_usd ?? 5),
    spent_usd: Number(row.spent_usd ?? 0),
    deadline_at: row.deadline_at ? new Date(row.deadline_at as string) : null,
    estimated_cost_usd: row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : null,
    require_approval: Boolean(row.require_approval),
    approval_id: row.approval_id ? String(row.approval_id) : null,
    approved_at: row.approved_at ? new Date(row.approved_at as string) : null,
    error: row.error ? String(row.error) : null,
    completed_at: row.completed_at ? new Date(row.completed_at as string) : null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

async function getOwnedGoal(userId: string, goalId: string): Promise<GoalRow> {
  const rows = await withTenant<{ rows: Record<string, unknown>[] }>(userId, (q) => q.query<Record<string, unknown>>('SELECT * FROM goals WHERE id = $1 AND owner_id = $2', [goalId, userId]));
  if (!rows.rows[0]) throw AppError.notFound('Goal');
  return mapGoal(rows.rows[0]);
}

async function getGoalInternal(goalId: string): Promise<GoalRow> {
  const rows = await withSystem<{ rows: Record<string, unknown>[] }>(async (q) => q.query<Record<string, unknown>>('SELECT * FROM goals WHERE id = $1', [goalId]));
  if (!rows.rows[0]) throw AppError.notFound('Goal');
  return mapGoal(rows.rows[0]);
}

async function setGoalStatus(goal: GoalRow, status: GoalStatus, error?: string | null, completedAt?: Date): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [goal.id, status];
  if (error !== undefined) {
    params.push(error);
    sets.push(`error = $${params.length}`);
  }
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
    sets.push('completed_at = COALESCE(completed_at, now())');
  }
  if (completedAt) {
    params.push(completedAt.toISOString());
    sets.push(`completed_at = $${params.length}`);
  }
  await withTenant(goal.owner_id, (q) => q.query(`UPDATE goals SET ${sets.join(', ')} WHERE id = $1`, params));
}

async function logActivity(goalId: string, ownerId: string, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  await withTenant(ownerId, (q) =>
    q.query(
      'INSERT INTO goal_activities (id, goal_id, owner_id, event, detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [newId(PREFIX.GOAL_ACTIVITY), goalId, ownerId, event, JSON.stringify(detail)],
    ),
  );
}

async function savePlan(goal: GoalRow, plan: PlanEntry[], extra: Record<string, unknown> = {}): Promise<void> {
  await withTenant(goal.owner_id, (q) =>
    q.query(
      `UPDATE goals SET plan = $2::jsonb, updated_at = now() WHERE id = $1`,
      [goal.id, JSON.stringify(plan)],
    ),
  );
  await logActivity(goal.id, goal.owner_id, 'plan_saved', { entries: plan.length, ...extra });
}

function entryId(index: number): string {
  return `e${index + 1}`;
}

const ROLES: string[] = ['ARCHITECT', 'CODER', 'DEBUGGER', 'RESEARCHER', 'REVIEWER', 'TESTER', 'SECURITY', 'DEVOPS', 'UI_UX', 'DOCUMENTATION'];

/** Deterministic fallback plan when the AI planner is unavailable or unparseable. */
function fallbackPlan(agents: { id: string; role: string }[], objective: string): PlanEntry[] {
  const agent = agents[0];
  return [{
    id: 'e1',
    title: objective,
    description: objective,
    role: agent?.role ?? null,
    agentId: agent?.id ?? null,
    dependsOn: [],
    risk: 'MEDIUM',
    status: 'PENDING',
    runId: null,
    taskIds: [],
    attempts: 0,
    error: null,
  }];
}

async function pickAgent(userId: string, role: string | null): Promise<{ id: string; role: string } | null> {
  const agents = await listAgents(userId);
  if (!agents.length) return null;
  const idle = agents.filter((a) => a.status === 'IDLE');
  const pool2 = idle.length ? idle : agents;
  const byRole = role ? pool2.find((a) => a.role === role) : undefined;
  return (byRole ?? pool2[0])!;
}

export async function listGoals(userId: string, status?: GoalStatus): Promise<GoalRow[]> {
  const params: unknown[] = [userId];
  let clause = '';
  if (status) {
    params.push(status);
    clause = `AND status = $${params.length}`;
  }
  const rows = await withTenant<{ rows: Record<string, unknown>[] }>(userId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT * FROM goals WHERE owner_id = $1 ${clause} ORDER BY created_at DESC`,
      params,
    ),
  );
  return rows.rows.map(mapGoal);
}

export async function getGoal(userId: string, goalId: string): Promise<GoalRow> {
  return getOwnedGoal(userId, goalId);
}

export async function listGoalActivities(userId: string, goalId: string, limit = 50): Promise<{ id: string; goal_id: string; event: string; detail: Record<string, unknown>; created_at: Date }[]> {
  const rows = await withTenant<{ rows: Record<string, unknown>[] }>(userId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT * FROM goal_activities WHERE goal_id = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [goalId, userId, Math.min(Math.max(limit, 1), 200)],
    ),
  );
  return rows.rows.map((r) => ({
    id: String(r.id),
    goal_id: String(r.goal_id),
    event: String(r.event),
    detail: (r.detail as Record<string, unknown>) ?? {},
    created_at: new Date(r.created_at as string),
  }));
}

export async function createGoal(userId: string, input: GoalInput): Promise<GoalRow> {
  const title = (input.title ?? '').trim();
  const objective = (input.objective ?? '').trim();
  if (!title || !objective) throw AppError.badRequest('title_objective_required', 'title and objective are required');
  if (input.projectId) {
    const p = await withTenant<{ rows: { id: string }[] }>(userId, (q) => q.query<{ id: string }>('SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [input.projectId, userId]));
    if (!p.rows[0]) throw AppError.notFound('Project');
  }
  const budget = Math.min(Math.max(input.budgetUsd ?? 5, 0.1), 100);
  const deadlineAt = input.deadlineAt ? new Date(input.deadlineAt) : null;
  const id = newId(PREFIX.GOAL);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO goals (id, owner_id, project_id, title, objective, success_criteria, constraints, status, budget_usd, deadline_at, require_approval)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'DRAFT',$8,$9,$10)`,
      [
        id, userId, input.projectId ?? null, title, objective,
        JSON.stringify(input.successCriteria ?? []), JSON.stringify(input.constraints ?? []),
        budget, deadlineAt ? deadlineAt.toISOString() : null, input.requireApproval ?? true,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.GOAL_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'goal',
    resourceId: id,
    detail: { projectId: input.projectId ?? null, budgetUsd: budget, requireApproval: input.requireApproval ?? true },
  });
  await logActivity(id, userId, 'goal_created', {});
  return getOwnedGoal(userId, id);
}

/** Parse → criteria → constraints → estimate → plan → task graph (foundation). */
export async function generateGoalPlan(userId: string, goalId: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (!['DRAFT', 'PLAN_READY'].includes(goal.status)) {
    throw AppError.conflict('goal_not_planable', `Goal status ${goal.status} cannot be planned`);
  }
  await setGoalStatus(goal, 'PLANNING');

  // DNA + memory inform planning.
  let dnaContext: string[] = [];
  try {
    dnaContext = await retrieveDnaForPrompt(userId, goal.project_id);
  } catch {
    dnaContext = [];
  }

  // Decision Conflict Detector: a conflicting historical decision is surfaced,
  // never silently ignored.
  let conflictNote: Record<string, unknown> | null = null;
  try {
    const conflict = await detectConflict(userId, goal.objective);
    if (conflict.conflicts.length) {
      conflictNote = { type: 'decision_conflict', conflicts: conflict.conflicts };
    }
  } catch {
    conflictNote = null;
  }

  const agents = await listAgents(userId);
  if (!agents.length) throw AppError.conflict('no_agents_available', 'Create an agent before starting a goal');

  // Attempt AI planning; any failure falls back to the deterministic plan.
  let entries: { title: string; description: string; role: string }[] | null = null;
  try {
    const res = await completeWithFallback({
      ctx: {
        userId,
        sessionId: `goal:${goal.id}`,
        conversationId: null,
        taskId: null,
        planId: 'pro',
        coworkerType: 'PLANNER',
      },
      messages: [
        { role: 'system', content: 'Break the goal into a JSON array of up to 6 plan steps. Each item: {"title","description","role"} where role is one of ARCHITECT, CODER, DEBUGGER, RESEARCHER, REVIEWER, TESTER, SECURITY, DEVOPS, UI_UX, DOCUMENTATION. Return only the JSON array.' },
        { role: 'user', content: `Goal: ${goal.title}\nObjective: ${goal.objective}\nConstraints: ${goal.constraints.join('; ') || 'none'}\nDNA context:\n${dnaContext.join('\n') || 'none'}` },
      ],
      maxTokens: 1500,
      opts: { computeClass: 'C', coworkerType: 'PLANNER' },
    });
    const parsed = tryParsePlan(res.text);
    if (parsed) entries = parsed.slice(0, 6);
  } catch {
    entries = null;
  }

  const planSource = entries ? 'planner' : 'default_fallback';
  if (!entries) {
    await logActivity(goal.id, userId, 'planning_fallback', { reason: 'planner_unavailable' });
  }

  const plan: PlanEntry[] = entries && entries.length
    ? entries.map((e, i) => ({
        id: entryId(i),
        title: e.title,
        description: e.description,
        role: ROLES.includes(e.role) ? e.role : null,
        agentId: null,
        dependsOn: [],
        risk: 'MEDIUM',
        status: 'PENDING',
        runId: null,
        taskIds: [],
        attempts: 0,
        error: null,
      }))
    : fallbackPlan(agents.map((a) => ({ id: a.id, role: a.role })), goal.objective);

  // Assign agents to entries (best idle match per role; fallback first idle).
  let assigned = 0;
  for (const entry of plan) {
    const picked = await pickAgent(userId, entry.role);
    if (picked) {
      entry.agentId = picked.id;
      assigned++;
    }
  }

  await savePlan(goal, plan, { source: planSource, agentsAssigned: assigned, conflicts: conflictNote ? 1 : 0 });
  if (conflictNote) {
    const blockers = [...goal.blockers, conflictNote];
    await withTenant(userId, (q) => q.query('UPDATE goals SET blockers = $2::jsonb WHERE id = $1', [goal.id, JSON.stringify(blockers)]));
  }

  const estimate: number | null = null; // provider-gated cost estimation (null when unavailable)
  await setGoalStatus(goal, 'PLAN_READY');
  await recordAudit({
    action: AuditAction.GOAL_PLAN_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'goal',
    resourceId: goal.id,
    detail: { source: planSource, entries: plan.length, agentsAssigned: assigned, estimatedCostUsd: estimate },
  });
  return getOwnedGoal(userId, goal.id);
}

function tryParsePlan(text: string): { title: string; description: string; role: string }[] | null {
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    const raw = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(raw)) return null;
    const out = raw.map((r) => ({
      title: String(r.title ?? '').trim(),
      description: String(r.description ?? '').trim(),
      role: String(r.role ?? '').toUpperCase().trim(),
    })).filter((r) => r.title);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** User edits the persisted plan (EDIT_PLAN flow) — server revalidates everything. */
export async function updateGoalPlan(userId: string, goalId: string, entries: { title: string; description?: string; role?: string; dependsOn?: string[]; risk?: string }[]): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (!['PLAN_READY', 'DRAFT', 'WAITING_FOR_HUMAN_DECISION'].includes(goal.status)) {
    throw AppError.conflict('goal_not_editable', `Goal status ${goal.status} cannot be edited`);
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) {
    throw AppError.badRequest('invalid_plan', 'Plan must contain 1-20 entries');
  }
  const agents = await listAgents(userId);
  const plan: PlanEntry[] = entries.map((e, i) => {
    const picked = pickAgentFromList(agents, e.role?.toUpperCase());
    const risk = e.risk ?? 'MEDIUM';
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(risk)) throw AppError.badRequest('invalid_risk', 'Invalid risk level');
    const ids = new Set<string>();
    for (const dep of e.dependsOn ?? []) {
      if (!entries.some((_, k) => entryId(k) === dep)) throw AppError.badRequest('invalid_dependency', `Dependency ${dep} does not exist`);
      ids.add(dep);
    }
    return {
      id: entryId(i),
      title: String(e.title ?? '').trim() || `Step ${i + 1}`,
      description: e.description ? String(e.description) : null,
      role: e.role?.toUpperCase() ?? null,
      agentId: picked?.id ?? null,
      dependsOn: [...ids],
      risk: risk as PlanEntry['risk'],
      status: 'PENDING',
      runId: null,
      taskIds: [],
      attempts: 0,
      error: null,
    };
  });
  await savePlan(goal, plan, { source: 'user_edit' });
  await setGoalStatus(goal, 'PLAN_READY');
  await recordAudit({
    action: AuditAction.GOAL_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'goal',
    resourceId: goal.id,
    detail: { planEdited: true, entries: plan.length },
  });
  return getOwnedGoal(userId, goal.id);
}

function pickAgentFromList(agents: { id: string; role: string; status: string }[], role?: string) {
  if (!agents.length) return null;
  const idle = agents.filter((a) => a.status === 'IDLE');
  const candidates = idle.length ? idle : agents;
  return role ? (candidates.find((a) => a.role === role) ?? candidates[0])! : candidates[0]!;
}

/** User starts the goal: PLAN_READY → approval gate (when required) → execution. */
export async function startGoal(userId: string, goalId: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (goal.status !== 'PLAN_READY') {
    throw AppError.conflict('goal_not_ready', `Goal status ${goal.status} must be PLAN_READY to start`);
  }
  if (goal.plan.some((e) => !e.agentId)) {
    throw AppError.badRequest('unassigned_entries', 'Every plan entry must have an assigned agent');
  }
  if (goal.require_approval) {
    const approval = await createApproval({
      ownerId: userId,
      taskId: null,
      riskLevel: 'HIGH',
      detail: {
        kind: 'goal',
        goalId: goal.id,
        title: goal.title,
        entries: goal.plan.length,
        estimatedBudgetUsd: goal.budget_usd,
      },
    });
    await withTenant(userId, (q) => q.query('UPDATE goals SET approval_id = $2, status = $3, updated_at = now() WHERE id = $1', [goal.id, approval.id, 'WAITING_FOR_APPROVAL']));
    await logActivity(goal.id, userId, 'approval_requested', { approvalId: approval.id });
    await notify(userId, NotificationType.AGENT_APPROVAL_REQUIRED, `Goal approval required: ${goal.title}`, {
      body: `Goal "${goal.title}" is ready to execute and needs your approval.`,
      resourceType: 'goal', resourceId: goal.id,
    });
    return getOwnedGoal(userId, goal.id);
  }
  return executeGoal(userId, goal.id, true);
}

export async function decideGoalApproval(userId: string, goalId: string, decision: 'APPROVE' | 'REJECT', reason?: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (goal.status !== 'WAITING_FOR_APPROVAL' || !goal.approval_id) {
    throw AppError.conflict('no_pending_approval', 'Goal has no pending approval');
  }
  await decideApproval(userId, goal.approval_id, decision, reason);
  await logActivity(goal.id, userId, 'approval_decision', { decision, reason: reason ?? null });
  if (decision === 'APPROVE') {
    return executeGoal(userId, goal.id, true);
  }
  await setGoalStatus(goal, 'PLAN_READY', null);
  await recordAudit({
    action: AuditAction.GOAL_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'goal',
    resourceId: goal.id,
    detail: { approvalRejected: true, reason: reason ?? null },
  });
  return getOwnedGoal(userId, goal.id);
}

async function runEntry(goal: GoalRow, entry: PlanEntry): Promise<void> {
  const agents = await listAgents(goal.owner_id);
  const agent = agents.find((a) => a.id === entry.agentId);
  if (!agent) {
    entry.status = 'BLOCKED';
    entry.error = 'agent_not_found';
    await savePlan(goal, goal.plan);
    return;
  }
  if (agent.status !== 'IDLE') {
    entry.status = 'BLOCKED';
    entry.error = `agent_busy (${agent.status})`;
    await savePlan(goal, goal.plan);
    return;
  }
  const run = await startRun(goal.owner_id, agent.id, {
    projectId: goal.project_id ?? undefined,
    objective: entry.title,
    subtasks: [{ title: entry.title, description: entry.description ?? goal.objective }],
    requireApproval: false,
  });
  const task = await withTenant<{ rows: { id: string }[] }>(goal.owner_id, (q) => q.query<{ id: string }>('SELECT id FROM tasks WHERE agent_run_id = $1 ORDER BY created_at LIMIT 1', [run.id]));
  entry.status = 'RUNNING';
  entry.runId = run.id;
  entry.taskIds = task.rows.map((t) => t.id);
  await withTenant(goal.owner_id, (q) => q.query(`UPDATE tasks SET goal_id = $2 WHERE agent_run_id = $1`, [run.id, goal.id]));
  await savePlan(goal, goal.plan);
}

/** Start execution (first runnable entry). */
export async function executeGoal(userId: string, goalId: string, force = false): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (!force && goal.status !== 'PLAN_READY') {
    throw AppError.conflict('goal_not_ready', 'Goal must be PLAN_READY to execute');
  }
  if (goal.status === 'WAITING_FOR_APPROVAL' && !force) {
    throw AppError.conflict('goal_waiting_approval', 'Goal is waiting for approval');
  }
  const first = goal.plan.find((e) => e.status === 'PENDING' && e.dependsOn.every((d) => goal.plan.find((x) => x.id === d)?.status === 'COMPLETED'));
  if (!first) {
    throw AppError.badRequest('no_runnable_entry', 'No runnable plan entry');
  }
  await setGoalStatus(goal, 'RUNNING', null);
  await recordAudit({
    action: AuditAction.GOAL_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'goal',
    resourceId: goal.id,
    detail: { entry: first.id },
  });
  await logActivity(goal.id, userId, 'goal_started', { entry: first.id });
  await runEntry(goal, first);
  return refreshGoal(userId, goal.id);
}

/**
 * Recompute goal state from REAL task-graph state. Never fabricates progress:
 * every count derives from the persisted plan entries and live task rows.
 */
export async function refreshGoal(userId: string, goalId: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (goal.status === 'COMPLETED' || goal.status === 'FAILED' || goal.status === 'CANCELLED') return goal;

  // Fold terminal agent-run states onto running entries.
  for (const entry of goal.plan) {
    if (entry.status === 'RUNNING' && entry.runId) {
      const run = await withTenant<{ rows: { status: string; error: string | null; spent_usd: number | null }[] }>(goal.owner_id, (q) =>
        q.query<{ status: string; error: string | null; spent_usd: number | null }>(
          'SELECT status, error, spent_usd FROM ai_agent_runs WHERE id = $1', [entry.runId],
        ),
      );
      const st = run.rows[0]?.status;
      if (st === 'COMPLETED') {
        entry.status = 'COMPLETED';
        entry.error = null;
        goal.evidence.push({
          entryId: entry.id,
          title: entry.title,
          runId: entry.runId,
          taskIds: entry.taskIds,
          status: 'COMPLETED',
          recordedAt: new Date().toISOString(),
        });
      } else if (st === 'FAILED' || st === 'BLOCKED') {
        entry.status = st === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
        entry.error = run.rows[0]?.error ?? st;
      }
    }
  }

  // Spent budget from live runs (real, from the engine).
  const runIds = goal.plan.filter((e) => e.runId).map((e) => e.runId!) as string[];
  const spent = await withTenant<{ rows: { total: number | null }[] }>(goal.owner_id, (q) =>
    q.query<{ total: number | null }>(
      `SELECT COALESCE(SUM(spent_usd), 0)::numeric AS total FROM ai_agent_runs WHERE owner_id = $1 AND id = ANY($2::text[])`,
      [goal.owner_id, runIds.length ? runIds : ['__none__']],
    ),
  );
  const spentUsd = Number(spent.rows[0]?.total ?? 0);

  const totalEntries = goal.plan.length;
  const completed = goal.plan.filter((e) => e.status === 'COMPLETED').length;
  const failed = goal.plan.filter((e) => e.status === 'FAILED').length;
  const blocked = goal.plan.filter((e) => e.status === 'BLOCKED').length;
  const running = goal.plan.filter((e) => e.status === 'RUNNING').length;
  const pending = goal.plan.filter((e) => e.status === 'PENDING').length;
  const percent = totalEntries > 0 && (completed + failed + blocked > 0 || running > 0 || pending < totalEntries)
    ? Math.round((completed / totalEntries) * 100)
    : 0;

  const taskTotals = await withTenant<{ rows: { total: number; completed: number; running: number; failed: number; blocked: number; pending: number }[] }>(goal.owner_id, (q) =>
    q.query<{ total: number; completed: number; running: number; failed: number; blocked: number; pending: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE status IN ('RUNNING','THINKING','TESTING','VERIFIED'))::int AS running,
              COUNT(*) FILTER (WHERE status IN ('FAILED','TIMED_OUT'))::int AS failed,
              COUNT(*) FILTER (WHERE status IN ('BLOCKED','REQUIRES_REVIEW','WAITING_FOR_LOCAL_AGENT'))::int AS blocked,
              COUNT(*) FILTER (WHERE status IN ('CREATED','PLANNED','CHANGED','WAITING_APPROVAL'))::int AS pending
       FROM tasks WHERE owner_id = $1 AND goal_id = $2`,
      [goal.owner_id, goal.id],
    ),
  );

  const progress: Record<string, unknown> = {
    totalEntries,
    completedEntries: completed,
    failedEntries: failed,
    blockedEntries: blocked,
    runningEntries: running,
    pendingEntries: pending,
    percent,
    taskTotals: taskTotals.rows[0] ?? { total: 0, completed: 0, running: 0, failed: 0, blocked: 0, pending: 0 },
    updatedAt: new Date().toISOString(),
  };

  const allTerminal = totalEntries > 0 && goal.plan.every((e) => ['COMPLETED', 'FAILED', 'BLOCKED', 'SKIPPED'].includes(e.status));
  const deadlineHit = goal.deadline_at ? goal.deadline_at.getTime() <= Date.now() : false;
  const budgetHit = spentUsd > goal.budget_usd;

  if (budgetHit && !allTerminal) {
    await setGoalStatus(goal, 'BLOCKED', 'budget_exceeded');
    await recordAudit({ action: AuditAction.GOAL_BLOCKED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: { reason: 'budget_exceeded', spentUsd } });
    await logActivity(goal.id, goal.owner_id, 'blocked', { reason: 'budget_exceeded', spentUsd });
  } else if (deadlineHit && !allTerminal) {
    await setGoalStatus(goal, 'FAILED', 'deadline_exceeded');
    await recordAudit({ action: AuditAction.GOAL_FAILED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: { reason: 'deadline_exceeded' } });
    await logActivity(goal.id, goal.owner_id, 'failed', { reason: 'deadline_exceeded' });
  } else if (allTerminal) {
    if (failed > 0 || blocked > 0) {
      await setGoalStatus(goal, 'BLOCKED', 'plan_failures');
      await recordAudit({ action: AuditAction.GOAL_BLOCKED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: { failed, blocked } });
      await logActivity(goal.id, goal.owner_id, 'blocked', { failed, blocked });
    } else if (completed === totalEntries) {
      if (goal.evidence.length === 0) {
        // NOT_COMPLETED without evidence — stays BLOCKED, escalated.
        await setGoalStatus(goal, 'BLOCKED', 'no_evidence');
        await recordAudit({ action: AuditAction.GOAL_BLOCKED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: { reason: 'no_evidence' } });
        await logActivity(goal.id, goal.owner_id, 'blocked', { reason: 'no_evidence' });
      } else {
        await setGoalStatus(goal, 'COMPLETED', null, new Date());
        await recordAudit({ action: AuditAction.GOAL_COMPLETED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: { evidenceCount: goal.evidence.length, spentUsd } });
        await logActivity(goal.id, goal.owner_id, 'completed', { evidenceCount: goal.evidence.length });
        await notify(goal.owner_id, NotificationType.GOAL_COMPLETED, `Goal completed: ${goal.title}`, {
          body: `All ${totalEntries} plan steps completed with evidence.`,
          resourceType: 'goal', resourceId: goal.id,
        });
        await feedMemory(goal);
      }
    }
  } else {
    // Still progressing — try to start the next runnable entry.
    const next = goal.plan.find((e) => e.status === 'PENDING' && e.dependsOn.every((d) => goal.plan.find((x) => x.id === d)?.status === 'COMPLETED'));
    if (next && running === 0) {
      await runEntry(goal, next);
    }
    if (pending > 0 && running === 0 && !next) {
      // Dependencies can never be satisfied — a real graph deadlock.
      await setGoalStatus(goal, 'BLOCKED', 'dependency_blocked');
      await recordAudit({ action: AuditAction.GOAL_BLOCKED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: { reason: 'dependency_blocked' } });
      await logActivity(goal.id, goal.owner_id, 'blocked', { reason: 'dependency_blocked' });
    }
  }

  const fresh = await getOwnedGoal(userId, goal.id);
  if (fresh.status === 'BLOCKED') {
    const open = await withTenant<{ rows: { id: string }[] }>(goal.owner_id, (q) =>
      q.query<{ id: string }>(
        `SELECT id FROM escalations WHERE goal_id = $1 AND status = 'OPEN' LIMIT 1`, [goal.id],
      ),
    );
    if (!open.rows[0]) await autoEscalate(goal);
  }
  await withTenant(goal.owner_id, (q) => q.query('UPDATE goals SET progress = $2::jsonb, spent_usd = $3, updated_at = now() WHERE id = $1', [goal.id, JSON.stringify(progress), spentUsd]));
  return getOwnedGoal(userId, goal.id);
}

async function feedMemory(goal: GoalRow): Promise<void> {
  const existing = await withTenant<{ rows: { id: string }[] }>(goal.owner_id, (q) =>
    q.query<{ id: string }>(
      `SELECT id FROM goal_activities WHERE goal_id = $1 AND event = 'memory_fed' LIMIT 1`, [goal.id],
    ),
  );
  if (existing.rows[0]) return;
  try {
    await createMemory(goal.owner_id, {
      projectId: goal.project_id ?? undefined,
      type: 'SEMANTIC',
      source: 'AI_INFERRED',
      content: `${goal.title}: ${goal.objective}`,
      confidence: 0.5,
      provenance: `goal:${goal.id}`,
      structured: { goalId: goal.id, outcome: 'COMPLETED', evidenceCount: goal.evidence.length },
    });
    await logActivity(goal.id, goal.owner_id, 'memory_fed', {});
    await recordAudit({ action: AuditAction.GOAL_MEMORY_FED, actorUserId: null, scope: 'SYSTEM', tenantId: goal.owner_id, resourceType: 'goal', resourceId: goal.id, detail: {} });
  } catch {
    /* memory feed is best-effort; never fails the goal */
  }
}

export async function pauseGoal(userId: string, goalId: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (goal.status !== 'RUNNING' && goal.status !== 'WAITING_FOR_HUMAN_DECISION') {
    throw AppError.conflict('goal_not_pausable', `Goal status ${goal.status} cannot be paused`);
  }
  await setGoalStatus(goal, 'PAUSED');
  await recordAudit({ action: AuditAction.GOAL_PAUSED, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'goal', resourceId: goal.id, detail: {} });
  await logActivity(goal.id, userId, 'paused', {});
  return getOwnedGoal(userId, goal.id);
}

export async function resumeGoal(userId: string, goalId: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (goal.status !== 'PAUSED' && goal.status !== 'BLOCKED' && goal.status !== 'WAITING_FOR_HUMAN_DECISION') {
    throw AppError.conflict('goal_not_resumable', `Goal status ${goal.status} cannot be resumed`);
  }
  await setGoalStatus(goal, 'RUNNING', null);
  await recordAudit({ action: AuditAction.GOAL_RESUMED, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'goal', resourceId: goal.id, detail: {} });
  await logActivity(goal.id, userId, 'resumed', {});
  return refreshGoal(userId, goal.id);
}

export async function cancelGoal(userId: string, goalId: string, reason?: string): Promise<GoalRow> {
  const goal = await getOwnedGoal(userId, goalId);
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(goal.status)) {
    throw AppError.conflict('goal_terminal', 'Goal is already terminal');
  }
  for (const entry of goal.plan) {
    if (entry.status === 'RUNNING' && entry.runId) {
      try {
        await cancelRun(userId, entry.runId);
      } catch {
        /* best-effort */
      }
    }
  }
  await setGoalStatus(goal, 'CANCELLED', null);
  await recordAudit({ action: AuditAction.GOAL_CANCELLED, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'goal', resourceId: goal.id, detail: { reason: reason ?? null } });
  await logActivity(goal.id, userId, 'cancelled', { reason: reason ?? null });
  return getOwnedGoal(userId, goal.id);
}

// ---------------------------------------------------------------- escalations

export interface EscalationRow {
  id: string;
  owner_id: string;
  goal_id: string | null;
  schedule_id: string | null;
  issue: string;
  evidence: Record<string, unknown>[];
  attempted_actions: string[];
  options: string[];
  recommendation: string | null;
  risk: string;
  status: string;
  user_decision: string | null;
  decision_note: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

function mapEscalation(row: Record<string, unknown>): EscalationRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    goal_id: row.goal_id ? String(row.goal_id) : null,
    schedule_id: row.schedule_id ? String(row.schedule_id) : null,
    issue: String(row.issue),
    evidence: Array.isArray(row.evidence) ? (row.evidence as Record<string, unknown>[]) : [],
    attempted_actions: Array.isArray(row.attempted_actions) ? row.attempted_actions.map(String) : [],
    options: Array.isArray(row.options) ? row.options.map(String) : [],
    recommendation: row.recommendation ? String(row.recommendation) : null,
    risk: String(row.risk),
    status: String(row.status),
    user_decision: row.user_decision ? String(row.user_decision) : null,
    decision_note: row.decision_note ? String(row.decision_note) : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at as string) : null,
    created_at: new Date(row.created_at as string),
  };
}

export async function listEscalations(userId: string, status?: string): Promise<EscalationRow[]> {
  const params: unknown[] = [userId];
  let clause = '';
  if (status) {
    params.push(status);
    clause = `AND status = $${params.length}`;
  }
  const rows = await withTenant<{ rows: Record<string, unknown>[] }>(userId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT * FROM escalations WHERE owner_id = $1 ${clause} ORDER BY (status = 'OPEN') DESC, created_at DESC LIMIT 100`,
      params,
    ),
  );
  return rows.rows.map(mapEscalation);
}

async function autoEscalate(goal: GoalRow): Promise<void> {
  const failed = goal.plan.filter((e) => e.status === 'FAILED' || e.status === 'BLOCKED');
  const issue = failed.length
    ? `${failed.length} plan step(s) failed: ${failed.map((e) => `${e.title} (${e.error ?? 'unknown'})`).join('; ')}`
    : goal.error ?? 'Goal could not complete';
  const hasRetryHeadroom = failed.some((e) => e.attempts < 3);
  const escalation = await createEscalation(goal.owner_id, {
    goalId: goal.id,
    issue,
    evidence: goal.evidence,
    attemptedActions: failed.map((e) => `execute:${e.id}`),
    options: ['APPROVE', 'EDIT_PLAN', 'RETRY', 'PAUSE', 'CANCEL'],
    recommendation: hasRetryHeadroom ? 'RETRY' : 'EDIT_PLAN',
    risk: 'MEDIUM',
  });
  await setGoalStatus(goal, 'WAITING_FOR_HUMAN_DECISION');
  await logActivity(goal.id, goal.owner_id, 'escalated', { escalationId: escalation.id });
  await notify(goal.owner_id, NotificationType.GOAL_ESCALATION_NEEDS_DECISION, `Goal needs a decision: ${goal.title}`, {
    body: issue,
    resourceType: 'goal', resourceId: goal.id,
  });
}

export async function createEscalation(userId: string, input: {
  goalId?: string;
  scheduleId?: string;
  issue: string;
  evidence?: Record<string, unknown>[];
  attemptedActions?: string[];
  options?: string[];
  recommendation?: string;
  risk?: string;
}): Promise<EscalationRow> {
  if (!input.goalId && !input.scheduleId) throw AppError.badRequest('escalation_target_required', 'A goal or schedule must be escalated');
  if (!input.issue.trim()) throw AppError.badRequest('issue_required', 'issue is required');
  const risk = input.risk ?? 'MEDIUM';
  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(risk)) throw AppError.badRequest('invalid_risk', 'Invalid risk level');
  if (input.goalId) await getOwnedGoal(userId, input.goalId);
  if (input.scheduleId) await getSchedule(userId, input.scheduleId);
  const id = newId(PREFIX.ESCALATION);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO escalations (id, owner_id, goal_id, schedule_id, issue, evidence, attempted_actions, options, recommendation, risk, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,'OPEN')`,
      [
        id, userId, input.goalId ?? null, input.scheduleId ?? null, input.issue,
        JSON.stringify(input.evidence ?? []), JSON.stringify(input.attemptedActions ?? []),
        JSON.stringify(input.options ?? []), input.recommendation ?? null, risk,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.GOAL_ESCALATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'escalation',
    resourceId: id,
    detail: { goalId: input.goalId ?? null, scheduleId: input.scheduleId ?? null, risk },
  });
  return getEscalation(userId, id);
}

export async function getEscalation(userId: string, escalationId: string): Promise<EscalationRow> {
  const rows = await withTenant<{ rows: Record<string, unknown>[] }>(userId, (q) => q.query<Record<string, unknown>>('SELECT * FROM escalations WHERE id = $1 AND owner_id = $2', [escalationId, userId]));
  if (!rows.rows[0]) throw AppError.notFound('Escalation');
  return mapEscalation(rows.rows[0]);
}

export async function decideEscalation(userId: string, escalationId: string, decision: 'APPROVE' | 'REJECT' | 'EDIT_PLAN' | 'RETRY' | 'PAUSE' | 'CANCEL', note?: string): Promise<EscalationRow> {
  const escalation = await getEscalation(userId, escalationId);
  if (escalation.status !== 'OPEN') throw AppError.conflict('escalation_not_open', 'Escalation is not open');
  const valid = ['APPROVE', 'REJECT', 'EDIT_PLAN', 'RETRY', 'PAUSE', 'CANCEL'];
  if (!valid.includes(decision)) throw AppError.badRequest('invalid_decision', 'Invalid decision');
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE escalations SET status = 'RESOLVED', user_decision = $2, decision_note = $3, resolved_at = now() WHERE id = $1 AND owner_id = $4`,
      [escalation.id, decision, note ?? null, userId],
    ),
  );
  await recordAudit({
    action: AuditAction.GOAL_ESCALATION_DECIDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'escalation',
    resourceId: escalation.id,
    detail: { decision, note: note ?? null },
  });

  if (escalation.goal_id) {
    const goal = await getOwnedGoal(userId, escalation.goal_id);
    if (decision === 'RETRY') {
      for (const entry of goal.plan) {
        if (entry.status === 'FAILED' || entry.status === 'BLOCKED') {
          if (entry.attempts < 3) {
            entry.status = 'PENDING';
            entry.attempts += 1;
            entry.error = null;
          }
        }
      }
      await savePlan(goal, goal.plan, { decision });
      await logActivity(goal.id, userId, 'decision', { decision, note: note ?? null });
      await resumeGoal(userId, goal.id);
    } else if (decision === 'APPROVE') {
      await logActivity(goal.id, userId, 'decision', { decision, note: note ?? null });
      await resumeGoal(userId, goal.id);
    } else if (decision === 'EDIT_PLAN') {
      await setGoalStatus(goal, 'PLAN_READY');
      await logActivity(goal.id, userId, 'decision', { decision, note: note ?? null });
    } else if (decision === 'PAUSE') {
      await setGoalStatus(goal, 'PAUSED');
      await logActivity(goal.id, userId, 'decision', { decision, note: note ?? null });
    } else if (decision === 'CANCEL') {
      await cancelGoal(userId, goal.id, note);
    } else if (decision === 'REJECT') {
      await setGoalStatus(goal, 'BLOCKED', 'recommendation_rejected');
      await logActivity(goal.id, userId, 'decision', { decision, note: note ?? null });
    }
  }
  return getEscalation(userId, escalation.id);
}