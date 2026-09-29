/**
 * CodeConClave — AI routes: model catalogue (dropdown data), usage summary.
 * The server is authoritative for what the client may select.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { getRegistry, configuredProviders, computeModelAvailability } from './registry.js';
import { premiumBudgetRemaining } from './gateway.js';
import { providerStatusSnapshot } from './status.js';
import { capabilityClassOf } from './capabilities.js';
import { providerKeyState } from './providerKeySpec.js';
import { planRoute, type RoutingDecision } from './router.js';
import { classifyIntent } from './intent.js';
import {
  loadRoutingPreferences,
  saveRoutingPreferences,
  DEFAULT_ROUTING_PREFERENCES,
  ROUTING_PREFERENCE_VALUES,
} from './routing-preferences.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { completeWithFallback, type CompleteOptions, type CompletionSummary, type GatewayContext } from './gateway.js';
import type { ChatContentPart, ChatMessage } from './providers.js';
import { apiAccessEntitlementState } from '../apikeys/service.js';
import { workspaceAccess, workspaceReasonMessage } from '../../middleware/entitlement.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { RoutingPreference } from '@codeconclave/shared';
import { pool, withTenant } from '../../shared/db.js';
import { env } from '../../config/env.js';
import { getUserById } from '../auth/service.js';

export const aiRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  // No-free-tier gate for the SESSION path.
  //
  // /api/v1/ai is mounted OUTSIDE requireWorkspaceEntitlement() because the
  // Bearer cc_live_* path is gated by apiKeyAuth's 402 (API Access ?9,999).
  // That left the cookie/session path ungated: any signed-in FREE user could
  // POST /chat/completions and receive real completions on EFFICIENT-tier
  // models, which is a free product by another door. A session user must
  // therefore hold an active verified paid entitlement (Solo or Team, or a
  // verified API Access grant) before this router is reached.
  router.use(async (req, _res, next) => {
    // Bearer-authenticated requests were already authorised (and paid-gated) by
    // apiKeyAuth; do not apply the workspace rule to them.
    if (/^Bearer\s+/i.test(req.headers.authorization ?? '')) {
      next();
      return;
    }
    try {
      const access = await workspaceAccess(req.ctx!.user!.id);
      if (access.unlocked) {
        next();
        return;
      }
      const api = await apiAccessEntitlementState(req.ctx!.user!.id);
      if (api.entitled) {
        next();
        return;
      }
      next(
        AppError.paymentRequired(
          'entitlement_required',
          `AI access requires an active paid plan. ${workspaceReasonMessage(access.reason)}`,
        ),
      );
    } catch (err) {
      next(AppError.unavailable('entitlement_check_failed', 'Could not verify entitlement. Try again.'));
    }
  });

  router.get(
    '/models',
    asyncRoute(async (req, res) => {
      const user = await getUserById(req.ctx.user!.id);
      const registry = await getRegistry();
      const configured = new Set(configuredProviders());
      const budgetRemaining = user.planId === 'pro' ? await premiumBudgetRemaining(user.id) : null;
      // Server-authoritative availability: a model is selectable ONLY when its
      // provider is configured, the provider is not DOWN/DEGRADED, the user is
      // entitled, and (for premium models) the daily budget is not exhausted.
      // The client may not override. Shared predicate: computeModelAvailability.
      const models = registry.map((m) => {
        const { available, overBudget } = computeModelAvailability({
          configured: configured.has(m.providerId),
          health: m.health,
          computeClass: m.computeClass,
          entitled: m.entitlement !== 'PRO' || user.planId === 'pro',
          budgetRemaining,
        });
        return {
          id: m.modelId,
          providerId: m.providerId,
          label: m.displayName,
          description: null,
          tier: m.tier,
          computeClass: m.computeClass,
          health: m.health,
          capabilityCategory: m.capabilityCategory,
          capabilityClass: capabilityClassOf(m),
          imageGeneration: Boolean(m.imageGeneration),
          imageEditing: Boolean(m.imageEditing),
          locked: m.entitlement === 'PRO' && user.planId !== 'pro',
          available,
          overBudget,
        };
      });
      res.json(jsonResult({ models, defaultModel: env.AI_DEFAULT_MODEL ?? null, configuredProviders: configuredProviders() }));
    }),
  );

  router.get(
    '/usage',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const user = await getUserById(userId);
      const today = new Date().toISOString().slice(0, 10);
      const result = await withTenant(userId, (q) => q.query(
        `SELECT
           COALESCE(SUM(input_tokens),0) AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(estimated_cost_usd),0) AS cost_usd,
           count(*)::int AS calls
         FROM model_usage_logs WHERE user_id = $1 AND created_at >= $2::date`,
        [userId, today],
      ));
      const row = result.rows[0] ?? {};
      const [byProvider, byModel, recent] = await Promise.all([
        withTenant(userId, (q) => q.query(
          `SELECT provider_id, count(*)::int AS calls, COALESCE(SUM(estimated_cost_usd),0) AS cost_usd
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= $2::date
           GROUP BY provider_id ORDER BY cost_usd DESC`,
          [userId, today],
        )),
        withTenant(userId, (q) => q.query(
          `SELECT provider_id, model_id,
                  count(*)::int AS calls,
                  COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(estimated_cost_usd),0) AS cost_usd,
                  bool_or(used_fallback) AS used_fallback
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= $2::date
           GROUP BY provider_id, model_id ORDER BY cost_usd DESC`,
          [userId, today],
        )),
        withTenant(userId, (q) => q.query(
          `SELECT provider_id, model_id, used_fallback, fallback_reason, estimated_cost_usd, duration_ms, created_at
           FROM model_usage_logs WHERE user_id = $1
           ORDER BY created_at DESC LIMIT 10`,
          [userId],
        )),
      ]);
      res.json(
        jsonResult({
          today: {
            inputTokens: Number(row.input_tokens ?? 0),
            outputTokens: Number(row.output_tokens ?? 0),
            costUsd: Number(row.cost_usd ?? 0),
            calls: row.calls ?? 0,
          },
          byProvider: byProvider.rows.map((r) => ({
            providerId: r.provider_id,
            calls: r.calls,
            costUsd: Number(r.cost_usd),
          })),
          byModel: byModel.rows.map((r) => ({
            providerId: r.provider_id,
            modelId: r.model_id,
            calls: r.calls,
            inputTokens: Number(r.input_tokens),
            outputTokens: Number(r.output_tokens),
            costUsd: Number(r.cost_usd),
            usedFallback: r.used_fallback,
          })),
          transparency: recent.rows.map((r) => ({
            providerId: r.provider_id,
            modelId: r.model_id,
            usedFallback: r.used_fallback,
            fallbackReason: r.fallback_reason,
            costUsd: Number(r.estimated_cost_usd ?? 0),
            durationMs: r.duration_ms,
            createdAt: r.created_at,
          })),
          plan: user.planId,
          premiumBudgetRemainingUsd: user.planId === 'pro' ? await premiumBudgetRemaining(userId) : null,
          resetDate: today,
        }),
      );
    }),
  );

  router.get(
    '/providers',
    asyncRoute(async (req, res) => {
      const providers = await providerStatusSnapshot();
      res.json(
        jsonResult({
          providers: providers.map((p) => ({
            ...p,
            // Honest credential machine surfaced to Web + Desktop: the UI
            // renders state text, never fabricated availability. KEY_INVALID
            // is never auto-upgraded to ENVIRONMENT_BLOCKED.
            keyState: providerKeyState(p.providerId),
          })),
          // Server-authoritative truth: LIVE only when a provider is configured
          // AND passing probes. Everything else is honest status text — the UI
          // renders it, it never claims availability.
          live: providers.filter((p) => p.status === 'AVAILABLE').map((p) => p.providerId),
          generatedAt: new Date().toISOString(),
        }),
      );
    }),
  );

  // ------------------------------------------------------------ routing (Model Routing 2026)
  // GET /routing — the compact, uniform routing decision + user preferences.
  // Shared by Web and Desktop through the SAME endpoint (no desktop-only brain).
  // The decision is explainable but never leaks secrets or scoring internals.
  router.get(
    '/routing',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const preferences = await loadRoutingPreferences(userId);
      const text = typeof req.query.text === 'string' ? req.query.text.slice(0, 4000) : '';

      const decision: RoutingDecision = await planRoute({
        userId,
        text,
        routingPreference: preferences.routingPreference,
        requestedModelId: preferences.preferredModelId ?? undefined,
        opts: { privacyClass: 'STANDARD' },
      });

      res.json(
        jsonResult({
          decision: sanitizeDecision(decision),
          preferences: {
            routingPreference: preferences.routingPreference,
            preferredModelId: preferences.preferredModelId,
            validPreferences: ROUTING_PREFERENCE_VALUES,
          },
          default: { ...DEFAULT_ROUTING_PREFERENCES },
        }),
      );
    }),
  );

  // GET /routing/preferences — current user routing preferences.
  router.get(
    '/routing/preferences',
    asyncRoute(async (req, res) => {
      const prefs = await loadRoutingPreferences(req.ctx.user!.id);
      res.json(jsonResult({ ...prefs }));
    }),
  );

  // PUT /routing/preferences — persist user routing preferences (validated).
  router.put(
    '/routing/preferences',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const body = (req.body ?? {}) as { routingPreference?: unknown; preferredModelId?: unknown; baseVersion?: number };
      const prefs = await saveRoutingPreferences(userId, body, body.baseVersion);
      res.json(jsonResult({ ...prefs }));
    }),
  );

  // POST /chat/completions — OpenAI-compatible chat completion for the SELF-
  // SERVE API product (₹9,999 API Access). Bearer cc_live_* keys are enforced
  // by apiKeyAuth on this mount (auth, product entitlement, per-key window/
  // daily/concurrency limits) BEFORE this handler runs; session users are
  // gated by requireAuth + the gateway's own plan checks. Streaming and
  // non-streaming requests are both supported. Every call produces a
  // model_usage_logs row (coworker_type 'API') — the same honest audit rail as
  // web chat. provider/models/routing endpoints above keep working unchanged.
  router.post(
    '/chat/completions',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const owner = await getUserById(userId);
      const api = await apiAccessEntitlementState(userId);
      // API Access is a ₹9,999 paid product: API-originated calls run with
      // paid ('pro') gateway semantics (premium-class models eligible, the
      // shared daily premium budget bounds spend — same governance as Solo).
      // `entitled` is expiry-aware, so an expired grant degrades to the
      // account's real plan instead of silently keeping paid semantics.
      const ctx: GatewayContext = {
        userId,
        sessionId: newId(PREFIX.SESSION),
        planId: api.entitled ? 'pro' : owner.planId,
        coworkerType: 'API',
      };
      if (!req.body || typeof req.body !== 'object') {
        throw AppError.badRequest('invalid_body', 'Request body must be a JSON object.');
      }
      const body = req.body as Record<string, unknown>;
      const messages = normalizeOpenAiMessages(body.messages);
      const stream = body.stream === true;
      const requestedModelId = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
      const maxTokens = clampInt(body.max_tokens, 1, 8192, 1024);
      const temperature = clampNum(body.temperature, 0, 2, 1);

      let selectedModel: string | undefined = requestedModelId;
      let requestOpts: CompleteOptions['opts'] = {
        computeClass: 'B',
        privacyClass: 'STANDARD',
        ...(requestedModelId ? { requestedModelId } : {}),
      };
      if (!requestedModelId) {
        try {
          const decision = await planRoute({
            userId,
            text: lastUserText(messages),
            routingPreference: RoutingPreference.AUTO,
            opts: { privacyClass: 'STANDARD', computeClass: 'B' },
          });
          selectedModel = decision.selectedModel;
          requestOpts = {
            ...requestOpts,
            requestedModelId: decision.selectedModel || undefined,
            computeClass: decision ? undefined : 'B',
            taskType: decision.taskType,
            routingPreference: decision.routingPreference,
          };
        } catch {
          // Routing is advisory: the gateway's own eligible-model resolution
          // still proceeds (never blocks the API).
        }
      }

      const id = newId(PREFIX.MESSAGE);
      const created = Math.floor(Date.now() / 1000);

      if (!stream) {
        const summary = await completeWithFallback({ ctx, messages, opts: requestOpts, maxTokens, temperature });
        res.json(jsonResult(chatCompletionObject(id, created, summary, selectedModel)));
        return;
      }

      // OpenAI-style SSE stream.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      let started = false;
      try {
        const summary = await completeWithFallback({
          ctx,
          messages,
          opts: requestOpts,
          maxTokens,
          temperature,
          signal: controller.signal,
          onChunk: async (chunk) => {
            if (!chunk.delta) return;
            started = true;
            const frame = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: selectedModel ?? 'codeconclave-ai',
              choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          },
        });
        // Final chunk carries finish_reason + usage, then the sentinel.
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: summary.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: usageOf(summary),
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        res.once('close', () => controller.abort());
        if (res.headersSent || started) {
          const e = err as { status?: number; errorCode?: string; message?: string };
          res.write(
            `data: ${JSON.stringify({
              error: { status: e.status ?? 500, code: e.errorCode ?? 'internal_error', message: e.message ?? 'Internal server error' },
            })}\n\n`,
          );
          res.end();
          return;
        }
        throw err;
      }
    }),
  );

  return router;
};

/** Keep routing decisions explainable; drop anything derivable that is not user-facing. */
function sanitizeDecision(d: RoutingDecision) {
  return {
    taskType: d.taskType,
    selectedProvider: d.selectedProvider,
    selectedModel: d.selectedModel,
    fallbackChain: d.fallbackChain.map((m) => ({ modelId: m.modelId, providerId: m.providerId, displayName: m.displayName })),
    reason: d.reason,
    estimatedCost: d.estimatedCost,
    capabilityMatch: d.capabilityMatch,
    confidence: d.confidence,
    healthState: d.healthState,
    routingPreference: d.routingPreference,
    requestedModelHonored: d.requestedModelHonored,
    requestedModelSubstituted: d.requestedModelSubstituted,
  };
}

// ------------------------------------------------ OpenAI-compatible helpers

const MAX_REQUEST_CHARS = 240_000;

/** Normalize an OpenAI message list ({role, content}) into the internal ChatMessage shape. */
function normalizeOpenAiMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw AppError.badRequest('messages_required', 'A non-empty "messages" array is required.');
  }
  const out: ChatMessage[] = [];
  let chars = 0;
  for (const rawMessage of raw) {
    if (!rawMessage || typeof rawMessage !== 'object') {
      throw AppError.badRequest('invalid_message', 'Each message must be an object with role and content.');
    }
    const m = rawMessage as { role?: unknown; content?: unknown };
    const role = m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw AppError.badRequest('unsupported_role', `Unsupported message role "${String(role)}"; expected system, user or assistant.`);
    }
    let content: string | ChatContentPart[];
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map((part) => normalizeContentPart(part));
    } else {
      throw AppError.badRequest('invalid_content', 'Message content must be a string or part array.');
    }
    const len = typeof content === 'string' ? content.length : JSON.stringify(content).length;
    chars += len;
    if (chars > MAX_REQUEST_CHARS) {
      throw AppError.badRequest('messages_too_large', `Request content exceeds the ${MAX_REQUEST_CHARS} character limit.`);
    }
    out.push({ role, content });
  }
  return out;
}

function normalizeContentPart(raw: unknown): ChatContentPart {
  if (!raw || typeof raw !== 'object') {
    throw AppError.badRequest('invalid_content', 'Invalid content part.');
  }
  const p = raw as { type?: unknown; text?: unknown; url?: unknown; data?: unknown; mimeType?: unknown };
  if (p.type === 'text' && typeof p.text === 'string') {
    return { type: 'text', text: p.text };
  }
  if (p.type === 'image_url' && typeof p.url === 'string') {
    return { type: 'image_url', url: p.url };
  }
  if (p.type === 'image_base64' && typeof p.data === 'string' && typeof p.mimeType === 'string') {
    return { type: 'image_base64', data: p.data, mimeType: p.mimeType };
  }
  throw AppError.badRequest('invalid_content', 'Unsupported content part; expected {type:"text"} or {type:"image_url"} or {type:"image_base64"}.');
}

/** Dependable low-level text for routing: the LAST user message, plain text only. */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function usageOf(s: CompletionSummary): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return {
    prompt_tokens: s.inputTokens,
    completion_tokens: s.outputTokens,
    total_tokens: s.inputTokens + s.outputTokens,
  };
}

function assistantContent(s: CompletionSummary): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  if (s.image) {
    return [
      { type: 'text', text: s.text },
      { type: 'image_url', image_url: { url: `data:${s.image.mimeType};base64,${s.image.dataB64}` } },
    ];
  }
  return s.text;
}

function chatCompletionObject(
  id: string,
  created: number,
  summary: CompletionSummary,
  plannedModel?: string,
): {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: ReturnType<typeof assistantContent> }; finish_reason: string }>;
  usage: ReturnType<typeof usageOf>;
} {
  return {
    id,
    object: 'chat.completion',
    created,
    model: summary.modelId ?? plannedModel ?? 'codeconclave-ai',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: assistantContent(summary) },
        finish_reason: 'stop',
      },
    ],
    usage: usageOf(summary),
  };
}