/**
 * CodeConClave — digests routes.
 * Read-only user surface: current digest plan (frequency/timezone/DND/quiet
 * hours as persisted server-side) and the latest delivered digest. Generation
 * is scheduled server-side (sweepDigests) — never client-triggered state.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { digestPlanFor, latestDigest, toDigestJson } from './service.js';

export const digestRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/status',
    asyncRoute(async (req, res) => {
      const plan = await digestPlanFor(req.ctx.user!.id);
      const latest = await latestDigest(req.ctx.user!.id);
      res.json(
        jsonResult({
          frequency: plan.frequency,
          timezone: plan.timezone,
          dnd: plan.dnd,
          quietHours: plan.quietHours,
          lastDelivery: latest ? toDigestJson(latest) : null,
        }),
      );
    }),
  );

  router.get(
    '/latest',
    asyncRoute(async (req, res) => {
      const latest = await latestDigest(req.ctx.user!.id);
      res.json(jsonResult({ digest: latest ? toDigestJson(latest) : null }));
    }),
  );

  return router;
};