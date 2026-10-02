/**
 * Stage 26 — agent debate mode contract suite.
 * Covers: creation validation (>=2 proposers, <=5, judge not a proposer),
 * budget pre-flight, independent bounded proposals, per-agent FAILED rows
 * (never hidden), judge verdict contract (parseable JSON, real winner only),
 * WAITING_FOR_APPROVAL -> approve/reject flow through the EXISTING startRun
 * pipeline, cancellation, deadlines, and the full audit trail. The AI gateway
 * and the agents service are mocked; this suite validates the debate driver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditAction } from '@codeconclave/shared';

const db = vi.hoisted(() => {
  const state: {
    debate: Record<string, unknown> | null;
    proposals: Array<Record<string, unknown>>;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { debate: null, proposals: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

const gateway = vi.hoisted(() => ({
  completeWithFallback: vi.fn(),
  estimatedCostOfRequest: vi.fn(async () => 0.01),
}));
vi.mock('../modules/ai/gateway.js', () => gateway);

const entitlements = vi.hoisted(() => ({ effectivePlan: vi.fn(async () => 'pro') }));
vi.mock('../modules/entitlements/service.js', () => entitlements);

const agents = vi.hoisted(() => ({
  getAgent: vi.fn(),
  startRun: vi.fn(),
}));
vi.mock('../modules/agents/service.js', () => agents);

import { createAndRunDebate, runDebate, cancelDebate, decideDebate, listDebates, MAX_DEBATE_AGENTS } from '../modules/agents/debates.js';
import { AppError } from '../shared/errors.js';

const AGENT = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'ag-1',
  owner_id: 'u1',
  name: 'Agent',
  role: 'CODER',
  objective: null,
  capabilities: [],
  model_provider: null,
  model_id: null,
  max_tasks_per_run: 3,
  max_retries: 1,
  status: 'IDLE',
  current_run_id: null,
  trust_level: 'L2',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  ...over,
});

const DEBATE = (over: Record<string, unknown> = {}) => ({
  id: 'dbt-1',
  owner_id: 'u1',
  prompt: 'Which cache strategy?',
  status: 'PENDING',
  proposer_agent_ids: ['ag-1', 'ag-2'],
  judge_agent_id: 'ag-j',
  winner_agent_id: null,
  rationale: null,
  max_rounds: 1,
  round_count: 0,
  budget_usd: 5,
  spent_usd: 0,
  deadline_at: new Date(Date.now() + 60 * 60 * 1000),
  require_approval: false,
  run_id: null,
  user_decision: null,
  error: null,
  completed_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...over,
});

const PROPOSAL = (over: Record<string, unknown> = {}) => ({
  id: 'dbp-1',
  debate_id: 'dbt-1',
  owner_id: 'u1',
  agent_id: 'ag-1',
  agent_name: 'Agent',
  role: 'CODER',
  model_id: 'm1',
  provider_id: 'p1',
  round: 1,
  proposal: 'Use Redis',
  evidence: 'latency measurements',
  risks: 'eviction',
  tradeoffs: 'ops',
  status: 'PROPOSED',
  error: null,
  cost_usd: 0.01,
  duration_ms: 100,
  created_at: new Date(),
  ...over,
});

/** In-memory debate store driven by the SQL the module emits. */
function wireDb(initial: Record<string, unknown>, initialProposals: Array<Record<string, unknown>> = []) {
  const current = { ...initial };
  const proposals = initialProposals.map((p) => ({ ...p }));
  db.state.debate = current;
  db.state.proposals = proposals;
  db.state.resolve = (text: string, params: unknown[] = []) => {
    if (text.includes('SELECT * FROM agent_debates')) return [current];
    if (text.includes('SELECT * FROM agent_debate_proposals')) return proposals.slice();
    if (text.includes('INSERT INTO agent_debates')) {
      current.id = String(params[0]);
      current.owner_id = String(params[1]);
      current.prompt = String(params[2]);
      current.status = 'PENDING';
      current.proposer_agent_ids = JSON.parse(String(params[3]));
      current.judge_agent_id = String(params[4]);
      current.max_rounds = Number(params[5]);
      current.budget_usd = Number(params[6]);
      current.deadline_at = new Date(String(params[7]));
      current.require_approval = Boolean(params[8]);
      return [];
    }
    if (text.includes('INSERT INTO agent_debate_proposals')) {
      if (params.length <= 11) {
        proposals.push({
          id: String(params[0]), debate_id: String(params[1]), owner_id: String(params[2]),
          agent_id: String(params[3]), agent_name: String(params[4]), role: String(params[5]),
          round: Number(params[6]), status: 'FAILED', error: String(params[7]),
          cost_usd: Number(params[9]), duration_ms: Number(params[10]), proposal: null,
          evidence: null, risks: null, tradeoffs: null, model_id: null, provider_id: null,
          created_at: new Date(),
        });
      } else {
        proposals.push({
          id: String(params[0]), debate_id: String(params[1]), owner_id: String(params[2]),
          agent_id: String(params[3]), agent_name: String(params[4]), role: String(params[5]),
          model_id: params[6] === null ? null : String(params[6]), provider_id: params[7] === null ? null : String(params[7]),
          round: Number(params[8]), proposal: params[9] === null ? null : String(params[9]),
          evidence: params[10] === null ? null : String(params[10]), risks: params[11] === null ? null : String(params[11]),
          tradeoffs: params[12] === null ? null : String(params[12]), status: String(params[13]),
          error: params[14] === null ? null : String(params[14]), cost_usd: Number(params[15]),
          duration_ms: Number(params[16]), created_at: new Date(),
        });
      }
      return [];
    }
    if (text.includes('UPDATE agent_debates')) {
      const status = /SET status = '(\w+)'/.exec(text)?.[1];
      if (status) current.status = status;
      if (text.includes('round_count')) current.round_count = Number(current.round_count) + 1;
      if (text.includes('winner_agent_id = $2')) {
        current.status = String(params[0]);
        current.winner_agent_id = params[1] === null ? null : String(params[1]);
        current.rationale = params[2] === null ? null : String(params[2]);
        current.spent_usd = Number(current.spent_usd) + Number(params[3]);
        if (String(params[0]) === 'COMPLETED') current.completed_at = new Date();
      }
      if (text.includes('user_decision')) current.user_decision = /user_decision = '(\w+)'/.exec(text)?.[1] ?? null;
      if (text.includes('run_id = $1')) current.run_id = String(params[0]);
      if (text.includes('error = $1') && text.includes('status NOT IN')) {
        current.status = 'FAILED';
        current.error = String(params[0]);
        current.completed_at = new Date();
      }
      if (text.includes('status = \'CANCELLED\'')) current.completed_at = new Date();
      return [];
    }
    return null;
  };
}

function setGatewayTexts(texts: string[]) {
  gateway.completeWithFallback.mockReset();
  for (const t of texts) {
    gateway.completeWithFallback.mockResolvedValueOnce({
      text: t, modelId: 'm1', providerId: 'p1', estimatedCostUsd: 0.01, durationMs: 100,
    });
  }
}

beforeEach(() => {
  audit.recordAudit.mockClear();
  gateway.completeWithFallback.mockReset();
  gateway.estimatedCostOfRequest.mockReset();
  gateway.estimatedCostOfRequest.mockResolvedValue(0.01);
  entitlements.effectivePlan.mockReset();
  entitlements.effectivePlan.mockResolvedValue('pro');
  agents.getAgent.mockReset();
  agents.startRun.mockReset();
  db.state.debate = null;
  db.state.proposals = [];
  db.state.resolve = null;
});

describe('DEBATE CREATION — validation', () => {
  it('requires a prompt, two or more proposers, and excludes the judge from proposing', async () => {
    await expect(createAndRunDebate('u1', { agentIds: [], judgeAgentId: 'j', prompt: 'x' })).rejects.toMatchObject({ errorCode: 'debate_needs_two_agents' });
    await expect(createAndRunDebate('u1', { agentIds: ['a', 'b'], judgeAgentId: 'j', prompt: '  ' })).rejects.toMatchObject({ errorCode: 'debate_prompt_required' });
    await expect(createAndRunDebate('u1', { agentIds: ['a', 'j'], judgeAgentId: 'j', prompt: 'x' })).rejects.toMatchObject({ errorCode: 'judge_cannot_propose' });
  });

  it('caps proposers at five and requires idle agents', async () => {
    const many = Array.from({ length: MAX_DEBATE_AGENTS + 1 }, (_, i) => `ag-${i}`);
    agents.getAgent.mockResolvedValue(AGENT());
    await expect(createAndRunDebate('u1', { agentIds: many, judgeAgentId: 'j', prompt: 'x' })).rejects.toMatchObject({ errorCode: 'debate_too_many_agents' });
    agents.getAgent.mockResolvedValue(AGENT({ status: 'RUNNING' }));
    await expect(createAndRunDebate('u1', { agentIds: ['a', 'b'], judgeAgentId: 'j', prompt: 'x' })).rejects.toMatchObject({ errorCode: 'agent_busy' });
  });

  it('rejects a budget that cannot cover one round', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    gateway.estimatedCostOfRequest.mockResolvedValue(5);
    await expect(createAndRunDebate('u1', { agentIds: ['a', 'b'], judgeAgentId: 'j', prompt: 'x', budgetUsd: 1 })).rejects.toMatchObject({ errorCode: 'debate_budget_insufficient' });
  });
});

describe('DEBATE RUN — independent proposals + judge', () => {
  it('completes with a winner when the judge picks a valid proposer', async () => {
    agents.getAgent.mockImplementation(async (_u: string, id: string) => {
      const map: Record<string, Record<string, unknown>> = {
        'ag-1': AGENT({ id: 'ag-1', name: 'Alpha', role: 'ARCHITECT' }),
        'ag-2': AGENT({ id: 'ag-2', name: 'Beta', role: 'DEVOPS' }),
        'ag-j': AGENT({ id: 'ag-j', name: 'Judge', role: 'REVIEWER' }),
      };
      if (!map[id]) throw AppError.notFound('Agent');
      return map[id];
    });
    setGatewayTexts([
      JSON.stringify({ proposal: 'Redis cache', evidence: 'bench', risks: 'eviction', tradeoffs: 'ops' }),
      JSON.stringify({ proposal: 'Memcached', evidence: 'bench2', risks: 'none', tradeoffs: 'none' }),
      JSON.stringify({ winnerAgentId: 'ag-2', rationale: 'simpler' }),
    ]);
    wireDb(DEBATE());
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'Which cache?', budgetUsd: 5 });
    expect(result.debate.status).toBe('COMPLETED');
    expect(result.debate.winner_agent_id).toBe('ag-2');
    expect(result.debate.rationale).toBe('simpler');
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((p) => p.status === 'PROPOSED')).toBe(true);
    expect(gateway.completeWithFallback).toHaveBeenCalledTimes(3);
    const judgeCall = gateway.completeWithFallback.mock.calls[2][0];
    expect(String(judgeCall.messages[0].content)).toContain('ag-2');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEBATE_COMPLETED, resourceId: result.debate.id }));
  });

  it('records FAILED rows for agents whose call throws — never hidden', async () => {
    agents.getAgent.mockImplementation(async (_u: string, id: string) => {
      const map: Record<string, Record<string, unknown>> = {
        'ag-1': AGENT({ id: 'ag-1', name: 'Alpha' }),
        'ag-2': AGENT({ id: 'ag-2', name: 'Beta' }),
        'ag-j': AGENT({ id: 'ag-j', name: 'Judge' }),
      };
      return map[id]!;
    });
    gateway.completeWithFallback
      .mockResolvedValueOnce({ text: JSON.stringify({ proposal: 'A plan' }), modelId: 'm', providerId: 'p', estimatedCostUsd: 0.01, durationMs: 10 })
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ text: JSON.stringify({ winnerAgentId: 'ag-1', rationale: 'only one' }), modelId: 'm', providerId: 'p', estimatedCostUsd: 0.01, durationMs: 10 });
    wireDb(DEBATE());
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'Plan?', budgetUsd: 5 });
    expect(result.debate.status).toBe('COMPLETED');
    expect(result.proposals.find((p) => p.agent_id === 'ag-2')!.status).toBe('FAILED');
    expect(result.proposals.find((p) => p.agent_id === 'ag-2')!.error).toContain('provider down');
    const judgeCall = gateway.completeWithFallback.mock.calls[2][0];
    expect(String(judgeCall.messages[0].content)).toContain('FAILED');
    expect(String(judgeCall.messages[0].content)).toContain('provider down');
  });

  it('fails the debate honestly when every agent fails (all_agents_failed)', async () => {
    agents.getAgent.mockResolvedValue(AGENT({ id: 'ag-1' }));
    gateway.completeWithFallback.mockRejectedValue(new Error('down'));
    wireDb(DEBATE());
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'x', budgetUsd: 5 });
    expect(result.debate.status).toBe('FAILED');
    expect(result.debate.error).toContain('all_agents_failed');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEBATE_FAILED }));
  });

  it('marks the debate FAILED when the judge output is unparseable', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    setGatewayTexts([
      JSON.stringify({ proposal: 'A' }),
      JSON.stringify({ proposal: 'B' }),
      'I prefer the second one.',
    ]);
    wireDb(DEBATE());
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'x', budgetUsd: 5 });
    expect(result.debate.status).toBe('FAILED');
    expect(result.debate.error).toContain('judge_output_invalid');
  });

  it('rejects a judge verdict naming an agent without a proposal', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    setGatewayTexts([
      JSON.stringify({ proposal: 'A' }),
      JSON.stringify({ proposal: 'B' }),
      JSON.stringify({ winnerAgentId: 'ghost', rationale: 'none' }),
    ]);
    wireDb(DEBATE());
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'x', budgetUsd: 5 });
    expect(result.debate.status).toBe('FAILED');
    expect(result.debate.error).toContain('judge_invalid_winner');
  });

  it('honours require_approval -> WAITING_FOR_APPROVAL', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    setGatewayTexts([
      JSON.stringify({ proposal: 'A' }),
      JSON.stringify({ proposal: 'B' }),
      JSON.stringify({ winnerAgentId: 'ag-1', rationale: 'ok' }),
    ]);
    wireDb(DEBATE({ require_approval: true }));
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'x', budgetUsd: 5, requireApproval: true });
    expect(result.debate.status).toBe('WAITING_FOR_APPROVAL');
    expect(result.debate.winner_agent_id).toBe('ag-1');
  });

  it('fails when the deadline has passed before running', async () => {
    wireDb(DEBATE({ deadline_at: new Date(Date.now() - 1000) }));
    const result = await runDebate('u1', 'dbt-1');
    expect(result.debate.status).toBe('FAILED');
    expect(result.debate.error).toContain('deadline_exceeded');
  });
});
describe('DEBATE DECISION — approval flow through the existing pipeline', () => {
  it('APPROVED executes the winner via startRun and links the run', async () => {
    agents.startRun.mockResolvedValue({ id: 'run-1' });
    agents.getAgent.mockResolvedValue(AGENT({ id: 'ag-1' }));
    wireDb(DEBATE({ status: 'WAITING_FOR_APPROVAL', winner_agent_id: 'ag-1' }), [PROPOSAL({ proposal: 'Use Redis' })]);
    const debate = await decideDebate('u1', 'dbt-1', 'APPROVED');
    expect(debate.status).toBe('APPROVED');
    expect(debate.run_id).toBe('run-1');
    expect(agents.startRun).toHaveBeenCalledWith(
      'u1', 'ag-1',
      expect.objectContaining({ objective: 'Use Redis', requireApproval: true }),
    );
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEBATE_APPROVED, detail: expect.objectContaining({ runId: 'run-1' }) }));
  });

  it('REJECTED records the user decision without executing anything', async () => {
    wireDb(DEBATE({ status: 'WAITING_FOR_APPROVAL', winner_agent_id: 'ag-1' }));
    const debate = await decideDebate('u1', 'dbt-1', 'REJECTED');
    expect(debate.status).toBe('REJECTED');
    expect(debate.user_decision).toBe('REJECTED');
    expect(agents.startRun).not.toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEBATE_REJECTED }));
  });

  it('refuses decisions on debates that are not awaiting approval', async () => {
    wireDb(DEBATE());
    await expect(decideDebate('u1', 'dbt-1', 'APPROVED')).rejects.toMatchObject({ errorCode: 'debate_decision_invalid' });
  });

  it('cannot approve a debate without a winner', async () => {
    wireDb(DEBATE({ status: 'WAITING_FOR_APPROVAL', winner_agent_id: null }));
    await expect(decideDebate('u1', 'dbt-1', 'APPROVED')).rejects.toMatchObject({ errorCode: 'debate_no_winner' });
  });
});

describe('DEBATE CANCELLATION — pending only, audited', () => {
  it('cancels a PENDING debate and audits it', async () => {
    wireDb(DEBATE());
    const debate = await cancelDebate('u1', 'dbt-1');
    expect(debate.status).toBe('CANCELLED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEBATE_CANCELLED, resourceId: 'dbt-1' }));
  });

  it('refuses to cancel a completed debate', async () => {
    wireDb(DEBATE({ status: 'COMPLETED' }));
    await expect(cancelDebate('u1', 'dbt-1')).rejects.toMatchObject({ errorCode: 'debate_not_cancellable' });
  });
});

describe('DEBATE READS AND BOUNDS', () => {
  it('lists only the owner debates', async () => {
    wireDb(DEBATE());
    const list = await listDebates('u1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('dbt-1');
  });

  it('clamps rounds to 1-3 and deadlines to 5-1440 minutes', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    gateway.estimatedCostOfRequest.mockResolvedValue(0.001);
    gateway.completeWithFallback
      .mockResolvedValue({ text: JSON.stringify({ proposal: 'A' }), modelId: 'm', providerId: 'p', estimatedCostUsd: 0.001, durationMs: 5 });
    wireDb(DEBATE());
    const result = await createAndRunDebate('u1', { agentIds: ['ag-1', 'ag-2'], judgeAgentId: 'ag-j', prompt: 'x', maxRounds: 9, deadlineMinutes: 99999, budgetUsd: 0.1 });
    expect(result.debate.max_rounds).toBe(3);
    expect(result.debate.deadline_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a debate the user does not own', async () => {
    agents.getAgent.mockImplementation(async () => {
      throw AppError.notFound('Agent');
    });
    await expect(createAndRunDebate('u1', { agentIds: ['x', 'y'], judgeAgentId: 'j', prompt: 'x' })).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});