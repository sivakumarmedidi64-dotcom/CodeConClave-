/**
 * CodeConClave — AI gateway: routing + compute governance (Phase 5 hardened).
 *
 * Routing order: entitlement → required capabilities → context window →
 * privacy requirements → provider/model health → latency requirement →
 * cost efficiency → user preference. Returns PRIMARY → FALLBACK → TERTIARY;
 * graceful failure when no qualified model exists (never invents provider
 * capabilities).
 *
 * Compute policy: cheapest qualified model for simple work; premium compute is
 * budget-gated — a premium request goes ENTITLEMENT CHECK → COMPUTE POLICY →
 * PREMIUM ALLOWED? YES → execute / NO → qualified cheaper model? → fallback /
 * NO → explain. Normal Pro usage continues whenever a qualified lower-cost
 * path exists.
 *
 * Every inference produces a model_usage_logs row with the compute decision
 * (fallback reason, cost, duration, tenant, coworker). Failures are classified
 * into the shared fallback-reason taxonomy; nothing is silent or faked.
 */
import { getRegistry, getModel, configuredProviders } from './registry.js';
import { getAdapter, updateProviderHealth, classifyProviderError, type ChatRequest, type ChatMessage, type ChatChunk } from './providers.js';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { pool } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { logger } from '../../shared/logger.js';
import type { AiModelDescriptor, PlanId, AiFallbackReason, PrivacyClass } from '@codeconclave/shared';
import { ComputeClass } from '@codeconclave/shared';
import { incrementUsage } from '../workspace/service.js';
import { UsageCounterName } from '@codeconclave/shared';

export interface GatewayContext {
  userId: string;
  sessionId: string;
  conversationId?: string | null;
  taskId?: string | null;
  planId: PlanId;
  tenantId?: string | null;
  coworkerType?: string | null;
}

export interface RouteOptions {
  requestedModelId?: string;
  computeClass?: 'A' | 'B' | 'C';
  needsTools?: boolean;
  needsVision?: boolean;
  needsFunctionCalling?: boolean;
  maxContextTokens?: number;
  privacyClass?: PrivacyClass;
  maxLatencyMs?: number;
  excludePremium?: boolean;
  coworkerType?: string | null;
  /** Coding workloads prefer coding-optimized models (agent CODER/DEBUGGER roles). */
  coding?: boolean;
  /** Exclude an entire provider (e.g. independent REVIEWER must not reuse the author's model). */
  excludeProvider?: string;
}

export interface RoutedSelection {
  primary: AiModelDescriptor;
  fallback: AiModelDescriptor;
  tertiary: AiModelDescriptor;
}

const PRIVACY_WEIGHT: Record<PrivacyClass, number> = { PUBLIC: 1, STANDARD: 2, STRICT: 3 };

/** Privacy compatibility: the model's class must be at least as strict as the request's. */
function privacyOk(modelClass: PrivacyClass, requestClass: PrivacyClass | undefined): boolean {
  if (!requestClass) return true;
  return PRIVACY_WEIGHT[modelClass] >= PRIVACY_WEIGHT[requestClass];
}

async function planIdOf(userId: string): Promise<PlanId> {
  const result = await pool.query('SELECT plan_id FROM users WHERE id = $1', [userId]);
  return (result.rows[0]?.plan_id as PlanId | undefined) ?? 'free';
}

/** Models eligible for a user right now, ranked by compute class then priority then cost. */
export async function eligibleModels(userId: string, opts: RouteOptions = {}): Promise<AiModelDescriptor[]> {
  const registry = await getRegistry();
  const plan = await planIdOf(userId);
  const configured = new Set(configuredProviders());

  const eligible = registry.filter((m) => {
    if (m.health === 'DOWN') return false;
    if (m.entitlement === 'PRO' && plan === 'free') return false;
    if (!configured.has(m.providerId)) return false;
    if (opts.excludeProvider && m.providerId === opts.excludeProvider) return false;
    if (opts.needsTools && !m.supportsTools) return false;
    if (opts.needsFunctionCalling && !m.supportsFunctionCalling) return false;
    if (opts.needsVision && !m.supportsVision) return false;
    if (opts.maxContextTokens && m.contextWindow < opts.maxContextTokens) return false;
    if (!privacyOk(m.privacyClass, opts.privacyClass)) return false;
    if (opts.maxLatencyMs && m.targetLatencyMs > opts.maxLatencyMs) return false;
    if (opts.excludePremium && m.computeClass === 'C') return false;
    if (opts.computeClass === 'A' && m.computeClass !== 'A' && plan !== 'pro') return false;
    if (opts.computeClass === 'A' && m.tier !== 'EFFICIENT') return false;
    if (plan === 'free' && m.tier !== 'EFFICIENT') return false;
    return true;
  });

  // Compute class preference for the workload.
  const wantedClass = opts.computeClass ?? 'B';
  const ranked = [...eligible].sort((a, b) => {
    const classDiff = classWeight(a.computeClass) - classWeight(b.computeClass);
    if (wantedClass === 'A' && classDiff !== 0) return classDiff;
    if (opts.coding) {
      const codingDiff = Number(b.codingOptimized) - Number(a.codingOptimized);
      if (codingDiff !== 0) return codingDiff;
    }
    return (a.priority - b.priority) || (a.inputCostPerM - b.inputCostPerM);
  });
  return ranked;
}

export async function routeModels(userId: string, opts: RouteOptions): Promise<RoutedSelection> {
  const ranked = await eligibleModels(userId, opts);
  // AI_DEFAULT_MODEL is the server-level preference when the caller did not
  // request a specific model; it must still pass eligibility (entitlement,
  // health, capabilities) — otherwise routing falls back to the ranked list.
  const defaultModelId = opts.requestedModelId ?? (env.AI_DEFAULT_MODEL || undefined);

  const pick = (list: AiModelDescriptor[], modelId?: string): AiModelDescriptor | null => {
    if (modelId) {
      const exact = list.find((m) => m.modelId === modelId && m.health !== 'DOWN');
      if (exact) return exact;
    }
    return list[0] ?? null;
  };

  const primary = pick(ranked, defaultModelId);
  const remaining = ranked.filter((m) => m.modelId !== primary?.modelId);
  const fallback = pick(remaining);
  const tertiary = pick(remaining.filter((m) => m.modelId !== fallback?.modelId));

  if (!primary) {
    // Honest failure: no eligible model (e.g. no keys configured).
    const providers = configuredProviders().length;
    throw AppError.unavailable(
      'no_model_available',
      providers === 0
        ? 'No AI provider is configured on the server. Add at least one provider API key.'
        : 'No model currently satisfies the request (entitlement/capability/privacy/health).',
    );
  }
  return { primary, fallback: fallback ?? primary, tertiary: tertiary ?? fallback ?? primary };
}

function classWeight(c: string): number {
  return c === 'A' ? 1 : c === 'B' ? 2 : 3;
}

// ------------------------------------------------------------ compute policy

export interface ComputePolicyRow {
  class: 'A' | 'B' | 'C';
  description: string;
  maxTier: 'EFFICIENT' | 'CAPABLE' | 'PREMIUM';
  premiumBudgetUsdPerDay: number;
  enabled: boolean;
}

const POLICY_DEFAULTS: Record<'A' | 'B' | 'C', ComputePolicyRow> = {
  A: { class: 'A', description: 'CHEAP — simple questions, explanations, summarization, small edits', maxTier: 'EFFICIENT', premiumBudgetUsdPerDay: 0, enabled: true },
  B: { class: 'B', description: 'STANDARD — normal coding and knowledge work', maxTier: 'CAPABLE', premiumBudgetUsdPerDay: 0, enabled: true },
  C: { class: 'C', description: 'PREMIUM — complex justified work, budget-gated per plan', maxTier: 'PREMIUM', premiumBudgetUsdPerDay: env.AI_PREMIUM_BUDGET_USD_PER_DAY, enabled: true },
};

/** Config-driven compute policy; falls back to environment defaults when the table is empty. */
export async function getComputePolicy(computeClass: 'A' | 'B' | 'C'): Promise<ComputePolicyRow> {
  try {
    const result = await pool.query(
      `SELECT class, description, max_tier, premium_budget_usd_per_day, enabled FROM compute_policy WHERE class = $1`,
      [computeClass],
    );
    const row = result.rows[0];
    if (row) {
      return {
        class: row.class,
        description: row.description,
        maxTier: row.max_tier,
        premiumBudgetUsdPerDay: Number(row.premium_budget_usd_per_day),
        enabled: row.enabled,
      };
    }
  } catch {
    /* table may not exist in unit tests — fall back to defaults */
  }
  return POLICY_DEFAULTS[computeClass];
}

/** Daily premium spend gate (compute governance, per user). */
export async function premiumBudgetRemaining(userId: string, budgetCapUsd = env.AI_PREMIUM_BUDGET_USD_PER_DAY): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS spent FROM model_usage_logs
     WHERE user_id = $1 AND created_at >= $2::date`,
    [userId, today],
  );
  const spent = Number(result.rows[0]?.spent ?? 0);
  return Math.max(0, budgetCapUsd - spent);
}

/**
 * Premium compute gate: ENTITLEMENT CHECK → COMPUTE POLICY → PREMIUM ALLOWED?
 * A premium REQUEST is explicit computeClass C, or an explicit user pick of a
 * premium model. When denied, a qualified cheaper selection is returned when
 * one exists; otherwise the caller explains (structured error). Default
 * requests never silently spend premium compute.
 */
async function premiumAllowance(
  ctx: GatewayContext,
  opts: RouteOptions,
): Promise<{ allowed: boolean; selection?: RoutedSelection; reason?: AiFallbackReason; message?: string }> {
  const entitled = ctx.planId !== 'free';

  // Routing first: for an explicit premium request, a routing failure (e.g. no
  // eligible model under a free plan) must still surface the premium gate with
  // an explanation rather than a generic no_model_available.
  let chosen: RoutedSelection | null = null;
  try {
    chosen = await routeModels(ctx.userId, opts);
  } catch (err) {
    if (opts.computeClass !== 'C' && opts.requestedModelId === undefined) throw err;
  }

  const explicitPremium =
    opts.computeClass === 'C' ||
    (opts.requestedModelId !== undefined && (chosen === null || chosen.primary.computeClass === 'C'));

  const denyWithCheaper = async (reason: AiFallbackReason, message: string) => {
    const cheaper = await cheaperSelection(ctx, opts);
    return cheaper
      ? { allowed: false, selection: cheaper, reason, message }
      : { allowed: false, reason, message };
  };

  if (explicitPremium) {
    const policy = await getComputePolicy('C');
    const cap = policy.enabled ? policy.premiumBudgetUsdPerDay : env.AI_PREMIUM_BUDGET_USD_PER_DAY;
    if (!entitled) {
      return denyWithCheaper(
        'entitlement_mismatch',
        'Premium compute requires an entitled plan (Pro/Team/Enterprise), and no qualified cheaper model exists for this request. Upgrade to Pro or reduce the request.',
      );
    }
    const budget = await premiumBudgetRemaining(ctx.userId, cap);
    if (cap <= 0 || budget <= 0) {
      return denyWithCheaper(
        'premium_compute_denied',
        'Daily premium compute budget is exhausted and no cheaper qualified model exists for this request. Reduce scope or wait for the daily reset.',
      );
    }
    return { allowed: true, selection: chosen ?? undefined };
  }

  // Default/standard request: never silently spend premium compute — if the
  // router's choice landed on a premium model, prefer a qualified cheaper one
  // (normal Pro usage continues; the premium model needs an explicit request).
  if (chosen && chosen.primary.computeClass === 'C' && entitled) {
    const cheaper = await cheaperSelection(ctx, opts);
    if (cheaper) {
      return {
        allowed: false,
        selection: cheaper,
        reason: 'premium_compute_denied',
        message: 'Premium compute requires an explicit request. Continuing with a qualified cheaper model.',
      };
    }
  }
  return { allowed: true, selection: chosen ?? undefined };
}

async function cheaperSelection(ctx: GatewayContext, opts: RouteOptions): Promise<RoutedSelection | null> {
  try {
    return await routeModels(ctx.userId, { ...opts, excludePremium: true, requestedModelId: undefined });
  } catch {
    return null;
  }
}

export function computeClassForTask(requestedClass?: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  return (requestedClass ?? 'B') as 'A' | 'B' | 'C';
}

// ---------------------------------------------------------------- completion

export interface CompleteOptions {
  ctx: GatewayContext;
  messages: ChatMessage[];
  opts?: RouteOptions;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: ChatChunk) => Promise<void> | void;
}

export interface CompletionSummary {
  text: string;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  usedFallback: boolean;
  fallbackReason: AiFallbackReason | null;
}

async function logUsage(ctx: GatewayContext, summary: CompletionSummary, opts: RouteOptions): Promise<void> {
  const cost = summary.estimatedCostUsd;
  await Promise.allSettled([
    pool.query(
      `INSERT INTO model_usage_logs
         (id, user_id, tenant_id, task_id, session_id, conversation_id, provider_id, model_id, plan_id, compute_class,
          coworker_type, input_tokens, output_tokens, estimated_cost_usd, actual_cost_usd, duration_ms, used_fallback, fallback_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        newId(PREFIX.MESSAGE),
        ctx.userId,
        ctx.tenantId ?? ctx.userId,
        ctx.taskId ?? null,
        ctx.sessionId,
        ctx.conversationId ?? null,
        summary.providerId,
        summary.modelId,
        ctx.planId,
        opts.computeClass ?? 'B',
        opts.coworkerType ?? ctx.coworkerType ?? null,
        summary.inputTokens,
        summary.outputTokens,
        cost,
        null,
        summary.durationMs,
        summary.usedFallback,
        summary.fallbackReason,
      ],
    ),
    incrementUsage(ctx.userId, UsageCounterName.DAILY_AI_INPUT_TOKENS, summary.inputTokens),
    incrementUsage(ctx.userId, UsageCounterName.DAILY_AI_OUTPUT_TOKENS, summary.outputTokens),
    incrementUsage(ctx.userId, UsageCounterName.DAILY_ESTIMATED_COST_USD, Math.round(cost * 1000)),
  ]);
}

/**
 * Per-attempt timeout + caller cancellation + chain deadline, combined into
 * one AbortSignal. The chain deadline bounds the WHOLE fallback chain so a
 * provider hang can never hold the stream open beyond a deterministic limit.
 */
function attemptSignal(
  caller?: AbortSignal,
  deadline?: AbortSignal,
  timeoutMs?: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const onAbort = () => controller.abort('cancelled');
  const onDeadline = () => controller.abort('timeout');
  if (caller) {
    if (caller.aborted) controller.abort('cancelled');
    else caller.addEventListener('abort', onAbort, { once: true });
  }
  if (deadline) {
    if (deadline.aborted) controller.abort('timeout');
    else deadline.addEventListener('abort', onDeadline, { once: true });
  }
  if (!caller?.aborted && !deadline?.aborted) {
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs ?? env.AI_REQUEST_TIMEOUT_MS);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (caller) caller.removeEventListener('abort', onAbort);
      if (deadline) deadline.removeEventListener('abort', onDeadline);
      if (timer) clearTimeout(timer);
    },
  };
}

export async function completeWithFallback(opts: CompleteOptions): Promise<CompletionSummary> {
  const ctx = opts.ctx;
  const requestOpts = opts.opts ?? {};

  // Compute governance: premium requests are gated before any spend.
  const allowance = await premiumAllowance(ctx, requestOpts);
  if (!allowance.allowed && !allowance.selection) {
    throw AppError.unavailable('premium_compute_denied', allowance.message ?? 'Premium compute denied');
  }
  const selection = allowance.selection ?? (await routeModels(ctx.userId, requestOpts));
  const premiumReason = allowance.allowed ? null : (allowance.reason ?? 'premium_compute_denied');

  const attempts: Array<{ model: AiModelDescriptor; usedFallback: boolean }> = [
    { model: selection.primary, usedFallback: false },
    { model: selection.fallback, usedFallback: true },
    { model: selection.tertiary, usedFallback: true },
  ];

  const onChunk = opts.onChunk;
  let firstFailReason: AiFallbackReason | null = null;
  let retryAfterSec: number | undefined;
  // Chain deadline: a deterministic finite upper bound over ALL attempts, so
  // the whole generation (and the SSE stream) always terminates.
  const chainController = new AbortController();
  const chainTimer = setTimeout(() => chainController.abort('timeout'), env.AI_CHAIN_TIMEOUT_MS);
  try {
    for (const attempt of attempts) {
      const adapter = getAdapter(attempt.model.providerId, attempt.model.modelId);
      const attemptStart = Date.now();
      const { signal, cleanup } = attemptSignal(opts.signal, chainController.signal);
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        for await (const chunk of adapter.complete(
          { messages: opts.messages, maxTokens: opts.maxTokens, temperature: opts.temperature },
          signal,
        )) {
          text += chunk.delta;
          inputTokens = chunk.inputTokens ?? inputTokens;
          outputTokens = chunk.outputTokens ?? outputTokens;
          if (onChunk) await onChunk(chunk);
        }
        cleanup();
        if (!text.trim()) throw new Error('empty completion');
        const durationMs = Date.now() - attemptStart;
        updateProviderHealth(attempt.model.providerId, true, durationMs);
        const inputTokensFinal = inputTokens || Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 4);
        const outputTokensFinal = outputTokens || Math.ceil(text.length / 4);
        const cost = estimateCost(attempt.model, inputTokensFinal, outputTokensFinal);
        const summary: CompletionSummary = {
          text,
          modelId: attempt.model.modelId,
          providerId: attempt.model.providerId,
          inputTokens: inputTokensFinal,
          outputTokens: outputTokensFinal,
          estimatedCostUsd: cost,
          durationMs,
          usedFallback: attempt.usedFallback || premiumReason !== null,
          fallbackReason: premiumReason ?? firstFailReason,
        };
        await logUsage(ctx, summary, requestOpts);
        logger.info('ai.completed', {
          userId: ctx.userId,
          model: attempt.model.modelId,
          fallback: attempt.usedFallback,
          reason: summary.fallbackReason,
          costUsd: cost,
          durationMs,
        });
        return summary;
      } catch (err) {
        cleanup();
        if (opts.signal?.aborted) {
          // Caller cancellation: never fall back after the user cancelled.
          throw err instanceof AppError ? err : AppError.unavailable('stream_interrupted', 'Request cancelled');
        }
        const durationMs = Date.now() - attemptStart;
        const timedOut = err instanceof Error && err.name === 'AbortError' && signal.aborted;
        const reason = classifyProviderError(err, timedOut);
        if (!firstFailReason) firstFailReason = reason;
        if (err instanceof AppError && err.errorCode === 'rate_limited') {
          const r = (err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
          if (typeof r === 'number') retryAfterSec = r;
        }
        updateProviderHealth(attempt.model.providerId, false, durationMs, err instanceof Error ? err.message : 'error');
        logger.warn('ai.attempt_failed', {
          provider: attempt.model.providerId,
          model: attempt.model.modelId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof AppError && err.errorCode === 'provider_not_configured') continue;
        // transient network/provider errors → try next in chain
      }
    }
  } finally {
    clearTimeout(chainTimer);
  }

  // Honest failure with the classified reason recorded for audit. Rate-limit
  // guidance is surfaced when the provider told us when to retry — never
  // waited on, always bounded.
  const failureReason = firstFailReason ?? 'provider_unavailable';
  const retryHint =
    failureReason === 'rate_limited' && retryAfterSec !== undefined
      ? ` Retry after ~${retryAfterSec}s.`
      : ' Try again shortly.';
  await logUsage(ctx, {
    text: '',
    modelId: selection.primary.modelId,
    providerId: selection.primary.providerId,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 0,
    usedFallback: true,
    fallbackReason: failureReason,
  }, requestOpts);
  throw AppError.unavailable(
    'model_unavailable',
    `All configured models failed (${failureReason}). Provider health has been updated.${retryHint}`,
  );
}

export function estimateCost(model: AiModelDescriptor, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * model.inputCostPerM + (outputTokens / 1_000_000) * model.outputCostPerM;
}

export async function estimatedCostOfRequest(userId: string, messages: ChatMessage[], opts: RouteOptions): Promise<number> {
  try {
    const selection = await routeModels(userId, opts);
    const inputTokens = messages.reduce((n, m) => n + m.content.length, 0) / 4;
    return estimateCost(selection.primary, Math.ceil(inputTokens), 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------- typed tool calls

export interface TypedToolRequest {
  tool: string;
  input: Record<string, unknown>;
  modelId: string;
  providerId: string;
}

export interface ToolSchema {
  tool: string;
  description?: string;
}

/**
 * Deterministic parse of model output into a TYPED tool request. No model is
 * involved in policy: the schema check below decides what the output means.
 * The result must still pass the deterministic policy engine and (for
 * HIGH/CRITICAL) the approval gate before any execution.
 */
export function parseToolRequest(text: string, allowedTools: string[]): TypedToolRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw AppError.badRequest('invalid_tool_request', 'Model output was not valid JSON for a tool request');
  }
  const obj = parsed as { tool?: unknown; input?: unknown };
  if (typeof obj.tool !== 'string' || !allowedTools.includes(obj.tool)) {
    throw AppError.badRequest('invalid_tool_request', `Tool ${typeof obj.tool === 'string' ? obj.tool : '<invalid>'} is not allowed for this request`);
  }
  if (typeof obj.input !== 'object' || obj.input === null || Array.isArray(obj.input)) {
    throw AppError.badRequest('invalid_tool_request', 'Tool request input must be an object');
  }
  return { tool: obj.tool, input: obj.input as Record<string, unknown>, modelId: '', providerId: '' };
}

export interface ToolCallOptions {
  schema: ToolSchema;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  routeOpts?: RouteOptions;
}

export interface ToolCallResult {
  request: TypedToolRequest;
  modelId: string;
  providerId: string;
  usedFallback: boolean;
}

/**
 * Normalized typed tool-call request through the gateway. Routes to a model
 * with function-calling support; if the adapter cannot participate in typed
 * tool-call requests (capability mismatch), the router picks a qualified
 * alternative; if none exists it reports `unsupported_feature` — never a fake
 * tool call.
 */
export async function requestToolCall(ctx: GatewayContext, opts: ToolCallOptions): Promise<ToolCallResult> {
  const selection = await routeModels(ctx.userId, {
    ...opts.routeOpts,
    needsTools: true,
    needsFunctionCalling: true,
  });

  const attempts: Array<{ model: AiModelDescriptor; usedFallback: boolean }> = [
    { model: selection.primary, usedFallback: false },
    { model: selection.fallback, usedFallback: true },
    { model: selection.tertiary, usedFallback: true },
  ];

  const instruction =
    `Respond with ONLY a single JSON object of the form {"tool":"${opts.schema.tool}","input":{...}} ` +
    `for the requested tool. No prose, no markdown.${opts.schema.description ? ` Tool: ${opts.schema.description}` : ''}`;

  let lastReason: AiFallbackReason = 'capability_mismatch';
  const chainController = new AbortController();
  const chainTimer = setTimeout(() => chainController.abort('timeout'), env.AI_CHAIN_TIMEOUT_MS);
  try {
    for (const attempt of attempts) {
      const adapter = getAdapter(attempt.model.providerId, attempt.model.modelId);
      if (!adapter.supportsToolCalls) {
        lastReason = 'capability_mismatch';
        continue;
      }
      const { signal, cleanup } = attemptSignal(opts.signal, chainController.signal);
      const attemptStart = Date.now();
      let text = '';
      try {
        for await (const chunk of adapter.complete(
          {
            messages: [...opts.messages, { role: 'system' as const, content: instruction }],
            maxTokens: opts.maxTokens ?? 512,
            temperature: 0,
          },
          signal,
        )) {
          text += chunk.delta;
        }
        cleanup();
        const request = parseToolRequest(text.trim(), [opts.schema.tool]);
        updateProviderHealth(attempt.model.providerId, true, Date.now() - attemptStart);
        return {
          request: { ...request, modelId: attempt.model.modelId, providerId: attempt.model.providerId },
          modelId: attempt.model.modelId,
          providerId: attempt.model.providerId,
          usedFallback: attempt.usedFallback,
        };
      } catch (err) {
        cleanup();
        if (opts.signal?.aborted) throw err;
        lastReason = classifyProviderError(err);
        logger.warn('ai.tool_attempt_failed', {
          provider: attempt.model.providerId,
          model: attempt.model.modelId,
          reason: lastReason,
        });
      }
    }
  } finally {
    clearTimeout(chainTimer);
  }
  throw AppError.unavailable(
    lastReason === 'capability_mismatch' ? 'unsupported_feature' : 'model_unavailable',
    lastReason === 'capability_mismatch'
      ? 'No configured model supports normalized typed tool-call requests for this request.'
      : `All models failed to produce a tool request (${lastReason}).`,
  );
}

export { ComputeClass, getModel };