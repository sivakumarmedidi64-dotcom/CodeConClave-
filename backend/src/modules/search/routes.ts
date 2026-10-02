/**
 * CodeConClave — global search routes (Phase 8).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { globalSearch } from './service.js';

export const searchRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const { q, type, projectId, dateFrom, dateTo, ownerId, tag, teamId, memberId, limit } = req.query;
      const result = await globalSearch(req.ctx.user!.id, {
        q: q ? String(q) : undefined,
        type: type ? String(type) : undefined,
        projectId: projectId ? String(projectId) : undefined,
        dateFrom: dateFrom ? String(dateFrom) : undefined,
        dateTo: dateTo ? String(dateTo) : undefined,
        ownerId: ownerId ? String(ownerId) : undefined,
        tag: tag ? String(tag) : undefined,
        teamId: teamId ? String(teamId) : undefined,
        memberId: memberId ? String(memberId) : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      });
      res.json(jsonResult(result));
    }),
  );

  return router;
};