/**
 * CodeConClave — operations routes (Phase 14 + 15).
 * Provider capability status for the signed-in user (Phase 14) and operator
 * diagnostics (Phase 15). Honest by construction: statuses derive from env
 * configuration + persisted health; no secret values are ever included.
 * Diagnostics are restricted to owner/admin operators only.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { providerStatus } from './service.js';
import { diagnosticsReport } from './diagnostics.js';

export const operationRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/providers',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await providerStatus(req.ctx.user!.id)));
    }),
  );

  router.get(
    '/diagnostics',
    asyncRoute(async (req, res) => {
      const role = req.ctx.user!.rbacRole;
      if (role !== 'owner' && role !== 'admin') {
        throw AppError.forbidden('diagnostics_forbidden', 'Diagnostics are available to workspace operators only');
      }
      res.json(jsonResult(await diagnosticsReport()));
    }),
  );

  return router;
};