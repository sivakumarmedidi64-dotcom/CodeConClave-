/**
 * CodeConClave — AI routes: model catalogue (dropdown data), usage summary.
 * The server is authoritative for what the client may select.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { getRegistry, configuredProviders } from './registry.js';
import { premiumBudgetRemaining } from './gateway.js';
import { providerStatusSnapshot } from './status.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { pool } from '../../shared/db.js';
import { env } from '../../config/env.js';
import { getUserById } from '../auth/service.js';

export const aiRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/models',
    asyncRoute(async (req, res) => {
      const user = await getUserById(req.ctx.user!.id);
      const registry = await getRegistry();
      const configured = new Set(configuredProviders());
      const budgetRemaining = user.planId === 'pro' ? await premiumBudgetRemaining(user.id) : null;
      // Server-authoritative availability: a model is selectable ONLY when its
      // provider is configured, the provider is not DOWN, and (for premium
      // models) the daily budget is not exhausted. The client may not override.
      const models = registry.map((m) => ({
        id: m.modelId,
        providerId: m.providerId,
        label: m.displayName,
        description: null,
        tier: m.tier,
        computeClass: m.computeClass,
        health: m.health,
        locked: m.entitlement === 'PRO' && user.planId !== 'pro',
        available:
          configured.has(m.providerId) &&
          m.health !== 'DOWN' &&
          (m.computeClass !== 'C' || user.planId !== 'pro' || budgetRemaining === null || budgetRemaining > 0),
        overBudget: m.computeClass === 'C' && user.planId === 'pro' && budgetRemaining !== null && budgetRemaining <= 0,
      }));
      res.json(jsonResult({ models, defaultModel: env.AI_DEFAULT_MODEL ?? null, configuredProviders: configuredProviders() }));
    }),
  );

  router.get(
    '/usage',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const user = await getUserById(userId);
      const today = new Date().toISOString().slice(0, 10);
      const result = await pool.query(
        `SELECT
           COALESCE(SUM(input_tokens),0) AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(estimated_cost_usd),0) AS cost_usd,
           count(*)::int AS calls
         FROM model_usage_logs WHERE user_id = $1 AND created_at >= $2::date`,
        [userId, today],
      );
      const row = result.rows[0] ?? {};
      const [byProvider, byModel, recent] = await Promise.all([
        pool.query(
          `SELECT provider_id, count(*)::int AS calls, COALESCE(SUM(estimated_cost_usd),0) AS cost_usd
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= $2::date
           GROUP BY provider_id ORDER BY cost_usd DESC`,
          [userId, today],
        ),
        pool.query(
          `SELECT provider_id, model_id,
                  count(*)::int AS calls,
                  COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(estimated_cost_usd),0) AS cost_usd,
                  bool_or(used_fallback) AS used_fallback
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= $2::date
           GROUP BY provider_id, model_id ORDER BY cost_usd DESC`,
          [userId, today],
        ),
        pool.query(
          `SELECT provider_id, model_id, used_fallback, fallback_reason, estimated_cost_usd, duration_ms, created_at
           FROM model_usage_logs WHERE user_id = $1
           ORDER BY created_at DESC LIMIT 10`,
          [userId],
        ),
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
          providers,
          // Server-authoritative truth: LIVE only when a provider is configured
          // AND passing probes. Everything else is honest status text — the UI
          // renders it, it never claims availability.
          live: providers.filter((p) => p.status === 'AVAILABLE').map((p) => p.providerId),
          generatedAt: new Date().toISOString(),
        }),
      );
    }),
  );

  return router;
};