/**
 * CodeConClave — Data Centre routes (Phase 8).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { getDataCentre } from './service.js';

export const dataCentreRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await getDataCentre(req.ctx.user!.id)));
    }),
  );

  return router;
};