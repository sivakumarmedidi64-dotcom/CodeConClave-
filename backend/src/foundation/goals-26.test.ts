/**
 * Stage 26C — Goal Mode contract suite.
 * Covers: createGoal validation + audit trail, generateGoalPlan (AI planner
 * with deterministic fallback, DNA + conflict-detector context, agent
 * assignment), updateGoalPlan (server-side revalidation), startGoal approval
 * gate, decideGoalApproval APPROVE/REJECT, executeGoal driving the REAL agent
 * engine (startRun + tasks.goal_id back-link), refreshGoal progress/evidence
 * semantics (COMPLETED requires evidence; no_evidence stays BLOCKED and
 * auto-escalates), budget/deadline/dependency blocks, pause/resume/cancel,
 * escalation lifecycle (auto-escalate, decideEscalation RETRY/EDIT_PLAN/
 * PAUSE/CANCEL/REJECT), memory feed on completion, notifications, audits and
 * tenant-isolation negatives. The DB, agent service, gateway, approvals,
 * memory, DNA, decisions and notifications are mocked; goals code is fully
 * exercised against an in-memory store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    tables: Record<string, Array<Record<string, unknown>>>;
    resolve: ((text: string, params: unknown[]) => Array<Record<string, unknown>> | null) | null;
  } = {
    tables: {
      goals: [], goal_activities: [], escalations: [], ai_agents: [], ai_agent_runs: [], tasks: [],
      projects: [], scheduled_tasks: [], schedule_runs: [], approvals: [],
    },
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : [];
    return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

const agents = vi.hoisted(() => ({
  getAgent: vi.fn(),
  startRun: vi.fn(),
  listAgents: vi.fn(),
  cancelRun: vi.fn(),
}));
vi.mock('../modules/agents/service.js', () => agents);

const notifyMock = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock('../modules/notifications/service.js', () => notifyMock);

const gateway = vi.hoisted(() => ({ completeWithFallback: vi.fn(), estimatedCostOfRequest: vi.fn(async () => 0.01) }));
vi.mock('../modules/ai/gateway.js', () => gateway);

const approvals = vi.hoisted(() => ({
  createApproval: vi.fn(async () => ({ id: 'apr-1' })),
  decideApproval: vi.fn(async () => {}),
}));
vi.mock('../modules/execution/approvals.js', () => approvals);

const memory = vi.hoisted(() => ({ createMemory: vi.fn(async () => ({})) }));
vi.mock('../modules/memory/service.js', () => memory);

const dna = vi.hoisted(() => ({ retrieveDnaForPrompt: vi.fn(async () => []) }));
vi.mock('../modules/dna/service.js', () => dna);

const decisions = vi.hoisted(() => ({ detectConflict: vi.fn(async () => ({ conflicts: [] })) }));
vi.mock('../modules/memory/decisions.js', () => decisions);

import {
  createGoal, listGoals, getGoal, listGoalActivities, generateGoalPlan, updateGoalPlan,
  startGoal, decideGoalApproval, executeGoal, refreshGoal, pauseGoal, resumeGoal, cancelGoal,
  createEscalation, listEscalations, getEscalation, decideEscalation,
} from '../modules/scheduling/goals.js';
import { AppError } from '../shared/errors.js';

const JSONB = new Set(['plan', 'blockers', 'progress', 'evidence', 'detail', 'success_criteria', 'constraints', 'attempted_actions', 'options']);

/** In-memory SQL resolver driven by the exact SQL goals.ts emits. */
function wireDb() {
  const T = db.state.tables;
  const hydrate = (row: Record<string, unknown>) => {
    for (const k of Object.keys(row)) {
      if (JSONB.has(k) && typeof row[k] === 'string') {
        try { row[k] = JSON.parse(row[k] as string); } catch { row[k] = []; }
      }
    }
    return row;
  };
  const resolve = (text: string, params: unknown[]): Array<Record<string, unknown>> => {
    const id = (i: number) => String(params[i - 1]);

    // ---------------- INSERT ----------------
    const ins = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/.exec(text);
    if (ins) {
      const cols = ins[2].split(',').map((s) => s.trim());
      const vals = ins[3].split(',').map((s) => s.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const v = vals[i] ?? '';
        const m = /^\$(\d+)/.exec(v);
        if (m) row[c] = params[Number(m[1]) - 1];
        else row[c] = v.replace(/^'|'$/g, '');
      });
      T[ins[1]!]!.push(hydrate(row));
      return text.includes('RETURNING *') ? [row] : [];
    }

    // ---------------- UPDATE ----------------
    if (text.startsWith('UPDATE goals SET')) {
      const row = T.goals.find((r) => r.id === id(1));
      if (!row) return [];
      for (const [, k, expr] of [...text.matchAll(/(\w+)\s*=\s*([^,]+)/g)]) {
        const m = /\$(\d+)/.exec(expr ?? '');
        if (m) row[k!] = params[Number(m[1]) - 1];
        else if ((expr ?? '').startsWith('now()')) row[k!] = new Date().toISOString();
        else if ((expr ?? '').includes('COALESCE')) row[k!] = row[k!] ?? new Date().toISOString();
        else row[k!] = (expr ?? '').replace(/^'|'$/g, '');
      }
      hydrate(row);
      return [];
    }
    if (text.startsWith('UPDATE tasks SET') && text.includes('goal_id')) {
      const target = T.tasks.filter((t) => t.agent_run_id === id(1));
      for (const t of target) t.goal_id = id(2);
      return [];
    }
    if (text.startsWith('UPDATE escalations SET')) {
      const row = T.escalations.find((r) => r.id === id(1) && r.owner_id === id(4));
      if (!row) return [];
      for (const [, k, expr] of [...text.matchAll(/(\w+)\s*=\s*([^,]+)/g)]) {
        const m = /\$(\d+)/.exec(expr ?? '');
        if (m) row[k!] = params[Number(m[1]) - 1];
        else if ((expr ?? '').startsWith('now()')) row[k!] = new Date().toISOString();
        else row[k!] = (expr ?? '').replace(/^'|'$/g, '');
      }
      return [];
    }

    // ---------------- SELECT ----------------
    if (text.includes('SUM(spent_usd)')) {
      const runIds = Array.isArray(params[1]) ? (params[1] as string[]) : [];
      const rows = T.ai_agent_runs.filter((r) => r.owner_id === id(1) && runIds.includes(r.id));
      return [{ total: rows.reduce((s, r) => s + Number(r.spent_usd ?? 0), 0) }];
    }
    if (text.includes('COUNT(*)') && text.includes('goal_id = $2')) {
      const rows = T.tasks.filter((r) => r.owner_id === id(1) && r.goal_id === id(2));
      const count = (p: (s: string) => boolean) => rows.filter((r) => p(String(r.status))).length;
      return [{
        total: rows.length,
        completed: count((s) => s === 'COMPLETED'),
        running: count((s) => ['RUNNING', 'THINKING', 'TESTING', 'VERIFIED'].includes(s)),
        failed: count((s) => ['FAILED', 'TIMED_OUT'].includes(s)),
        blocked: count((s) => ['BLOCKED', 'REQUIRES_REVIEW', 'WAITING_FOR_LOCAL_AGENT'].includes(s)),
        pending: count((s) => ['CREATED', 'PLANNED', 'CHANGED', 'WAITING_APPROVAL'].includes(s)),
      }];
    }
    if (text.includes('FROM tasks') && text.includes('agent_run_id = $1')) {
      return T.tasks.filter((r) => r.agent_run_id === id(1)).slice(0, Number(params[params.length - 1] ?? 1));
    }
    if (text.includes('FROM ai_agent_runs') && text.includes('WHERE id = $1')) {
      return T.ai_agent_runs.filter((r) => r.id === id(1)).map((r) => ({
        status: r.status, error: r.error ?? null, spent_usd: r.spent_usd ?? null,
      }));
    }
    if (text.includes('FROM goals') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.goals.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM goals') && text.includes('WHERE id = $1')) {
      return T.goals.filter((r) => r.id === id(1));
    }
    if (text.includes('FROM goals') && text.includes('owner_id = $1')) {
      let rows = T.goals.filter((r) => r.owner_id === id(1));
      const stm = /AND status = \$(\d+)/.exec(text);
      if (stm) rows = rows.filter((r) => r.status === String(params[Number(stm[1]) - 1]));
      return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (text.includes('FROM goal_activities')) {
      if (text.includes("event = 'memory_fed'")) {
        return T.goal_activities.filter((r) => r.goal_id === id(1) && r.event === 'memory_fed').slice(0, 1).map(hydrate);
      }
      const rows = T.goal_activities.filter((r) => r.goal_id === id(1) && r.owner_id === id(2));
      return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Number(params[2] ?? 50)).map(hydrate);
    }
    if (text.includes('FROM escalations') && text.includes('goal_id = $1')) {
      return T.escalations.filter((r) => r.goal_id === id(1) && r.status === 'OPEN').slice(0, 1);
    }
    if (text.includes('FROM escalations') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.escalations.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM escalations') && text.includes('owner_id = $1')) {
      let rows = T.escalations.filter((r) => r.owner_id === id(1));
      const stm = /AND status = \$(\d+)/.exec(text);
      if (stm) rows = rows.filter((r) => r.status === String(params[Number(stm[1]) - 1]));
      return rows;
    }
    if (text.includes('FROM projects')) {
      return T.projects.filter((r) => r.id === id(1) && r.owner_id === id(2) && r.deleted_at == null);
    }

    return [];
  };
  db.state.resolve = resolve;
}

const AGENT = (over: Record<string, unknown> = {}) => ({
  id: 'agt-1', owner_id: 'u1', name: 'Coder One', role: 'CODER', status: 'IDLE',
  trust_level: 'L2', max_tasks_per_run: 5, ...over,
});

const PLAN_ENTRY = (over: Record<string, unknown> = {}) => ({
  id: 'e1', title: 'Write tests', description: 'Write the tests', role: 'CODER', agentId: 'agt-1',
  dependsOn: [], risk: 'MEDIUM', status: 'PENDING', runId: null, taskIds: [], attempts: 0, error: null,
  ...over,
});

const GOAL = (over: Record<string, unknown> = {}) => ({
  id: 'gol-1', owner_id: 'u1', project_id: null, title: 'Ship the feature', objective: 'Ship the feature',
  success_criteria: ['tests green'], constraints: [], status: 'DRAFT', plan: [], progress: {},
  evidence: [], blockers: [], budget_usd: 5, spent_usd: 0, deadline_at: null, estimated_cost_usd: null,
  require_approval: true, approval_id: null, approved_at: null, error: null, completed_at: null,
  created_at: '2026-08-19T09:00:00.000Z', updated_at: '2026-08-19T09:00:00.000Z',
  ...over,
});

const ESCALATION = (over: Record<string, unknown> = {}) => ({
  id: 'esc-1', owner_id: 'u1', goal_id: 'gol-1', schedule_id: null, issue: 'Step failed',
  evidence: [], attempted_actions: ['execute:e1'], options: ['APPROVE', 'EDIT_PLAN', 'RETRY', 'PAUSE', 'CANCEL'],
  recommendation: 'RETRY', risk: 'MEDIUM', status: 'OPEN', user_decision: null, decision_note: null,
  resolved_at: null, created_at: '2026-08-19T09:00:00.000Z',
  ...over,
});

function seedGoal(over: Record<string, unknown> = {}) {
  const goal = GOAL(over);
  db.state.tables.goals.push(goal);
  return goal;
}

beforeEach(() => {
  for (const k of Object.keys(db.state.tables)) db.state.tables[k] = [];
  wireDb();
  audit.recordAudit.mockClear();
  agents.getAgent.mockReset();
  agents.startRun.mockReset();
  agents.startRun.mockResolvedValue({ id: 'run-1' });
  agents.listAgents.mockReset();
  agents.listAgents.mockResolvedValue([AGENT()]);
  agents.cancelRun.mockReset();
  agents.cancelRun.mockResolvedValue({});
  notifyMock.notify.mockClear();
  gateway.completeWithFallback.mockReset();
  gateway.completeWithFallback.mockRejectedValue(new Error('provider down'));
  approvals.createApproval.mockClear();
  approvals.decideApproval.mockClear();
  memory.createMemory.mockClear();
  dna.retrieveDnaForPrompt.mockClear();
  decisions.detectConflict.mockClear();
});

describe('goal service', () => {
  it('creates a goal with defaults and audits it', async () => {
    const goal = await createGoal('u1', { title: '  Launch v2  ', objective: 'Ship v2' });
    expect(goal.id).toMatch(/^gol_/);
    expect(goal.status).toBe('DRAFT');
    expect(goal.budget_usd).toBe(5);
    expect(goal.require_approval).toBe(true);
    expect(goal.success_criteria).toEqual([]);
    expect(db.state.tables.goals[0]?.owner_id).toBe('u1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'goal.created', actorUserId: 'u1', scope: 'USER', tenantId: 'u1', resourceType: 'goal', resourceId: goal.id,
    }));
    expect(db.state.tables.goal_activities[0]?.event).toBe('goal_created');
  });

  it('rejects missing title or objective and a foreign project', async () => {
    await expect(createGoal('u1', { title: '', objective: 'x' })).rejects.toMatchObject({ errorCode: 'title_objective_required' });
    await expect(createGoal('u1', { title: 't', objective: '' })).rejects.toMatchObject({ errorCode: 'title_objective_required' });
    await expect(createGoal('u1', { title: 't', objective: 'x', projectId: 'prj-nope' })).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('enforces tenant isolation on every read', async () => {
    seedGoal(GOAL({ status: 'PLAN_READY' }));
    await expect(getGoal('u2', 'gol-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    expect(await listGoals('u2')).toHaveLength(0);
    db.state.tables.goal_activities.push({ id: 'ga-1', goal_id: 'gol-1', owner_id: 'u1', event: 'x', detail: '{}', created_at: '2026-08-19T09:00:00.000Z' });
    expect(await listGoalActivities('u2', 'gol-1')).toHaveLength(0);
  });

  it('lists goals with an optional status filter and activities newest-first', async () => {
    seedGoal(GOAL({ status: 'PLAN_READY' }));
    seedGoal(GOAL({ id: 'gol-2', status: 'COMPLETED', created_at: '2026-08-18T09:00:00.000Z' }));
    const ready = await listGoals('u1', 'PLAN_READY');
    expect(ready.map((g) => g.id)).toEqual(['gol-1']);
    expect(await listGoals('u1')).toHaveLength(2);

    db.state.tables.goal_activities.push(
      { id: 'ga-1', goal_id: 'gol-1', owner_id: 'u1', event: 'old', detail: '{}', created_at: '2026-08-18T09:00:00.000Z' },
      { id: 'ga-2', goal_id: 'gol-1', owner_id: 'u1', event: 'new', detail: '{"k":1}', created_at: '2026-08-19T09:00:00.000Z' },
    );
    const acts = await listGoalActivities('u1', 'gol-1', 1);
    expect(acts.map((a) => a.event)).toEqual(['new']);
    expect(acts[0]?.detail).toEqual({ k: 1 });
  });
});

describe('goal planning', () => {
  it('falls back to a deterministic plan when the AI planner is down', async () => {
    seedGoal();
    const goal = await generateGoalPlan('u1', 'gol-1');
    expect(goal.status).toBe('PLAN_READY');
    expect(goal.plan).toHaveLength(1);
    expect(goal.plan[0]).toMatchObject({ id: 'e1', title: 'Ship the feature', agentId: 'agt-1', status: 'PENDING', risk: 'MEDIUM' });
    expect(db.state.tables.goal_activities.some((a) => a.event === 'planning_fallback')).toBe(true);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'goal.plan_generated', detail: expect.objectContaining({ source: 'default_fallback' }),
    }));
  });

  it('uses the planner output when available and assigns agents by role', async () => {
    gateway.completeWithFallback.mockResolvedValue({
      text: '[{"title":"Research","description":"Research markets","role":"researcher"},{"title":"Build","description":"Build it","role":"CODER"}]',
      cost: 0.01, usage: { inputTokens: 1, outputTokens: 2 },
    });
    agents.listAgents.mockResolvedValue([
      AGENT({ id: 'agt-c', role: 'CODER' }),
      AGENT({ id: 'agt-r', role: 'RESEARCHER' }),
    ]);
    seedGoal();
    const goal = await generateGoalPlan('u1', 'gol-1');
    expect(goal.plan.map((e) => e.title)).toEqual(['Research', 'Build']);
    expect(goal.plan[0]?.agentId).toBe('agt-r');
    expect(goal.plan[1]?.agentId).toBe('agt-c');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'goal.plan_generated', detail: expect.objectContaining({ source: 'planner', entries: 2, agentsAssigned: 2 }),
    }));
  });

  it('surfaces conflicting historical decisions as blockers instead of ignoring them', async () => {
    decisions.detectConflict.mockResolvedValue({ conflicts: [{ decisionId: 'dec-1', summary: 'you chose X before' }] });
    seedGoal();
    const goal = await generateGoalPlan('u1', 'gol-1');
    expect(goal.blockers).toHaveLength(1);
    expect(goal.blockers[0]).toMatchObject({ type: 'decision_conflict' });
  });

  it('rejects planning without agents or from a non-planable status', async () => {
    seedGoal();
    agents.listAgents.mockResolvedValue([]);
    await expect(generateGoalPlan('u1', 'gol-1')).rejects.toMatchObject({ errorCode: 'no_agents_available' });

    agents.listAgents.mockResolvedValue([AGENT()]);
    seedGoal(GOAL({ id: 'gol-2', status: 'RUNNING' }));
    await expect(generateGoalPlan('u1', 'gol-2')).rejects.toMatchObject({ errorCode: 'goal_not_planable' });
  });

  it('updateGoalPlan revalidates entries, dependencies and risk server-side', async () => {
    agents.listAgents.mockResolvedValue([
      AGENT({ id: 'agt-c', role: 'CODER' }),
      AGENT({ id: 'agt-r', role: 'RESEARCHER' }),
    ]);
    seedGoal(GOAL({ status: 'PLAN_READY' }));
    const goal = await updateGoalPlan('u1', 'gol-1', [
      { title: 'Research', role: 'researcher' },
      { title: 'Build', role: 'CODER', dependsOn: ['e1'], risk: 'HIGH' },
    ]);
    expect(goal.status).toBe('PLAN_READY');
    expect(goal.plan.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(goal.plan[0]?.agentId).toBe('agt-r');
    expect(goal.plan[1]).toMatchObject({ dependsOn: ['e1'], risk: 'HIGH', agentId: 'agt-c' });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.updated', detail: expect.objectContaining({ planEdited: true }) }));

    await expect(updateGoalPlan('u1', 'gol-1', [{ title: 'x', dependsOn: ['e9'] }])).rejects.toMatchObject({ errorCode: 'invalid_dependency' });
    await expect(updateGoalPlan('u1', 'gol-1', [{ title: 'x', risk: 'HOT' }])).rejects.toMatchObject({ errorCode: 'invalid_risk' });
    await expect(updateGoalPlan('u1', 'gol-1', [])).rejects.toMatchObject({ errorCode: 'invalid_plan' });
  });

  it('blocks plan edits while the goal is running', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [PLAN_ENTRY()] }));
    await expect(updateGoalPlan('u1', 'gol-1', [{ title: 'x' }])).rejects.toMatchObject({ errorCode: 'goal_not_editable' });
  });
});

describe('goal start and approval', () => {
  it('requires PLAN_READY and assigned agents before starting', async () => {
    seedGoal(GOAL({ status: 'PLAN_READY', plan: [PLAN_ENTRY({ agentId: null })] }));
    await expect(startGoal('u1', 'gol-1')).rejects.toMatchObject({ errorCode: 'unassigned_entries' });
    seedGoal(GOAL({ id: 'gol-2', status: 'DRAFT' }));
    await expect(startGoal('u1', 'gol-2')).rejects.toMatchObject({ errorCode: 'goal_not_ready' });
  });

  it('stops at the approval gate when require_approval is on and notifies', async () => {
    seedGoal(GOAL({ status: 'PLAN_READY', plan: [PLAN_ENTRY()] }));
    const goal = await startGoal('u1', 'gol-1');
    expect(goal.status).toBe('WAITING_FOR_APPROVAL');
    expect(goal.approval_id).toBe('apr-1');
    expect(approvals.createApproval).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u1', taskId: null, riskLevel: 'HIGH' }));
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'agent.approval_required', expect.stringContaining('approval'), expect.objectContaining({ resourceType: 'goal', resourceId: 'gol-1' }));
    expect(db.state.tables.goal_activities.some((a) => a.event === 'approval_requested')).toBe(true);
    expect(agents.startRun).not.toHaveBeenCalled();
  });

  it('decideGoalApproval APPROVE executes the goal through the real engine', async () => {
    seedGoal(GOAL({ status: 'WAITING_FOR_APPROVAL', approval_id: 'apr-1', plan: [PLAN_ENTRY()] }));
    db.state.tables.tasks.push({ id: 't-1', owner_id: 'u1', agent_run_id: 'run-1', goal_id: null, status: 'CREATED', created_at: '2026-08-19T09:00:00.000Z' });
    const goal = await decideGoalApproval('u1', 'gol-1', 'APPROVE');
    expect(approvals.decideApproval).toHaveBeenCalledWith('u1', 'apr-1', 'APPROVE', undefined);
    expect(goal.status).toBe('RUNNING');
    expect(goal.plan[0]?.status).toBe('RUNNING');
    expect(goal.plan[0]?.runId).toBe('run-1');
    expect(agents.startRun).toHaveBeenCalledWith('u1', 'agt-1', expect.objectContaining({
      objective: 'Write tests', requireApproval: false,
    }));
    expect(db.state.tables.tasks[0]?.goal_id).toBe('gol-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.started' }));
  });

  it('decideGoalApproval REJECT returns to PLAN_READY', async () => {
    seedGoal(GOAL({ status: 'WAITING_FOR_APPROVAL', approval_id: 'apr-1', plan: [PLAN_ENTRY()] }));
    const goal = await decideGoalApproval('u1', 'gol-1', 'REJECT', 'too expensive');
    expect(goal.status).toBe('PLAN_READY');
    expect(agents.startRun).not.toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.updated', detail: expect.objectContaining({ approvalRejected: true, reason: 'too expensive' }) }));
  });

  it('rejects approval decisions when nothing is pending', async () => {
    seedGoal(GOAL({ status: 'PLAN_READY', plan: [PLAN_ENTRY()] }));
    await expect(decideGoalApproval('u1', 'gol-1', 'APPROVE')).rejects.toMatchObject({ errorCode: 'no_pending_approval' });
  });

  it('executes immediately when approvals are not required', async () => {
    seedGoal(GOAL({ require_approval: false, status: 'PLAN_READY', plan: [PLAN_ENTRY()] }));
    const goal = await startGoal('u1', 'gol-1');
    expect(goal.status).toBe('RUNNING');
    expect(goal.plan[0]?.runId).toBe('run-1');
    expect(approvals.createApproval).not.toHaveBeenCalled();
  });

  it('blocks a running entry when its agent is busy', async () => {
    agents.listAgents.mockResolvedValue([AGENT({ status: 'BUSY' })]);
    seedGoal(GOAL({ require_approval: false, status: 'PLAN_READY', plan: [PLAN_ENTRY()] }));
    const goal = await startGoal('u1', 'gol-1');
    expect(goal.plan[0]?.status).toBe('BLOCKED');
    expect(goal.plan[0]?.error).toContain('agent_busy');
    expect(agents.startRun).not.toHaveBeenCalled();
  });
});

describe('goal execution and evidence', () => {
  it('completes only with evidence, feeds memory once and notifies', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [PLAN_ENTRY({ status: 'RUNNING', runId: 'run-1', taskIds: ['t-1'] })] }));
    db.state.tables.ai_agent_runs.push({ id: 'run-1', owner_id: 'u1', status: 'COMPLETED', error: null, spent_usd: 0.5 });
    db.state.tables.tasks.push({ id: 't-1', owner_id: 'u1', agent_run_id: 'run-1', goal_id: 'gol-1', status: 'COMPLETED', created_at: '2026-08-19T09:00:00.000Z' });
    const goal = await refreshGoal('u1', 'gol-1');
    expect(goal.status).toBe('COMPLETED');
    expect(goal.plan[0]?.status).toBe('COMPLETED');
    expect(goal.evidence).toHaveLength(1);
    expect(goal.evidence[0]).toMatchObject({ entryId: 'e1', runId: 'run-1', taskIds: ['t-1'], status: 'COMPLETED' });
    expect(goal.progress.percent).toBe(100);
    expect(goal.completed_at).not.toBeNull();
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'goal.completed', expect.stringContaining('Ship the feature'), expect.objectContaining({ resourceId: 'gol-1' }));
    expect(memory.createMemory).toHaveBeenCalledWith('u1', expect.objectContaining({
      type: 'SEMANTIC', source: 'AI_INFERRED', provenance: 'goal:gol-1',
      structured: expect.objectContaining({ outcome: 'COMPLETED' }),
    }));
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.memory_fed' }));
    expect(db.state.tables.goal_activities.some((a) => a.event === 'memory_fed')).toBe(true);
  });

  it('never feeds memory twice for the same goal', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [PLAN_ENTRY({ status: 'RUNNING', runId: 'run-1' })] }));
    db.state.tables.ai_agent_runs.push({ id: 'run-1', owner_id: 'u1', status: 'COMPLETED', error: null, spent_usd: 0.1 });
    db.state.tables.goal_activities.push({ id: 'ga-x', goal_id: 'gol-1', owner_id: 'u1', event: 'memory_fed', detail: '{}', created_at: '2026-08-19T09:00:00.000Z' });
    await refreshGoal('u1', 'gol-1');
    expect(memory.createMemory).not.toHaveBeenCalled();
  });

  it('stays BLOCKED with no_evidence and auto-escalates when evidence is missing', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [PLAN_ENTRY({ status: 'COMPLETED', runId: 'run-1' })], evidence: [] }));
    const goal = await refreshGoal('u1', 'gol-1');
    expect(goal.status).toBe('WAITING_FOR_HUMAN_DECISION');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.blocked', detail: expect.objectContaining({ reason: 'no_evidence' }) }));
    const esc = db.state.tables.escalations[0];
    expect(esc?.status).toBe('OPEN');
    expect(esc?.options).toContain('RETRY');
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'goal.escalation_needs_decision', expect.stringContaining('decision'), expect.anything());
    expect(db.state.tables.goal_activities.some((a) => a.event === 'escalated')).toBe(true);
  });

  it('blocks on budget exceeded and deadline exceeded with honest reasons', async () => {
    seedGoal(GOAL({ status: 'RUNNING', budget_usd: 1, plan: [PLAN_ENTRY({ status: 'RUNNING', runId: 'run-1' })] }));
    db.state.tables.ai_agent_runs.push({ id: 'run-1', owner_id: 'u1', status: 'RUNNING', error: null, spent_usd: 3 });
    const goal = await refreshGoal('u1', 'gol-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.blocked', detail: expect.objectContaining({ reason: 'budget_exceeded', spentUsd: 3 }) }));
    expect(goal.error).toBe('budget_exceeded');
    expect(db.state.tables.escalations[0]?.status).toBe('OPEN');

    seedGoal(GOAL({ id: 'gol-2', status: 'RUNNING', deadline_at: new Date(Date.now() - 60_000).toISOString(), plan: [PLAN_ENTRY()] }));
    const g2 = await refreshGoal('u1', 'gol-2');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.failed', detail: expect.objectContaining({ reason: 'deadline_exceeded' }) }));
    expect(g2.error).toBe('deadline_exceeded');
  });

  it('detects real dependency deadlocks', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [
      PLAN_ENTRY({ id: 'e1', status: 'BLOCKED', error: 'agent_busy (BUSY)' }),
      PLAN_ENTRY({ id: 'e2', status: 'PENDING', dependsOn: ['e1'] }),
    ] }));
    const goal = await refreshGoal('u1', 'gol-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.blocked', detail: expect.objectContaining({ reason: 'dependency_blocked' }) }));
    expect(goal.error).toBe('dependency_blocked');
  });

  it('advances to the next entry once a dependency completes', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [
      PLAN_ENTRY({ id: 'e1', status: 'COMPLETED', runId: 'run-1' }),
      PLAN_ENTRY({ id: 'e2', status: 'PENDING', dependsOn: ['e1'] }),
    ] }));
    const goal = await refreshGoal('u1', 'gol-1');
    expect(goal.status).toBe('RUNNING');
    expect(goal.plan[1]?.status).toBe('RUNNING');
    expect(goal.plan[1]?.runId).toBe('run-1');
    expect(agents.startRun).toHaveBeenCalledWith('u1', 'agt-1', expect.objectContaining({ objective: 'Write tests' }));
  });
});

describe('goal pause, resume and cancel', () => {
  it('pauses only from runnable states', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [PLAN_ENTRY({ status: 'RUNNING' })] }));
    const paused = await pauseGoal('u1', 'gol-1');
    expect(paused.status).toBe('PAUSED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.paused' }));
    await expect(pauseGoal('u1', 'gol-1')).rejects.toMatchObject({ errorCode: 'goal_not_pausable' });
  });

  it('resumes from PAUSED and kicks the next runnable entry', async () => {
    seedGoal(GOAL({ status: 'PAUSED', plan: [PLAN_ENTRY()] }));
    const goal = await resumeGoal('u1', 'gol-1');
    expect(goal.status).toBe('RUNNING');
    expect(goal.plan[0]?.status).toBe('RUNNING');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.resumed' }));
  });

  it('cancels running entries and marks the goal CANCELLED', async () => {
    seedGoal(GOAL({ status: 'RUNNING', plan: [PLAN_ENTRY({ status: 'RUNNING', runId: 'run-1' })] }));
    const goal = await cancelGoal('u1', 'gol-1', 'no longer needed');
    expect(goal.status).toBe('CANCELLED');
    expect(agents.cancelRun).toHaveBeenCalledWith('u1', 'run-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.cancelled', detail: expect.objectContaining({ reason: 'no longer needed' }) }));
    await expect(cancelGoal('u1', 'gol-1')).rejects.toMatchObject({ errorCode: 'goal_terminal' });
  });
});

describe('escalations', () => {
  it('createEscalation validates target, issue and risk', async () => {
    await expect(createEscalation('u1', { issue: 'x' })).rejects.toMatchObject({ errorCode: 'escalation_target_required' });
    await expect(createEscalation('u1', { goalId: 'gol-1', issue: '  ' })).rejects.toMatchObject({ errorCode: 'issue_required' });
    await expect(createEscalation('u1', { goalId: 'gol-1', issue: 'x', risk: 'HOT' })).rejects.toMatchObject({ errorCode: 'invalid_risk' });
    const esc = await createEscalation('u1', { goalId: 'gol-1', issue: 'Agent crashed', risk: 'HIGH', recommendation: 'RETRY' });
    expect(esc.id).toMatch(/^esc_/);
    expect(esc.status).toBe('OPEN');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.escalated', detail: expect.objectContaining({ goalId: 'gol-1', risk: 'HIGH' }) }));
  });

  it('decideEscalation RETRY resets failed entries and resumes', async () => {
    seedGoal(GOAL({ status: 'WAITING_FOR_HUMAN_DECISION', plan: [
      PLAN_ENTRY({ id: 'e1', status: 'FAILED', error: 'provider offline', attempts: 1 }),
      PLAN_ENTRY({ id: 'e2', status: 'COMPLETED', runId: 'run-2' }),
    ] }));
    db.state.tables.escalations.push(ESCALATION());
    const esc = await decideEscalation('u1', 'esc-1', 'RETRY', 'try again');
    expect(esc.status).toBe('RESOLVED');
    expect(esc.user_decision).toBe('RETRY');
    const goal = await getGoal('u1', 'gol-1');
    expect(goal.status).toBe('RUNNING');
    expect(goal.plan[0]?.status).toBe('RUNNING');
    expect(goal.plan[0]?.attempts).toBe(2);
    expect(agents.startRun).toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'goal.escalation_decided', detail: expect.objectContaining({ decision: 'RETRY' }) }));
  });

  it('decideEscalation EDIT_PLAN, PAUSE, CANCEL and REJECT route correctly', async () => {
    const mk = (id: string) => {
      seedGoal(GOAL({ id, status: 'WAITING_FOR_HUMAN_DECISION', plan: [PLAN_ENTRY({ status: 'FAILED' })] }));
      db.state.tables.escalations.push(ESCALATION({ id: `esc-${id}`, goal_id: id }));
    };
    mk('gol-1');
    await decideEscalation('u1', 'esc-gol-1', 'EDIT_PLAN');
    expect((await getGoal('u1', 'gol-1')).status).toBe('PLAN_READY');

    mk('gol-2');
    await decideEscalation('u1', 'esc-gol-2', 'PAUSE');
    expect((await getGoal('u1', 'gol-2')).status).toBe('PAUSED');

    mk('gol-3');
    await decideEscalation('u1', 'esc-gol-3', 'CANCEL');
    expect((await getGoal('u1', 'gol-3')).status).toBe('CANCELLED');

    mk('gol-4');
    await decideEscalation('u1', 'esc-gol-4', 'REJECT', 'no');
    expect((await getGoal('u1', 'gol-4')).status).toBe('BLOCKED');
    expect((await getGoal('u1', 'gol-4')).error).toBe('recommendation_rejected');
  });

  it('rejects decisions on resolved escalations and foreign escalations', async () => {
    seedGoal(GOAL({ status: 'WAITING_FOR_HUMAN_DECISION' }));
    db.state.tables.escalations.push(ESCALATION({ status: 'RESOLVED' }));
    await expect(decideEscalation('u1', 'esc-1', 'RETRY')).rejects.toMatchObject({ errorCode: 'escalation_not_open' });
    db.state.tables.escalations.push(ESCALATION({ id: 'esc-2', owner_id: 'u2' }));
    await expect(getEscalation('u1', 'esc-2')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('lists escalations scoped to the caller', async () => {
    seedGoal();
    db.state.tables.escalations.push(ESCALATION(), ESCALATION({ id: 'esc-2', owner_id: 'u2' }));
    expect(await listEscalations('u1')).toHaveLength(1);
    expect(await listEscalations('u1', 'RESOLVED')).toHaveLength(0);
  });
});