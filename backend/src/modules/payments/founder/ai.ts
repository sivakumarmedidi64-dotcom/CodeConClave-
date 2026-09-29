/**
 * CodeConClave — FOUNDER AI OPERATIONS AGENT (private, founder-only).
 *
 * The founder may ask an AI agent operational questions AND the AI agent may
 * take a SHORT, explicit, allow-listed list of founder actions. Hard safety
 * invariants (enforced by construction, not by prompt):
 *
 *   1. The tool set is a FIXED MAP. There is NO tool to approve a claim,
 *      refund, revoke, or grant/change any entitlement. It is impossible for
 *      the AI to "decide" payment authenticity: it only reports REAL server
 *      data from the founder read services, and it can execute exactly two
 *      controls — flip the autopilot mode (kill switch) and STOP an
 *      auto-approval already scheduled by the verified webhook rail.
 *   2. Control actions require explicit confirmation (args.confirm === true);
 *      read actions never do.
 *   3. The model never sees payments/revenue "truth" invented by the model:
 *      every tool result is produced by a server query in this session.
 *   4. LLM failures fall back to a deterministic classifier; invalid/unknown
 *      output is REFUSED (never guessed). Every query is audited.
 */
import { AppError } from '../../../shared/errors.js';
import { recordAudit } from '../../audit/service.js';
import { completeWithFallback, type GatewayContext } from '../../ai/gateway.js';
import { env } from '../../../config/env.js';
import { pool, withTenant } from '../../../shared/db.js';
import { z } from 'zod';
import { founderDashboard, founderAutopilotState, founderReviewQueue, founderVerificationFailures, founderAuditTrail, founderPaymentDetail } from './service.js';
import { founderRevenueOverview, founderMonthlyRevenue } from './revenue.js';
import { setRuntimeUnlockMode } from '../autopilot/service.js';
import { stopAutoApproval, sweepAutoApprovals } from '../autoapproval/service.js';

type FounderToolResult = Record<string, unknown>;

interface FounderTool {
  kind: 'read' | 'control';
  describe: string;
  args: z.ZodType<unknown>;
  run: (args: Record<string, unknown>, actorUserId: string) => Promise<FounderToolResult>;
}

/** Fixed, name-bounded tool allow-list. NEVER add approve/refund/grant tools here. */
export function founderAiTools(): string[] {
  return Object.keys(TOOLS);
}

export { TOOLS };

const TOOLS: Record<string, FounderTool> = {
  dashboard: {
    kind: 'read',
    describe: 'Today & this week: payments, revenue, pending reviews, autopilot state, latest payments.',
    args: z.record(z.unknown()),
    run: async () => {
      const d = await founderDashboard('founder-ai');
      return { dashboard: d };
    },
  },
  revenue: {
    kind: 'read',
    describe: 'Revenue today, this week, this month, previous month, all-time, split Solo/Team/API with refunds and net.',
    args: z.record(z.unknown()),
    run: async () => {
      const overview = await founderRevenueOverview();
      return { revenue: { periods: overview.periods, allTime: overview.allTime } };
    },
  },
  monthly_revenue: {
    kind: 'read',
    describe: 'Monthly revenue table (last 12 months): Solo | Team | API | total | refunded | net.',
    args: z.record(z.unknown()),
    run: async (args) => {
      const months = typeof args.months === 'number' ? Math.max(1, Math.min(24, Math.floor(args.months))) : 12;
      return { monthlyRevenue: await founderMonthlyRevenue(months) };
    },
  },
  payments: {
    kind: 'read',
    describe: 'Recent payments (latest first) with product, amount, status and payment id.',
    args: z.record(z.unknown()),
    run: async (args) => {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20;
      const { recentIntents } = await import('./recent.js');
      return { payments: await recentIntents(limit) };
    },
  },
  payment_detail: {
    kind: 'read',
    describe: 'Full detail for one payment intent id (evidence, fraud flags, correlation).',
    args: z.object({ intentId: z.string().min(1) }).partial().passthrough(),
    run: async (args) => {
      const detail = await founderPaymentDetail(String(args.intentId ?? ''));
      return { payment: detail };
    },
  },
  reviews: {
    kind: 'read',
    describe: 'Founder review queue: REVIEW intents and manual claim rows that need a human decision.',
    args: z.record(z.unknown()),
    run: async (args) => {
      const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 50;
      return { reviewQueue: await founderReviewQueue(limit) };
    },
  },
  failures: {
    kind: 'read',
    describe: 'Recent payment verification failures (unmatched, amount mismatch, invalid signature, auto-approval review/failure).',
    args: z.record(z.unknown()),
    run: async (args) => {
      const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 25;
      return { failures: await founderVerificationFailures(limit) };
    },
  },
  audit: {
    kind: 'read',
    describe: 'Recent payment audit trail entries.',
    args: z.record(z.unknown()),
    run: async (args) => {
      const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 50;
      return { auditTrail: await founderAuditTrail(limit) };
    },
  },
  autopilot: {
    kind: 'read',
    describe: 'Autopilot state: effective mode, runtime mode, readiness checks and pending auto-approvals.',
    args: z.record(z.unknown()),
    run: async () => {
      const state = await founderAutopilotState();
      const { listAutoApprovals } = await import('../autoapproval/service.js');
      const interventions = await listAutoApprovals({ limit: 25 });
      return { autopilot: { ...state, pendingApprovals: interventions.pendingCount, interventions: interventions.rows } };
    },
  },
  set_autopilot: {
    kind: 'control',
    describe: 'Flip the runtime unlock mode: MANUAL (kill switch) or AUTOPILOT. Requires confirm: true.',
    args: z.object({ mode: z.enum(['MANUAL', 'AUTOPILOT']), confirm: z.boolean() }).passthrough(),
    run: async (args, actor) => {
      if (args.confirm !== true) throw AppError.forbidden('founder_ai_confirm_required', 'Control actions require explicit confirmation (confirm: true).');
      const mode = args.mode === 'AUTOPILOT' ? 'AUTOPILOT' : 'MANUAL';
      const next = await setRuntimeUnlockMode(mode, actor);
      return { set: next, note: 'Autopilot mode changed. MANUAL is the kill switch.' };
    },
  },
  stop_intervention: {
    kind: 'control',
    describe: 'STOP a pending auto-approval (a verified payment in the 2-second intervention window). Requires confirm: true.',
    args: z.object({ paymentId: z.string().min(1), reason: z.string().optional(), confirm: z.boolean() }).passthrough(),
    run: async (args, actor) => {
      if (args.confirm !== true) throw AppError.forbidden('founder_ai_confirm_required', 'Control actions require explicit confirmation (confirm: true).');
      return { stop: await stopAutoApproval(String(args.paymentId), actor, typeof args.reason === 'string' && args.reason ? args.reason : 'Founder AI instruction') };
    },
  },
  refresh: {
    kind: 'control',
    describe: 'Run the auto-approval sweep now (process any expired intervention windows). Requires confirm: true.',
    args: z.object({ confirm: z.boolean() }).passthrough(),
    run: async (args) => {
      if (args.confirm !== true) throw AppError.forbidden('founder_ai_confirm_required', 'Control actions require explicit confirmation (confirm: true).');
      return { processed: await sweepAutoApprovals({ limit: 100 }) };
    },
  },
};

const CLASSIFY_PROMPT = (question: string): string => `You are a FOUNDER-ONLY payment operations assistant. Choose ONE tool from this list to answer the founder's question. Respond with a JSON object exactly like {"tool":"...","args":{...}}. No other text.

Available tools:
- dashboard (no args)
- revenue (no args)
- monthly_revenue (optional "months": number)
- payments (optional "limit": number)
- payment_detail ({"intentId": string})
- reviews (no args)
- failures (no args)
- audit (no args)
- autopilot (no args)
- set_autopilot ({"mode":"MANUAL"|"AUTOPILOT","confirm":true}) — ONLY if the founder explicitly asked to enable/disable autopilot, and then confirm MUST be true.
- stop_intervention ({"paymentId":"pay_...","reason":"...","confirm":true}) — ONLY if the founder explicitly asked to STOP/cancel a pending auto-approval with a payment id, and then confirm MUST be true.
- refresh ({"confirm":true}) — only to force-run the auto-approval sweep.

NEVER invent data. NEVER choose a tool the founder did not ask for. If nothing matches, choose "dashboard".

Founder question: ${question}`;

async function classifyWithLLM(question: string, userId: string): Promise<{ tool: string; args: Record<string, unknown> } | null> {
  const plan = await gatewayPlan(userId);
  const ctx: GatewayContext = { userId, sessionId: `founder_ai_${userId}`, planId: plan };
  const completion = await completeWithFallback({
    ctx,
    messages: [{ role: 'user', content: CLASSIFY_PROMPT(question) }],
    opts: { computeClass: 'B' },
    maxTokens: 256,
    temperature: 0,
  });
  const text = (completion.text ?? '').trim();
  const json = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim().replace(/^\{/, '{');
  if (!json.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(json) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
      return { tool: parsed.tool, args: parsed.args as Record<string, unknown> };
    }
    return null;
  } catch {
    return null;
  }
}

async function gatewayPlan(userId: string) {
  const row = await withTenant(userId, (q) => q.query<{ plan_id: string }>(`SELECT plan_id FROM users WHERE id = $1 LIMIT 1`, [userId]));
  const pid = row.rows[0]?.plan_id ?? 'free';
  return (pid === 'free' || pid === 'pro' || pid === 'team' || pid === 'api' ? pid : 'free') as GatewayContext['planId'];
}

function classifyHeuristic(question: string): { tool: string; args: Record<string, unknown> } {
  const q = question.toLowerCase();
  const paymentId = q.match(/pay_[A-Za-z0-9_-]{8,64}/)?.[0] ?? null;

  if (paymentId && (q.includes('stop') || q.includes('hold') || q.includes('cancel') || q.includes('reject'))) {
    return { tool: 'stop_intervention', args: { paymentId, reason: 'Founder instruction (heuristic)', confirm: true } };
  }
  if (q.includes('disable autopilot') || q.includes('turn off autopilot') || q.includes('set autopilot to manual') || q.includes('manual mode')) {
    return { tool: 'set_autopilot', args: { mode: 'MANUAL', confirm: true } };
  }
  if (q.includes('enable autopilot') || q.includes('turn on autopilot') || q.includes('set autopilot to autopilot') || q.includes('autopilot mode on')) {
    return { tool: 'set_autopilot', args: { mode: 'AUTOPILOT', confirm: true } };
  }
  if (q.includes('monthly')) {
    return { tool: 'monthly_revenue', args: {} };
  }
  if (q.includes('today') || q.includes('this week') || q.includes('weekly')) {
    return { tool: 'revenue', args: {} };
  }
  if (q.includes('revenue') || q.includes('earn') || q.includes('sold') || q.includes('income')) {
    return { tool: 'revenue', args: {} };
  }
  if (q.includes('detail') && paymentId) {
    return { tool: 'payment_detail', args: { intentId: paymentId } };
  }
  if (q.includes('recent payment') || q.includes('latest payment') || q.includes('payments')) {
    return { tool: 'payments', args: {} };
  }
  if (q.includes('review') || q.includes('pending') || q.includes('inbox') || q.includes('claim')) {
    return { tool: 'reviews', args: {} };
  }
  if (q.includes('fail') || q.includes('unmatched') || q.includes('mismatch') || q.includes('signature')) {
    return { tool: 'failures', args: {} };
  }
  if (q.includes('audit') || q.includes('trail')) {
    return { tool: 'audit', args: {} };
  }
  if (q.includes('autopilot') || q.includes('mode')) {
    return { tool: 'autopilot', args: {} };
  }
  return { tool: 'dashboard', args: {} };
}

export async function founderAiQuery(actorUserId: string, rawQuestion: string): Promise<{
  question: string;
  tool: string;
  args: Record<string, unknown>;
  data: Record<string, unknown>;
  answeredBy: 'ai' | 'heuristic';
  note: string;
}> {
  const question = String(rawQuestion ?? '').trim().slice(0, 2000);
  if (!question) throw AppError.badRequest('question_required', 'Ask a question.');

  const allowed = TOOLS;
  let selection: { tool: string; args: Record<string, unknown> } | null = null;
  let answeredBy: 'ai' | 'heuristic' = 'heuristic';

  if (env.AI_FOUNDER_AGENT !== 'false') {
    try {
      const llm = await classifyWithLLM(question, actorUserId);
      if (llm && (llm.tool in allowed || llm.tool === 'set_autopilot')) {
        selection = llm;
        answeredBy = 'ai';
      }
    } catch {
      // fall through to heuristic
    }
  }
  if (!selection) selection = classifyHeuristic(question);

  const tool = allowed[selection.tool];
  if (!tool) {
    throw AppError.badRequest('founder_ai_unknown_tool', `The assistant found no safe operation for: ${selection.tool}`);
  }
  const parsed = tool.args.safeParse(selection.args);
  if (!parsed.success) {
    throw AppError.badRequest('founder_ai_invalid_args', `Invalid arguments for ${selection.tool}: ${parsed.error.message}`);
  }

  let data: FounderToolResult;
  try {
    data = await tool.run((parsed.data ?? {}) as Record<string, unknown>, actorUserId);
  } catch (err) {
    if (err instanceof AppError) {
      await recordAudit({
        action: 'payment.founder_ai_refused',
        actorUserId,
        scope: 'SYSTEM',
        tenantId: actorUserId,
        resourceType: 'founder_ai',
        resourceId: selection.tool,
        detail: { reason: err.message },
      });
      throw err;
    }
    throw err;
  }

  await recordAudit({
    action: 'payment.founder_ai_query',
    actorUserId,
    scope: 'SYSTEM',
    tenantId: actorUserId,
    resourceType: 'founder_ai',
    resourceId: selection.tool,
    detail: { tool: selection.tool, args: sanitizeArgs(selection.args), answeredBy },
  });

  return {
    question,
    tool: selection.tool,
    args: selection.args,
    data,
    answeredBy,
    note: tool.kind === 'read'
      ? 'AI reported live server data only; it never verified or invented payment truth.'
      : 'Founder control executed against the existing verified payment authority.',
  };
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.startsWith('pay_')) out[k] = 'pay_***';
    else if (k === 'reason' || k === 'email') out[k] = '***';
    else out[k] = v;
  }
  return out;
}