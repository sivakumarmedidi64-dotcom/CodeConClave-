/**
 * CodeConClave — audit routes (read-only for users; writes are server-side).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { listAudit } from './service.js';

export const auditRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const rows = await listAudit({
        userId,
        action: req.query.action ? String(req.query.action) : undefined,
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      });
      res.json(jsonResult({ events: rows }));
    }),
  );

  return router;
};