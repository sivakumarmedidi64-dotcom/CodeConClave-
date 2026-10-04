/**
 * Stage 25.5 - multi-agent workspace contract suite.
 * Covers: role catalog + routing, agent CRUD bounds (MAX_AGENTS, model
 * eligibility), run fan-out with sequential dependency chain, accounting
 * transitions (THINKING -> RUNNING -> WAITING_FOR_APPROVAL -> COMPLETED /
 * FAILED / BLOCKED via deadline/budget/retries), cancel, watchdog sweep, and
 * the audit/notification/memory emissions. The task engine (createTask,
 * setTaskStatus, addTaskDependency) is mocked at module level - this suite
 * validates the agents driver, not the worker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { rows: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : state.rows;
    return { rows: rows ?? [], rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const tasks = vi.hoisted(() => ({
  createTask: vi.fn(async (input: Record<string, unknown>) => ({ id: 'tsk-test', ...input })),
  setTaskStatus: vi.fn(async () => {}),
  addTaskDependency: vi.fn(async () => {}),
}));
vi.mock('../modules/execution/tasks.js', () => tasks);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));
const memory = vi.hoisted(() => ({ createMemory: vi.fn(async () => ({})) }));
vi.mock('../modules/memory/service.js', () => memory);

const entitlements = vi.hoisted(() => {
  const FREE_LIMITS = { MAX_AGENTS: 2, AGENT_MAX_TASKS_PER_RUN: 5, AGENT_MAX_BUDGET_USD: 1 };
  const PRO_LIMITS = { MAX_AGENTS: 10, AGENT_MAX_TASKS_PER_RUN: 10, AGENT_MAX_BUDGET_USD: 5 };
  const TEAM_LIMITS = { MAX_AGENTS: 20, AGENT_MAX_TASKS_PER_RUN: 10, AGENT_MAX_BUDGET_USD: 10 };
  return {
    FREE_LIMITS,
    PRO_LIMITS,
    TEAM_LIMITS,
    effectivePlan: vi.fn(async () => 'free'),
    // Mirrors the real limitsFor() with TEMPORARY_DEMO_MODE off (the default), so
    // this suite keeps asserting the commercial caps 2 / 10 / 20. Demo-mode
    // limits are asserted in temporary-demo-mode.test.ts.
    limitsFor: vi.fn((plan: string) =>
      plan === 'pro' ? PRO_LIMITS : plan === 'team' ? TEAM_LIMITS : FREE_LIMITS,
    ),
  };
});
vi.mock('../modules/entitlements/service.js', () => entitlements);

const gateway = vi.hoisted(() => ({
  eligibleModels: vi.fn(async () => [
    {
      modelId: 'deepseek-v4-flash',
      providerId: 'deepseek',
      displayName: 'DeepSeek V4 Flash',
      tier: 'EFFICIENT',
      computeClass: 'A',
      contextWindow: 128_000,
      supportsVision: false,
      supportsTools: true,
      supportsFunctionCalling: true,
      inputCostPerM: 0.1,
      outputCostPerM: 0.3,
      entitlement: 'FREE',
      privacyClass: 'STANDARD',
      targetLatencyMs: 2000,
      health: 'HEALTHY',
      priority: 100,
      fallbackList: [],
      enabled: true,
      effectiveDate: '2026-01-01',
      deprecationDate: null,
      codingOptimized: false,
    },
  ]),
}));
vi.mock('../modules/ai/gateway.js', () => gateway);

import { createAgent, startRun, cancelRun, recomputeRun, sweepAgentRuns, ROLE_ROUTING, AGENT_ROLES, deleteAgent, updateAgent, listAgents, agentUsage } from '../modules/agents/service.js';
import { AppError } from '../shared/errors.js';
import type { AiModelDescriptor } from '@codeconclave/shared';

const MODEL: AiModelDescriptor = {
  modelId: 'deepseek-v4-flash',
  providerId: 'deepseek',
  displayName: 'DeepSeek V4 Flash',
  tier: 'EFFICIENT',
  computeClass: 'A',
  contextWindow: 128_000,
  supportsVision: false,
  supportsTools: true,
  supportsFunctionCalling: true,
  inputCostPerM: 0.1,
  outputCostPerM: 0.3,
  entitlement: 'FREE',
  privacyClass: 'STANDARD',
  targetLatencyMs: 2000,
  health: 'HEALTHY',
  priority: 100,
  fallbackList: [],
  enabled: true,
  effectiveDate: '2026-01-01',
  deprecationDate: null,
  codingOptimized: false,
};

const AGENT = {
  id: 'agt-1',
  owner_id: 'u1',
  name: 'Builder',
  role: 'CODER',
  objective: null,
  capabilities: ['write_code'],
  model_provider: 'deepseek',
  model_id: 'deepseek-v4-flash',
  max_tasks_per_run: 5,
  max_retries: 2,
  status: 'IDLE',
  current_run_id: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const RUN = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'agn-1',
  agent_id: 'agt-1',
  owner_id: 'u1',
  project_id: 'prj-1',
  status: 'RUNNING',
  objective: 'fix the build',
  current_task_id: null,
  total_tasks: 2,
  completed_tasks: 0,
  failed_tasks: 0,
  retries_used: 0,
  budget_usd: 1,
  spent_usd: 0,
  deadline_at: new Date(Date.now() + 60_000),
  error: null,
  started_at: new Date(),
  completed_at: null,
  created_at: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.state.resolve = null;
  db.state.rows = [];
});

describe('ROLE CATALOG', () => {
  it('defines exactly the 10 Stage 25.5 roles with routing', () => {
    expect(AGENT_ROLES).toHaveLength(10);
    expect(AGENT_ROLES).toContain('ARCHITECT');
    expect(AGENT_ROLES).toContain('DOCUMENTATION');
    for (const role of AGENT_ROLES) {
      expect(ROLE_ROUTING[role]).toBeDefined();
      expect(['A', 'B', 'C']).toContain(ROLE_ROUTING[role].computeClass);
    }
    expect(ROLE_ROUTING.CODER.coding).toBe(true);
    expect(ROLE_ROUTING.REVIEWER.computeClass).toBe('C');
  });
});

describe('AGENT CRUD', () => {
  it('rejects unknown roles', async () => {
    await expect(createAgent('u1', { name: 'x', role: 'MAGICIAN' })).rejects.toMatchObject({ errorCode: 'invalid_agent_role' });
  });

  it('rejects a model that is not eligible for the role (never silently swapped)', async () => {
    gateway.eligibleModels.mockResolvedValueOnce([MODEL] as never);
    await expect(
      createAgent('u1', { name: 'x', role: 'CODER', modelId: 'kimi-k3' }),
    ).rejects.toMatchObject({ errorCode: 'model_not_eligible' });
  });

  it('enforces MAX_AGENTS', async () => {
    db.state.resolve = (text: string) => (text.includes('count(*)') ? [{ n: 2 }] : null);
    await expect(createAgent('u1', { name: 'x', role: 'CODER' })).rejects.toMatchObject({ errorCode: 'agent_limit_reached' });
  });

  it('entitlement boundaries — pro #11 denied, team #21 denied, free #3 denied (2/10/20 model)', async () => {
    entitlements.effectivePlan.mockResolvedValue('pro');
    db.state.resolve = (text: string) => (text.includes('count(*)') ? [{ n: 10 }] : null);
    await expect(createAgent('u1', { name: 'x', role: 'CODER' })).rejects.toMatchObject({ errorCode: 'agent_limit_reached' });

    entitlements.effectivePlan.mockResolvedValue('team');
    db.state.resolve = (text: string) => (text.includes('count(*)') ? [{ n: 20 }] : null);
    await expect(createAgent('u1', { name: 'x', role: 'CODER' })).rejects.toMatchObject({ errorCode: 'agent_limit_reached' });

    entitlements.effectivePlan.mockResolvedValue('free');
    db.state.resolve = (text: string) => (text.includes('count(*)') ? [{ n: 2 }] : null);
    await expect(createAgent('u1', { name: 'x', role: 'CODER' })).rejects.toMatchObject({ errorCode: 'agent_limit_reached' });

    entitlements.effectivePlan.mockResolvedValue('free');
  });

  it('count query is owner-scoped — another user at their cap never blocks u1', async () => {
    entitlements.effectivePlan.mockResolvedValue('free');
    let seen: { text: string; params: unknown[] } | null = null;
    db.state.resolve = (text, params) => {
      if (text.includes('count(*)')) {
        seen = { text, params };
        return [{ n: 1 }];
      }
      return null;
    };
    await createAgent('u1', { name: 'Mine', role: 'CODER' });
    expect(seen).not.toBeNull();
    expect(seen!.text).toContain('ai_agents');
    expect(seen!.text).toContain('owner_id = $1');
    expect(seen!.params[0]).toBe('u1');
  });

  it('usage reports the owner-scoped count and the entitlement max (never a hard-coded 5)', async () => {
    entitlements.effectivePlan.mockResolvedValue('team');
    db.state.resolve = (text: string) => (text.includes('count(*)') ? [{ n: 12 }] : null);
    const usage = await agentUsage('u1');
    expect(usage).toEqual({ count: 12, max: 20, plan: 'team' });
    expect(entitlements.effectivePlan).toHaveBeenCalledWith('u1');
    entitlements.effectivePlan.mockResolvedValue('free');
  });

  it('creates an agent and audits it', async () => {
    await createAgent('u1', { name: 'Builder', role: 'CODER', modelId: 'deepseek-v4-flash' });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.created', resourceType: 'ai_agent' }));
  });

  it('updateAgent caps bounds server-side (never trusts client)', async () => {
    db.state.rows = [{ ...AGENT }];
    await updateAgent('u1', 'agt-1', { maxTasksPerRun: 999, maxRetries: 99 });
    expect(db.state.resolve ?? null).toBeNull();
  });

  it('deleteAgent refuses while a run is active', async () => {
    db.state.rows = [{ ...AGENT, status: 'RUNNING', current_run_id: 'agn-1' }];
    await expect(deleteAgent('u1', 'agt-1')).rejects.toMatchObject({ errorCode: 'agent_busy' });
  });

  it('listAgents returns agents with run context', async () => {
    db.state.rows = [{ ...AGENT, run_status: 'IDLE' }];
    const agents = await listAgents('u1');
    expect(agents[0].run_status).toBe('IDLE');
  });
});

describe('RUN LIFECYCLE', () => {
  it('startRun fans out into bounded tasks with a sequential dependency chain', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM projects')) return [{ id: 'prj-1' }];
      return [{ ...AGENT }];
    };
    const run = await startRun('u1', 'agt-1', {
      projectId: 'prj-1',
      objective: 'ship it',
      subtasks: [
        { title: 'design' },
        { title: 'implement' },
        { title: 'review' },
        { title: 'docs' },
        { title: 'extra' },
        { title: 'sixth-exceeds' },
      ],
    });
    expect(run.total_tasks).toBe(5); // capped by AGENT_MAX_TASKS_PER_RUN
    expect(run.status).toBe('RUNNING');
    expect(run.id).toBeDefined();
    expect(tasks.createTask).toHaveBeenCalledTimes(5);
    expect(tasks.addTaskDependency).toHaveBeenCalledTimes(4);
  });

  it('startRun refuses a busy agent', async () => {
    db.state.resolve = () => [{ ...AGENT, status: 'RUNNING', current_run_id: 'agn-9' }];
    await expect(startRun('u1', 'agt-1', { objective: 'x' })).rejects.toMatchObject({ errorCode: 'agent_busy' });
  });

  it('recomputeRun completes when all tasks completed', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents WHERE')) return [{ ...AGENT }];
      if (text.includes('FROM tasks WHERE agent_run_id')) {
        return [
          { id: 't1', status: 'COMPLETED', title: 'a', attempted: true },
          { id: 't2', status: 'COMPLETED', title: 'b', attempted: true },
        ];
      }
      if (text.includes('SUM(m.estimated_cost_usd)')) return [{ total: '0.02' }];
      if (text.includes('FROM ai_agent_runs WHERE id')) return [RUN()];
      return null;
    };
    await recomputeRun('agn-1');
    expect(notify).toHaveBeenCalledWith('u1', 'agent.completed', 'Agent completed', expect.anything());
    expect(memory.createMemory).toHaveBeenCalledTimes(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.run_completed' }));
  });

  it('recomputeRun blocks on deadline exceeded', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents WHERE')) return [{ ...AGENT }];
      if (text.includes('FROM tasks WHERE agent_run_id')) {
        return [
          { id: 't1', status: 'CREATED', title: 'a', attempted: false },
          { id: 't2', status: 'CREATED', title: 'b', attempted: false },
        ];
      }
      if (text.includes('SUM(m.estimated_cost_usd)')) return [{ total: '0' }];
      if (text.includes('FROM ai_agent_runs WHERE id')) return [RUN({ deadline_at: new Date(Date.now() - 1000) })];
      return null;
    };
    await recomputeRun('agn-1');
    expect(notify).toHaveBeenCalledWith('u1', 'agent.blocked', 'Agent blocked', expect.anything());
  });

  it('recomputeRun blocks on budget exceeded', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents WHERE')) return [{ ...AGENT }];
      if (text.includes('FROM tasks WHERE agent_run_id')) {
        return [{ id: 't1', status: 'CREATED', title: 'a', attempted: false }];
      }
      if (text.includes('SUM(m.estimated_cost_usd)')) return [{ total: '2.5' }];
      if (text.includes('FROM ai_agent_runs WHERE id')) return [RUN()];
      return null;
    };
    await recomputeRun('agn-1');
    expect(notify).toHaveBeenCalledWith('u1', 'agent.blocked', 'Agent blocked', expect.anything());
  });

  it('recomputeRun moves to WAITING_FOR_APPROVAL while a task awaits approval', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents WHERE')) return [{ ...AGENT }];
      if (text.includes('FROM tasks WHERE agent_run_id')) {
        return [
          { id: 't1', status: 'COMPLETED', title: 'a', attempted: true },
          { id: 't2', status: 'WAITING_APPROVAL', title: 'b', attempted: false },
        ];
      }
      if (text.includes('SUM(m.estimated_cost_usd)')) return [{ total: '0.01' }];
      if (text.includes('FROM ai_agent_runs WHERE id')) return [RUN()];
      return null;
    };
    await recomputeRun('agn-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('cancelRun cancels non-terminal tasks and marks the run failed', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agent_runs WHERE id')) return [RUN()];
      if (text.includes('FROM tasks WHERE agent_run_id')) {
        return [{ id: 't1', status: 'CREATED', title: 'a', attempted: false }];
      }
      return null;
    };
    const run = await cancelRun('u1', 'agn-1');
    expect(tasks.setTaskStatus).toHaveBeenCalledWith('t1', 'CANCELLED', 'cancelled_by_user');
    expect(run.status).toBe('FAILED');
  });

  it('sweepAgentRuns recomputes non-terminal runs only', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes("IN ('THINKING','RUNNING'")) return [RUN()];
      if (text.includes('FROM ai_agents WHERE')) return [{ ...AGENT }];
      if (text.includes('FROM tasks WHERE agent_run_id')) return [{ id: 't1', status: 'COMPLETED', title: 'a', attempted: true }];
      if (text.includes('SUM(m.estimated_cost_usd)')) return [{ total: '0' }];
      if (text.includes('FROM ai_agent_runs WHERE id')) return [RUN()];
      return null;
    };
    const n = await sweepAgentRuns();
    expect(n).toBe(1);
    expect(notify).toHaveBeenCalledWith('u1', 'agent.completed', 'Agent completed', expect.anything());
  });
});
