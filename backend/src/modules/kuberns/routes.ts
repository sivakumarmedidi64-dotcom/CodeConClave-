/**
 * CodeConClave — Kuberns adapter boundary routes (read-only + honest refusal).
 *   GET  /api/v1/kuberns/status   adapter state (DISABLED/CONFIGURATION_REQUIRED/CONFIGURED)
 *   POST /api/v1/kuberns/deploy   refuses honestly while not ready / not implemented
 *
 * Never returns a credential value; the adapter state is server-derived.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { assertKubernsReady, kubernsDeploySupported, kubernsStatus } from './adapter.js';

export const kubernsRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/status',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ kuberns: kubernsStatus() }));
    }),
  );

  router.post(
    '/deploy',
    asyncRoute(async (_req, res) => {
      // Honest gate first: a disabled/unconfigured adapter refuses before any
      // attempt, and even a configured boundary cannot deploy in this phase.
      assertKubernsReady();
      if (!kubernsDeploySupported()) {
        throw AppError.unavailable('kuberns_deploy_not_implemented', 'Kuberns deployment is not implemented on this deployment');
      }
      res.json(jsonResult({ deployed: false }));
    }),
  );

  return router;
};
