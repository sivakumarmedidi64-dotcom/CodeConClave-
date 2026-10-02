/**
 * CodeConClave — activity feed routes (Phase 13).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { getActivityFeed } from './service.js';

export const activityRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const scope = req.query.scope ? String(req.query.scope) : 'home';
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const teamId = req.query.teamId ? String(req.query.teamId) : undefined;
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const result = await getActivityFeed(req.ctx.user!.id, { scope: scope as 'home' | 'project' | 'team', projectId, teamId, limit });
      res.json(jsonResult(result));
    }),
  );

  return router;
};