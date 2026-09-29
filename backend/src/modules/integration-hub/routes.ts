/**
 * CodeConClave — PKG-26 — Universal Integration Hub routes (read-only).
 *   GET /api/v1/integrations/hub       consolidated provider catalog + status
 *   GET /api/v1/integrations/deployment deployment-provider capability matrix
 *   GET /api/v1/integrations/hub/:type single provider detail
 *
 * All endpoints are authenticated + owner-scoped and NEVER return secrets.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { buildIntegrationHub, deploymentProviderCapabilities, hubProvider } from './service.js';
import { listConnections } from '../plugins/health.js';

export const integrationHubRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/hub',
    asyncRoute(async (req, res) => {
      const hub = await buildIntegrationHub(req.ctx.user!.id);
      const deployment = await deploymentProviderCapabilities();
      res.json(
        jsonResult({
          providers: hub.providers,
          deploymentProviders: deployment,
          webhookSources: hub.webhookSources,
          observability: hub.observability,
          live: hub.live,
        }),
      );
    }),
  );

  router.get(
    '/deployment',
    asyncRoute(async (_req, res) => {
      const deployment = await deploymentProviderCapabilities();
      res.json(jsonResult({ deploymentProviders: deployment }));
    }),
  );

  router.get(
    '/hub/:type',
    asyncRoute(async (req, res) => {
      const type = req.params.type!;
      const connections = await listConnections(req.ctx.user!.id);
      const connection = connections.find((c) => c.plugin_type === type);
      if (!type) throw AppError.badRequest('provider_type_required', 'provider type is required');
      const provider = await hubProvider(req.ctx.user!.id, type, connection);
      res.json(jsonResult({ provider }));
    }),
  );

  return router;
};
