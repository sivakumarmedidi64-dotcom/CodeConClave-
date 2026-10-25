/**
 * Agent Sai Srinivasa Athreya — API.
 *   GET /api/v1/sai/sources            the full 140-source catalog + which are live
 *   GET /api/v1/sai/fetch/:id?q=…       pull real data from one live source (honest errors)
 */
import { Router } from 'express';
import type { Request } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { SAI_AGENT_NAME, SAI_SOURCES, sourcesByCategory } from './sources.js';
import { liveSourceIds, runConnector } from './connectors.js';

export const saiRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/sources',
    asyncRoute(async (_req, res) => {
      const live = new Set(liveSourceIds());
      const byCat = sourcesByCategory();
      res.json(
        jsonResult({
          agent: SAI_AGENT_NAME,
          total: SAI_SOURCES.length,
          liveCount: live.size,
          categories: Object.keys(byCat).length,
          sources: SAI_SOURCES.map((s) => ({ ...s, live: live.has(s.id) })),
        }),
      );
    }),
  );

  router.get(
    '/fetch/:id',
    asyncRoute(async (req: Request, res) => {
      const id = String(req.params.id);
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
      try {
        res.json(jsonResult({ evidence: await runConnector(id, query) }));
      } catch (err) {
        // Honest failure — Agent Sai never invents data when a source is down.
        throw AppError.badRequest('sai_fetch_failed', err instanceof Error ? err.message : 'Agent Sai could not fetch this source right now.');
      }
    }),
  );

  return router;
};
