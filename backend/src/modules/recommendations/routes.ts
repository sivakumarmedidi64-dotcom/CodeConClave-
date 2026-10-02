/**
 * CodeConClave — cleanup recommendations routes (Phase 13).
 */
import { Router } from 'express';
import { cleanupResolveSchema } from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import {
  generateCleanupRecommendations,
  listCleanupRecommendations,
  resolveCleanupRecommendation,
} from './service.js';

export const recommendationsRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      const recommendations = await listCleanupRecommendations(req.ctx.user!.id, status);
      res.json(jsonResult({ recommendations }));
    }),
  );

  router.post(
    '/generate',
    asyncRoute(async (req, res) => {
      const count = await generateCleanupRecommendations(req.ctx.user!.id);
      const recommendations = await listCleanupRecommendations(req.ctx.user!.id, 'ACTIVE');
      res.json(jsonResult({ recommendations, generated: count }));
    }),
  );

  router.post(
    '/:recommendationId/resolve',
    asyncRoute(async (req, res) => {
      const { status } = cleanupResolveSchema.parse(req.body);
      const recommendation = await resolveCleanupRecommendation(
        req.ctx.user!.id,
        String(req.params.recommendationId),
        status,
      );
      res.json(jsonResult({ recommendation }));
    }),
  );

  return router;
};