/**
 * CodeConClave — PKG-25 — autonomy routes.
 *
 *   GET  /status  read-only 24/7 truth report (available regardless of gate)
 *   POST /proof   run the deterministic/proof harness (feature-gated)
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { autonomyStatus, runProof } from './service.js';
import { autonomyEnabled } from './config.js';
import { listProjectAutonomyStatus } from './provision.js';

export const autonomyRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get('/status', asyncRoute(async (req, res) => {
    const status = await autonomyStatus(req.ctx.user!.id);
    res.json(jsonResult({ status }));
  }));

  router.get('/project/:projectId/status', asyncRoute(async (req, res) => {
    const status = await listProjectAutonomyStatus(req.ctx.user!.id, req.params.projectId!);
    res.json(jsonResult(status));
  }));

  router.post('/proof', asyncRoute(async (req, res) => {
    if (!autonomyEnabled()) {
      throw AppError.unavailable('feature_disabled', 'Autonomy proof is feature-gated OFF (AIOS_P2_AUTONOMY).');
    }
    const mode = req.body?.mode === 'real' ? ('real' as const) : ('logic' as const);
    const result = await runProof(mode, req.ctx.user!.id);
    res.json(jsonResult(result));
  }));

  return router;
};
