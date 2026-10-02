/**
 * CodeConClave — user API key routes.
 *
 *   GET    /          list the caller's API keys (masked views)
 *   POST   /          create a key (raw secret returned exactly once)
 *   POST   /:id/revoke  revoke a key
 *
 * Authenticated by session only (keys are used on external client routes).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { createUserApiKey, listUserApiKeys, revokeUserApiKey, apiAccessStatus } from './service.js';

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