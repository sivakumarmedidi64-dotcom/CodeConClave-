/**
 * Stage 26 — multi-agent trust levels (L0–L4) contract suite.
 * Covers: plan-max policy (free ≤ L1, pro/team ≤ L3, enterprise ≤ L4),
 * effective-trust clamping (server-derived, never client-set), createAgent
 * clamp + audit, setAgentTrust owner-only + plan rejection + audit trail
 * (agent.trust_changed), and run-start enforcement (L0 → every task
 * approval-gated HIGH; higher trust keeps MEDIUM). The task engine and
 * gateway are mocked — this suite validates the trust driver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentTrustLevel } from '@codeconclave/shared';

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
  createTask: vi.fn(async (input: Record<string, unknown>) => ({ id: 'tsk-trust', ...input })),
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
  const TEAM_LIMITS = { MAX_AGENTS: 20, AGENT_MAX_TASKS_PER_RUN: 10, AGENT_MAX_BUDGET_USD: 5 };
  return {
    FREE_LIMITS,
    PRO_LIMITS,
    TEAM_LIMITS,
    effectivePlan: vi.fn(async () => 'free'),
    // Mirrors the real limitsFor() with TEMPORARY_DEMO_MODE off (the default).
    limitsFor: vi.fn((plan: string) =>
      plan === 'pro' ? PRO_LIMITS : plan === 'team' ? TEAM_LIMITS : FREE_LIMITS,
    ),
  };
});
vi.mock('../modules/entitlements/service.js', () => entitlements);

const gateway = vi.hoisted(() => ({
  eligibleModels: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../modules/ai/gateway.js', () => gateway);

import { createAgent, startRun, setAgentTrust, effectiveTrustLevel, clampTrust, validTrustLevel, MAX_TRUST_BY_PLAN, getAgent, listAgents } from '../modules/agents/service.js';
import { AppError } from '../shared/errors.js';

const AGENT = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'ag-trust-1',
  owner_id: 'u1',
  name: 'Trusty',
  role: 'CODER',
  objective: null,
  capabilities: [],
  model_provider: null,
  model_id: null,
  max_tasks_per_run: 5,
  max_retries: 2,
  status: 'IDLE',
  current_run_id: null,
  trust_level: 'L2',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  ...over,
});

beforeEach(() => {
  entitlements.effectivePlan.mockReset();
  entitlements.effectivePlan.mockResolvedValue('free');
  audit.recordAudit.mockClear();
  tasks.createTask.mockClear();
  db.state.rows = [];
  db.state.resolve = null;
});

describe('TRUST POLICY — plan maxima', () => {
  it('free plan allows at most L1', () => {
    expect(MAX_TRUST_BY_PLAN.free).toBe('L1');
    expect(MAX_TRUST_BY_PLAN.pro).toBe('L3');
    expect(MAX_TRUST_BY_PLAN.team).toBe('L3');
    expect(MAX_TRUST_BY_PLAN.enterprise).toBe('L4');
  });

  it('clamps stored intent by the plan maximum', () => {
    expect(clampTrust('L4', 'L1')).toBe('L1');
    expect(clampTrust('L3', 'L3')).toBe('L3');
    expect(clampTrust('L0', 'L3')).toBe('L0');
    expect(clampTrust('garbage', 'L3')).toBe('L3');
  });

  it('derives effective trust per plan (server-side)', async () => {
    entitlements.effectivePlan.mockResolvedValue('free');
    expect(await effectiveTrustLevel('u1', 'L4')).toBe('L1');
    entitlements.effectivePlan.mockResolvedValue('pro');
    expect(await effectiveTrustLevel('u1', 'L4')).toBe('L3');
    entitlements.effectivePlan.mockResolvedValue('enterprise');
    expect(await effectiveTrustLevel('u1', 'L4')).toBe('L4');
  });

  it('validates trust levels', () => {
    expect(validTrustLevel('L0')).toBe(true);
    expect(validTrustLevel('L4')).toBe(true);
    expect(validTrustLevel('L9')).toBe(false);
  });
});

describe('CREATE AGENT — trust clamped by plan, audited', () => {
  it('clamps a requested L3 to L1 for a free-plan user', async () => {
    db.state.rows = [AGENT({ trust_level: 'L1' })];
    const agent = await createAgent('u1', { name: 'A', role: 'CODER', trustLevel: 'L3' });
    expect(agent.trust_level).toBe('L1');
    expect(agent.effective_trust_level).toBe('L1');
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.created', detail: expect.objectContaining({ trustLevel: 'L1' }) }),
    );
  });

  it('keeps L2 default for entitled plans', async () => {
    entitlements.effectivePlan.mockResolvedValue('pro');
    db.state.rows = [AGENT({ trust_level: 'L2' })];
    const agent = await createAgent('u1', { name: 'A', role: 'CODER' });
    expect(agent.trust_level).toBe('L2');
  });
});

describe('SET AGENT TRUST — owner-only, plan-gated, audited', () => {
  it('changes trust and records agent.trust_changed with from/to', async () => {
    entitlements.effectivePlan.mockResolvedValue('pro');
    let reads = 0;
    db.state.resolve = (text: string) => {
      if (text.includes('UPDATE ai_agents')) return [];
      if (text.includes('FROM ai_agents')) {
        reads += 1;
        return [AGENT({ trust_level: reads === 1 ? 'L1' : 'L2' })];
      }
      return null;
    };
    const agent = await setAgentTrust('u1', 'ag-trust-1', 'L2');
    expect(agent.trust_level).toBe('L2');
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.trust_changed',
        resourceId: 'ag-trust-1',
        detail: { from: 'L1', to: 'L2' },
      }),
    );
  });

  it('rejects a level above the plan maximum (never silently downgrades)', async () => {
    entitlements.effectivePlan.mockResolvedValue('pro');
    db.state.resolve = (text: string) => (text.includes('FROM ai_agents') ? [AGENT()] : null);
    await expect(setAgentTrust('u1', 'ag-trust-1', 'L4')).rejects.toMatchObject({ errorCode: 'trust_above_plan' });
    expect(audit.recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.trust_changed' }));
  });

  it('rejects unknown trust levels', async () => {
    db.state.rows = [AGENT()];
    await expect(setAgentTrust('u1', 'ag-trust-1', 'L9')).rejects.toMatchObject({ errorCode: 'invalid_trust_level' });
  });

  it('does not allow trust changes on agents the user does not own', async () => {
    db.state.resolve = () => [];
    await expect(setAgentTrust('u1', 'missing', 'L1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('RUN START — trust enforcement', () => {
  it('an L0 agent produces approval-gated (HIGH) tasks even without requireApproval', async () => {
    entitlements.effectivePlan.mockResolvedValue('free');
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents')) return [AGENT({ trust_level: 'L0' })];
      if (text.includes('FROM projects')) return [{ id: 'p1' }];
      if (text.includes('SELECT count(*)')) return [{ n: 1 }];
      return null;
    };
    const run = await startRun('u1', 'ag-trust-1', { objective: 'Fix the bug' });
    expect(run.status).toBe('RUNNING');
    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ riskLevel: 'HIGH' }));
  });

  it('an L1 agent keeps MEDIUM risk unless requireApproval is set', async () => {
    entitlements.effectivePlan.mockResolvedValue('free');
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents')) return [AGENT({ trust_level: 'L2' })];
      if (text.includes('FROM projects')) return [{ id: 'p1' }];
      if (text.includes('SELECT count(*)')) return [{ n: 1 }];
      return null;
    };
    const run = await startRun('u1', 'ag-trust-1', { objective: 'Fix the bug' });
    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ riskLevel: 'MEDIUM' }));
  });

  it('requireApproval still forces HIGH regardless of trust', async () => {
    entitlements.effectivePlan.mockResolvedValue('free');
    db.state.resolve = (text: string) => {
      if (text.includes('FROM ai_agents')) return [AGENT({ trust_level: 'L2' })];
      if (text.includes('FROM projects')) return [{ id: 'p1' }];
      if (text.includes('SELECT count(*)')) return [{ n: 1 }];
      return null;
    };
    await startRun('u1', 'ag-trust-1', { objective: 'Fix', requireApproval: true });
    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ riskLevel: 'HIGH' }));
  });
});

describe('READS — effective trust exposed', () => {
  it('listAgents and getAgent report effective_trust_level', async () => {
    entitlements.effectivePlan.mockResolvedValue('free');
    db.state.rows = [AGENT({ trust_level: 'L3' })];
    const list = await listAgents('u1');
    expect(list[0].trust_level).toBe('L3');
    expect(list[0].effective_trust_level).toBe('L1');
    const one = await getAgent('u1', 'ag-trust-1');
    expect(one.effective_trust_level).toBe('L1');
  });
});

describe('SHARED CONTRACT — taxonomy', () => {
  it('exposes the five levels with labels', () => {
    expect(AgentTrustLevel.L0).toBe('L0');
    expect(AgentTrustLevel.L4).toBe('L4');
  });
});