/**
 * CodeConClave — user API key routes.
 *
 *   GET    /          list the caller's API keys (masked views)
 *   POST   /          create a key (raw secret returned exactly once)
 *   POST   /:id/revoke  revoke a key
 *   GET    /credits    prepaid API credits (₹50,000 blocks) + recent ledger
 *
 * Authenticated by session only (keys are used on external client routes).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { createUserApiKey, listUserApiKeys, revokeUserApiKey, apiAccessStatus } from './service.js';
import { cache } from '../../shared/cache.js';
import { env } from '../../config/env.js';
import { dailyCounterKey } from '../../middleware/api-key-auth.js';
import { creditState, recentCreditEntries } from './credits.js';

export const apiKeyRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const keys = await listUserApiKeys(req.ctx.user!.id);
      res.json(jsonResult({ keys }));
    }),
  );

  // GET /access — API Access entitlement status (server-authoritative gate on key creation).
  // Live API usage for the top-bar meter: today's real request count per key,
  // read from the same counters the API gate enforces (UTC day).
  router.get(
    '/usage',
    asyncRoute(async (req, res) => {
      const keys = (await listUserApiKeys(req.ctx.user!.id)).filter((k) => !k.revokedAt);
      const perKey = await Promise.all(
        keys.map(async (k) => ({ id: k.id, name: k.name, keyPrefix: k.keyPrefix, today: Number(await cache.get(dailyCounterKey(k.id))) || 0 })),
      );
      res.json(
        jsonResult({
          today: perKey.reduce((n, k) => n + k.today, 0),
          dailyLimitPerKey: Number(env.API_MAX_DAILY_REQUESTS),
          windowLimit: Number(env.API_RATE_LIMIT_REQUESTS),
          windowSeconds: Number(env.API_RATE_LIMIT_WINDOW_SECONDS),
          keys: perKey,
        }),
      );
    }),
  );

  // Prepaid API credits: balance, what was granted/spent, and recent entries.
  router.get(
    '/credits',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      res.json(jsonResult({ credits: await creditState(userId), entries: await recentCreditEntries(userId, 20) }));
    }),
  );

  router.get(
    '/access',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ access: await apiAccessStatus(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      if (!name.trim()) throw AppError.badRequest('api_key_name_required', 'An API key name is required.');
      const ttlDays = req.body?.ttlDays == null ? null : Number(req.body.ttlDays);
      const key = await createUserApiKey(req.ctx.user!.id, name, ttlDays);
      res.json(jsonResult({ key }));
    }),
  );

  router.post(
    '/:id/revoke',
    asyncRoute(async (req, res) => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      const key = await revokeUserApiKey(req.ctx.user!.id, String(req.params.id ?? ''), reason);
      res.json(jsonResult({ key }));
    }),
  );

  return router;
};