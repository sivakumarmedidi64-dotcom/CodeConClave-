/**
 * CodeConClave — history routes (Phase 13).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { getHistoryEvent, listHistory, setHistoryStar } from './service.js';

export const historyRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const q = req.query.q ? String(req.query.q) : undefined;
      const source = req.query.source ? String(req.query.source) : undefined;
      const action = req.query.action ? String(req.query.action) : undefined;
      const resourceType = req.query.resourceType ? String(req.query.resourceType) : undefined;
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const actorId = req.query.actorId ? String(req.query.actorId) : undefined;
      const teamId = req.query.teamId ? String(req.query.teamId) : undefined;
      const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
      const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
      const starred = req.query.starred === '1' || req.query.starred === 'true';
      const sort = req.query.sort === 'asc' ? 'asc' : 'desc';
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const result = await listHistory(req.ctx.user!.id, {
        q,
        source,
        action,
        resourceType,
        projectId,
        actorId,
        teamId,
        dateFrom,
        dateTo,
        starred,
        sort,
        limit,
        offset,
      });
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/:source/:eventId',
    asyncRoute(async (req, res) => {
      const event = await getHistoryEvent(req.ctx.user!.id, String(req.params.source), String(req.params.eventId));
      res.json(jsonResult({ event }));
    }),
  );

  router.post(
    '/:source/:eventId/star',
    asyncRoute(async (req, res) => {
      const result = await setHistoryStar(req.ctx.user!.id, String(req.params.source), String(req.params.eventId), true);
      res.json(jsonResult(result));
    }),
  );

  router.delete(
    '/:source/:eventId/star',
    asyncRoute(async (req, res) => {
      const result = await setHistoryStar(req.ctx.user!.id, String(req.params.source), String(req.params.eventId), false);
      res.json(jsonResult(result));
    }),
  );

  return router;
};