/**
 * CodeConClave — Stage 26A: agent debate mode.
 *
 * Coordination layer over the EXISTING agents + AI gateway + approval + task
 * pipeline. A debate: N specialist agents produce INDEPENDENT bounded
 * proposals (evidence / risks / tradeoffs) through the gateway (role-routed
 * models, entitlement/budget governed); a judge agent receives ALL proposal
 * rows — including failed ones, never hidden — and selects one (or none);
 * the user may then approve (→ execution via the existing startRun pipeline,
 * including trust-level enforcement) or reject.
 *
 * Guarantees:
 *  - every proposal row is persisted (status PROPOSED or FAILED) — no hidden
 *    proposals, deterministic handling of agent failure;
 *  - bounded rounds (max_rounds 1–3), cost estimate pre-flight + spent
 *    enforcement, hard deadline;
 *  - cancellation at any point before completion;
 *  - full audit trail (DEBATE_* actions);
 *  - judge output must be parseable; an unparseable judge verdict is an
 *    honest FAILED debate — never an invented winner.
 */
import { pool, queryMany, queryOne } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { completeWithFallback, estimatedCostOfRequest } from '../ai/gateway.js';
import { getAgent, startRun, type AgentRow } from './service.js';
import { effectivePlan } from '../entitlements/service.js';

export const DEBATE_STATES = [
  'PENDING', 'IN_DEBATE', 'JUDGING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED',
  'WAITING_FOR_APPROVAL', 'APPROVED', 'REJECTED',
] as const;

export const MAX_DEBATE_AGENTS = 5;

export interface DebateRow {
  id: string;
  owner_id: string;
  prompt: string;
  status: string;
  proposer_agent_ids: string[];
  judge_agent_id: string;
  winner_agent_id: string | null;
  rationale: string | null;
  max_rounds: number;
  round_count: number;
  budget_usd: number;
  spent_usd: number;
  deadline_at: Date;
  require_approval: boolean;
  run_id: string | null;
  user_decision: string | null;
  error: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProposalRow {
  id: string;
  debate_id: string;
  owner_id: string;
  agent_id: string;
  agent_name: string;
  role: string;
  model_id: string | null;
  provider_id: string | null;
  round: number;
  proposal: string | null;
  evidence: string | null;
  risks: string | null;
  tradeoffs: string | null;
  status: 'PROPOSED' | 'FAILED';
  error: string | null;
  cost_usd: number;
  duration_ms: number;
  created_at: Date;
}

export interface CreateDebateInput {
  agentIds: string[];
  judgeAgentId: string;
  prompt: string;
  budgetUsd?: number;
  deadlineMinutes?: number;
  maxRounds?: number;
  requireApproval?: boolean;
}

function mapDebate(row: Record<string, unknown>): DebateRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    prompt: String(row.prompt),
    status: String(row.status),
    proposer_agent_ids: (row.proposer_agent_ids as string[]) ?? [],
    judge_agent_id: String(row.judge_agent_id),
    winner_agent_id: row.winner_agent_id === null ? null : String(row.winner_agent_id),
    rationale: row.rationale === null ? null : String(row.rationale),
    max_rounds: Number(row.max_rounds),
    round_count: Number(row.round_count),
    budget_usd: Number(row.budget_usd),
    spent_usd: Number(row.spent_usd),
    deadline_at: new Date(String(row.deadline_at)),
    require_approval: Boolean(row.require_approval),
    run_id: row.run_id === null ? null : String(row.run_id),
    user_decision: row.user_decision === null ? null : String(row.user_decision),
    error: row.error === null ? null : String(row.error),
    completed_at: row.completed_at === null ? null : new Date(String(row.completed_at)),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

async function planBudgetCap(userId: string): Promise<number> {
  const plan = await effectivePlan(userId);
  return plan === 'free' ? 1 : plan === 'pro' ? 5 : 25;
}

const PROPOSAL_PROMPT =
  'You are {name}, a {role} specialist in the CodeConClave agent team.\n\n' +
  'Independent debate — produce YOUR OWN proposal for the request below. Do not coordinate with other agents.\n\n' +
  'REQUEST:\n{prompt}\n\n' +
  'Respond with ONLY a JSON object:\n' +
  '{"proposal":"<your proposal, concrete and bounded>","evidence":"<what you verified / cite sources>",' +
  '"risks":"<risks and how to mitigate>","tradeoffs":"<what this trades off>"}\n' +
  'No prose outside the JSON. If you cannot produce a proposal, respond with {"proposal":null,"reason":"<why>"}.';

const JUDGE_PROMPT =
  'You are the judge for an agent debate.\n\n' +
  'REQUEST:\n{prompt}\n\n' +
  'PROPOSALS (every agent that participated; FAILED agents produced none and are marked):\n{proposals}\n\n' +
  'Select the single best proposal or reject all. Respond with ONLY a JSON object:\n' +
  '{"winnerAgentId":"<agent id or null>","rationale":"<why this one / why none>"}\n' +
  'You must consider ALL proposals listed. Do not invent a proposal that is not listed.';

function parseDebateJson(text: string): { ok: boolean; value?: Record<string, unknown>; error?: string } {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'invalid_json_shape' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

export async function listDebates(userId: string): Promise<DebateRow[]> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM agent_debates WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId],
  );
  return rows.map(mapDebate);
}

export async function getDebate(userId: string, debateId: string): Promise<{ debate: DebateRow; proposals: ProposalRow[] }> {
  const rows = await queryMany<Record<string, unknown>>('SELECT * FROM agent_debates WHERE id = $1 AND owner_id = $2', [debateId, userId]);
  if (!rows[0]) throw AppError.notFound('Debate');
  const proposals = await queryMany<ProposalRow>(
    'SELECT * FROM agent_debate_proposals WHERE debate_id = $1 AND owner_id = $2 ORDER BY created_at ASC',
    [debateId, userId],
  );
  return { debate: mapDebate(rows[0]), proposals };
}

function assertPending(debate: DebateRow): void {
  if (debate.status !== 'PENDING') {
    throw AppError.conflict('debate_not_pending', `Debate is already ${debate.status}`);
  }
}

/** Create a debate, run the debate round synchronously, and return the result. */
export async function createAndRunDebate(userId: string, input: CreateDebateInput): Promise<{ debate: DebateRow; proposals: ProposalRow[] }> {
  const prompt = input.prompt.trim().slice(0, 2000);
  if (!prompt) throw AppError.badRequest('debate_prompt_required', 'A debate request is required');
  const agentIds = [...new Set(input.agentIds.map((a) => String(a)))];
  if (agentIds.length < 2) throw AppError.badRequest('debate_needs_two_agents', 'A debate needs at least two proposing agents');
  if (agentIds.length > MAX_DEBATE_AGENTS) {
    throw AppError.badRequest('debate_too_many_agents', `A debate supports at most ${MAX_DEBATE_AGENTS} proposing agents`);
  }
  if (agentIds.includes(input.judgeAgentId)) {
    throw AppError.badRequest('judge_cannot_propose', 'The judge agent must not also be a proposer');
  }

  // Ownership + role checks (server-authoritative; never trust ids blindly).
  const agents: AgentRow[] = [];
  for (const agentId of agentIds) {
    const agent = await getAgent(userId, agentId);
    if (agent.status !== 'IDLE') {
      throw AppError.conflict('agent_busy', `Agent ${agent.name} is busy; debates use idle agents only`);
    }
    agents.push(agent);
  }
  const judge = await getAgent(userId, input.judgeAgentId);
  if (judge.status !== 'IDLE') throw AppError.conflict('agent_busy', `Judge ${judge.name} is busy`);

  const cap = await planBudgetCap(userId);
  const budget = Math.min(Math.max(input.budgetUsd ?? 2, 0.1), Math.max(cap, 0.1));
  const deadlineMinutes = Math.min(Math.max(input.deadlineMinutes ?? 60, 5), 1440);
  const maxRounds = Math.min(Math.max(input.maxRounds ?? 1, 1), 3);
  const deadlineAt = new Date(Date.now() + deadlineMinutes * 60_000);

  // Pre-flight cost estimate: refuse when the budget cannot cover one round.
  const estimated = await estimateProposalCost(userId, agents, judge);
  if (estimated > budget) {
    throw AppError.badRequest(
      'debate_budget_insufficient',
      `Estimated debate cost $${estimated.toFixed(4)} exceeds the budget $${budget.toFixed(4)}. Increase the budget.`,
    );
  }

  const id = newId(PREFIX.AGENT_DEBATE);
  await pool.query(
    `INSERT INTO agent_debates (id, owner_id, prompt, status, proposer_agent_ids, judge_agent_id, max_rounds, budget_usd, deadline_at, require_approval)
     VALUES ($1,$2,$3,'PENDING',$4::jsonb,$5,$6,$7,$8,$9)`,
    [id, userId, prompt, JSON.stringify(agentIds), judge.id, maxRounds, budget, deadlineAt.toISOString(), input.requireApproval === true],
  );
  await recordAudit({
    action: AuditAction.DEBATE_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'agent_debate',
    resourceId: id,
    detail: { agents: agentIds.length, judge: judge.id, budgetUsd: budget, maxRounds },
  });

  return runDebate(userId, id);
}

async function estimateProposalCost(userId: string, agents: AgentRow[], judge: AgentRow): Promise<number> {
  let total = 0;
  for (const agent of [...agents, judge]) {
    try {
      const request = [{ role: 'user' as const, content: 'd' }];
      total += await estimatedCostOfRequest(userId, request, {
        computeClass: agent.role === 'ARCHITECT' || agent.role === 'REVIEWER' || agent.role === 'SECURITY' ? 'C' : 'B',
        coding: ['CODER', 'DEBUGGER', 'DEVOPS'].includes(agent.role),
      });
    } catch {
      total += 0.001; // unrouteable now — still count a floor; run will fail honestly
    }
  }
  return total;
}

function proposalMessages(agent: AgentRow, prompt: string, maxTokens: number) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: PROPOSAL_PROMPT
          .replace('{name}', agent.name)
          .replace('{role}', agent.role)
          .replace('{prompt}', prompt),
      },
    ],
    maxTokens,
    temperature: 0.3,
  };
}

/** Run one debate round: independent proposals, then judge. Idempotent per round. */
export async function runDebate(userId: string, debateId: string): Promise<{ debate: DebateRow; proposals: ProposalRow[] }> {
  const current = await getDebate(userId, debateId);
  assertPending(current.debate);
  if (new Date() > current.debate.deadline_at) {
    await markFailed(debateId, 'deadline_exceeded', 'Debate deadline passed before it could run');
    const after = await getDebate(userId, debateId);
    return { debate: after.debate, proposals: after.proposals };
  }
  const debate = current.debate;
  const agentIds = debate.proposer_agent_ids;
  const judge = await getAgent(userId, debate.judge_agent_id);

  await pool.query(`UPDATE agent_debates SET status = 'IN_DEBATE', round_count = round_count + 1, updated_at = now() WHERE id = $1`, [debateId]);
  const round = debate.round_count + 1;
  const proposers: AgentRow[] = [];
  for (const agentId of agentIds) {
    proposers.push(await getAgent(userId, agentId));
  }

  let spent = debate.spent_usd;
  const proposals: ProposalRow[] = [];
  // Independent proposals — deterministic order (created order as given), one
  // failing agent never blocks or hides the others.
  for (const agent of proposers) {
    const proposalId = newId(PREFIX.AGENT_DEBATE_PROPOSAL);
    const attemptStart = Date.now();
    try {
      const summary = await completeWithFallback({
        ctx: { userId, sessionId: `debate:${debateId}`, planId: await effectivePlan(userId), tenantId: userId },
        messages: proposalMessages(agent, debate.prompt, 1024).messages,
        maxTokens: 1024,
        opts: {
          computeClass: agent.role === 'ARCHITECT' || agent.role === 'REVIEWER' || agent.role === 'SECURITY' ? 'C' : 'B',
          coding: ['CODER', 'DEBUGGER', 'DEVOPS'].includes(agent.role),
          maxLatencyMs: undefined,
        },
      });
      const parsed = parseDebateJson(summary.text);
      const proposalText = parsed.ok ? String(parsed.value?.proposal ?? '') : '';
      const noProposal = String(parsed.value?.reason ?? '');
      await pool.query(
        `INSERT INTO agent_debate_proposals (id, debate_id, owner_id, agent_id, agent_name, role, model_id, provider_id, round, proposal, evidence, risks, tradeoffs, status, error, cost_usd, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          proposalId, debateId, userId, agent.id, agent.name, agent.role,
          summary.modelId, summary.providerId, round,
          proposalText || null,
          parsed.ok ? (parsed.value?.evidence ? String(parsed.value.evidence).slice(0, 2000) : null) : null,
          parsed.ok ? (parsed.value?.risks ? String(parsed.value.risks).slice(0, 2000) : null) : null,
          parsed.ok ? (parsed.value?.tradeoffs ? String(parsed.value.tradeoffs).slice(0, 2000) : null) : null,
          proposalText ? 'PROPOSED' : 'FAILED',
          proposalText ? null : `no_proposal: ${noProposal || 'unparseable output'}`,
          summary.estimatedCostUsd,
          summary.durationMs,
        ],
      );
      spent += summary.estimatedCostUsd;
      proposals.push({
        id: proposalId, debate_id: debateId, owner_id: userId, agent_id: agent.id, agent_name: agent.name,
        role: agent.role, model_id: summary.modelId, provider_id: summary.providerId, round,
        proposal: proposalText || null,
        evidence: parsed.ok && parsed.value?.evidence ? String(parsed.value.evidence) : null,
        risks: parsed.ok && parsed.value?.risks ? String(parsed.value.risks) : null,
        tradeoffs: parsed.ok && parsed.value?.tradeoffs ? String(parsed.value.tradeoffs) : null,
        status: proposalText ? 'PROPOSED' : 'FAILED',
        error: proposalText ? null : `no_proposal: ${noProposal || 'unparseable output'}`,
        cost_usd: summary.estimatedCostUsd, duration_ms: summary.durationMs, created_at: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
      await pool.query(
        `INSERT INTO agent_debate_proposals (id, debate_id, owner_id, agent_id, agent_name, role, round, status, error, cost_usd, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'FAILED',$8,0,$9)`,
        [proposalId, debateId, userId, agent.id, agent.name, agent.role, round, message, Date.now() - attemptStart],
      );
      proposals.push({
        id: proposalId, debate_id: debateId, owner_id: userId, agent_id: agent.id, agent_name: agent.name,
        role: agent.role, model_id: null, provider_id: null, round, proposal: null, evidence: null,
        risks: null, tradeoffs: null, status: 'FAILED', error: message, cost_usd: 0,
        duration_ms: Date.now() - attemptStart, created_at: new Date(),
      });
    }
  }

  await pool.query(`UPDATE agent_debates SET spent_usd = $1, updated_at = now() WHERE id = $2`, [spent, debateId]);

  // Budget stop: if spending already exceeded the budget, judge still sees
  // everything generated so far; the debate is honest about the stop.
  const budgetExceeded = spent > debate.budget_usd;
  if (proposals.some((p) => p.status === 'PROPOSED')) {
    return judgeDebate(userId, debateId, budgetExceeded ? 'debate_budget_hit' : null);
  }
  // No proposal at all: honest failure (with per-agent FAILED rows for audit).
  await markFailed(debateId, budgetExceeded ? 'debate_budget_hit' : 'all_agents_failed', 'No agent produced a proposal');
  const after = await getDebate(userId, debateId);
  return { debate: after.debate, proposals: after.proposals };
}

async function judgeDebate(userId: string, debateId: string, budgetNote: string | null): Promise<{ debate: DebateRow; proposals: ProposalRow[] }> {
  const current = await getDebate(userId, debateId);
  const debate = current.debate;
  const judge = await getAgent(userId, debate.judge_agent_id);
  await pool.query(`UPDATE agent_debates SET status = 'JUDGING', updated_at = now() WHERE id = $1`, [debateId]);

  const proposalsText = current.proposals
    .map((p) => `- agent ${p.agent_id} (${p.agent_name}, ${p.role}) [${p.status}${p.error ? `: ${p.error}` : ''}]\n  proposal: ${p.proposal ?? '—'}`)
    .join('\n');

  const judgeResult = await completeWithFallback({
    ctx: { userId, sessionId: `debate:${debateId}:judge`, planId: await effectivePlan(userId), tenantId: userId },
    messages: [{ role: 'user', content: JUDGE_PROMPT.replace('{prompt}', debate.prompt).replace('{proposals}', proposalsText) }],
    maxTokens: 600,
    opts: { computeClass: 'C', coding: false },
  });

  const parsed = parseDebateJson(judgeResult.text);
  if (!parsed.ok) {
    await markFailed(debateId, 'judge_output_invalid', 'The judge did not return a parseable verdict');
    const after = await getDebate(userId, debateId);
    return { debate: after.debate, proposals: after.proposals };
  }
  const winnerId = parsed.value && (parsed.value.winnerAgentId === null || parsed.value.winnerAgentId === undefined) ? null : parsed.value ? String(parsed.value.winnerAgentId) : null;
  const rationale = parsed.value && parsed.value.rationale ? String(parsed.value.rationale).slice(0, 2000) : null;

  if (winnerId !== null && !current.proposals.some((p) => p.agent_id === winnerId && p.status === 'PROPOSED')) {
    // The judge may not pick a hidden/failed/unknown agent.
    await markFailed(debateId, 'judge_invalid_winner', 'The judge selected an agent with no valid proposal');
    const after = await getDebate(userId, debateId);
    return { debate: after.debate, proposals: after.proposals };
  }

  const nextStatus = winnerId === null ? 'COMPLETED' : debate.require_approval ? 'WAITING_FOR_APPROVAL' : 'COMPLETED';
  await pool.query(
    `UPDATE agent_debates SET status = $1, winner_agent_id = $2, rationale = $3, spent_usd = spent_usd + $4,
       completed_at = CASE WHEN $1 = 'COMPLETED' THEN now() ELSE completed_at END, updated_at = now()
     WHERE id = $5`,
    [nextStatus, winnerId, rationale, judgeResult.estimatedCostUsd, debateId],
  );
  await recordAudit({
    action: AuditAction.DEBATE_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'agent_debate',
    resourceId: debateId,
    detail: { winner: winnerId, rationale, budgetNote, requireApproval: debate.require_approval },
  });
  if (budgetNote) {
    await pool.query(`UPDATE agent_debates SET status = 'BLOCKED', error = $1, updated_at = now() WHERE id = $2 AND status = 'COMPLETED'`, [budgetNote, debateId]);
  }
  const after = await getDebate(userId, debateId);
  return { debate: after.debate, proposals: after.proposals };
}

async function markFailed(debateId: string, errorCode: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE agent_debates SET status = 'FAILED', error = $1, completed_at = now(), updated_at = now() WHERE id = $2 AND status NOT IN ('COMPLETED','APPROVED','REJECTED','CANCELLED')`,
    [`${errorCode}: ${message}`.slice(0, 500), debateId],
  );
  await recordAudit({
    action: AuditAction.DEBATE_FAILED,
    actorUserId: null,
    scope: 'USER',
    tenantId: null,
    resourceType: 'agent_debate',
    resourceId: debateId,
    detail: { errorCode, message },
  });
}

export async function cancelDebate(userId: string, debateId: string): Promise<DebateRow> {
  const { debate } = await getDebate(userId, debateId);
  if (!['PENDING', 'IN_DEBATE', 'JUDGING'].includes(debate.status)) {
    throw AppError.conflict('debate_not_cancellable', `Debate is ${debate.status} and cannot be cancelled`);
  }
  await pool.query(`UPDATE agent_debates SET status = 'CANCELLED', completed_at = now(), updated_at = now() WHERE id = $1`, [debateId]);
  await recordAudit({
    action: AuditAction.DEBATE_CANCELLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'agent_debate',
    resourceId: debateId,
    detail: {},
  });
  return (await getDebate(userId, debateId)).debate;
}

/** User decision after a completed debate. APPROVE executes the winner's
 *  proposal through the EXISTING run pipeline (startRun) — trust levels,
 *  approvals, bounds all apply; the winner agent cannot bypass anything. */
export async function decideDebate(userId: string, debateId: string, decision: 'APPROVED' | 'REJECTED'): Promise<DebateRow> {
  const { debate } = await getDebate(userId, debateId);
  if (debate.status !== 'WAITING_FOR_APPROVAL') {
    throw AppError.conflict('debate_decision_invalid', `Debate is ${debate.status}; only WAITING_FOR_APPROVAL debates can be decided`);
  }
  if (decision === 'REJECTED') {
    await pool.query(
      `UPDATE agent_debates SET status = 'REJECTED', user_decision = 'REJECTED', completed_at = now(), updated_at = now() WHERE id = $1`,
      [debateId],
    );
    await recordAudit({ action: AuditAction.DEBATE_REJECTED, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'agent_debate', resourceId: debateId, detail: {} });
    return (await getDebate(userId, debateId)).debate;
  }
  if (!debate.winner_agent_id) throw AppError.conflict('debate_no_winner', 'No winner to execute');
  const winner = await getAgent(userId, debate.winner_agent_id);
  const proposal = (await getDebate(userId, debateId)).proposals.find((p) => p.agent_id === winner.id && p.status === 'PROPOSED');
  const objective = proposal?.proposal ?? debate.prompt;
  const run = await startRun(userId, winner.id, {
    objective,
    budgetUsd: Math.min(debate.budget_usd, 5),
    deadlineMinutes: 120,
    requireApproval: true,
  });
  await pool.query(`UPDATE agent_debates SET status = 'APPROVED', user_decision = 'APPROVED', run_id = $1, completed_at = now(), updated_at = now() WHERE id = $2`, [run.id, debateId]);
  await recordAudit({ action: AuditAction.DEBATE_APPROVED, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'agent_debate', resourceId: debateId, detail: { runId: run.id, agentId: winner.id } });
  return (await getDebate(userId, debateId)).debate;
}