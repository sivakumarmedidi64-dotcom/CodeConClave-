/**
 * CodeConClave — personal usage (/api/v1/usage). Real numbers from
 * model_usage_logs for the signed-in user only: tokens in/out, requests and
 * estimated cost, totals plus by-day and by-model breakdowns. The model
 * column names what actually answered (resident hub id or provider model).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { withTenant } from '../../shared/db.js';
import { planLimits } from './limits.js';

interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  days: number;
  totals: Totals;
  today: Totals;
  byDay: (Totals & { day: string })[];
  byModel: (Totals & { providerId: string; modelId: string })[];
}

const num = (v: unknown): number => Number(v ?? 0) || 0;

export async function usageSummary(userId: string, days: number): Promise<UsageSummary> {
  return withTenant(userId, async (q) => {
    const since = `now() - make_interval(days => $2)`;
    const totalsRow = (
      await q.query(
        `SELECT count(*) AS requests, coalesce(sum(input_tokens),0) AS input, coalesce(sum(output_tokens),0) AS output,
                coalesce(sum(estimated_cost_usd),0) AS cost
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= ${since}`,
        [userId, days],
      )
    ).rows[0] as Record<string, unknown>;
    const todayRow = (
      await q.query(
        `SELECT count(*) AS requests, coalesce(sum(input_tokens),0) AS input, coalesce(sum(output_tokens),0) AS output,
                coalesce(sum(estimated_cost_usd),0) AS cost
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
        [userId],
      )
    ).rows[0] as Record<string, unknown>;
    const byDay = (
      await q.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS requests,
                sum(input_tokens) AS input, sum(output_tokens) AS output, sum(estimated_cost_usd) AS cost
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= ${since}
          GROUP BY 1 ORDER BY 1`,
        [userId, days],
      )
    ).rows as Record<string, unknown>[];
    const byModel = (
      await q.query(
        `SELECT provider_id, model_id, count(*) AS requests, sum(input_tokens) AS input, sum(output_tokens) AS output,
                sum(estimated_cost_usd) AS cost
           FROM model_usage_logs WHERE user_id = $1 AND created_at >= ${since}
          GROUP BY 1, 2 ORDER BY sum(input_tokens) + sum(output_tokens) DESC LIMIT 20`,
        [userId, days],
      )
    ).rows as Record<string, unknown>[];
    const totals = (r: Record<string, unknown>): Totals => ({
      requests: num(r.requests),
      inputTokens: num(r.input),
      outputTokens: num(r.output),
      costUsd: Math.round(num(r.cost) * 10000) / 10000,
    });
    return {
      days,
      totals: totals(totalsRow),
      today: totals(todayRow),
      byDay: byDay.map((r) => ({ day: String(r.day), ...totals(r) })),
      byModel: byModel.map((r) => ({ providerId: String(r.provider_id), modelId: String(r.model_id), ...totals(r) })),
    };
  });
}

export const usageRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  router.get(
    '/summary',
    asyncRoute(async (req, res) => {
      const raw = Number(req.query.days ?? 30);
      const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.round(raw))) : 30;
      const user = req.ctx!.user!;
      const usage = await usageSummary(user.id, days);
      res.json(jsonResult({ usage }));
    }),
  );
  // Claude-style plan limits for live meters (Usage page, composer chip):
  // session (from first message) + this week (Monday reset) + by product,
  // stamped with when it was read.
  router.get(
    '/limits',
    asyncRoute(async (req, res) => {
      const user = req.ctx!.user!;
      const limits = await planLimits(user.id, user.planId);
      res.json(jsonResult({ limits, checkedAt: new Date().toISOString() }));
    }),
  );
  return router;
};
