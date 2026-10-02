/**
 * CodeConClave — unified trash routes (Phase 13).
 */
import { Router } from 'express';
import { trashBulkActionSchema, trashItemSchema } from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { listTrash, purgeBulk, purgeExpired, purgeItem, restoreBulk, restoreItem } from './service.js';

export const trashRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const result = await listTrash(req.ctx.user!.id);
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/restore',
    asyncRoute(async (req, res) => {
      const input = trashBulkActionSchema.parse(req.body);
      const restored = await restoreBulk(req.ctx.user!.id, input.items);
      res.json(jsonResult({ restored }));
    }),
  );

  router.post(
    '/restore/:type/:id',
    asyncRoute(async (req, res) => {
      trashItemSchema.parse({ type: String(req.params.type), id: String(req.params.id) });
      await restoreItem(req.ctx.user!.id, String(req.params.type), String(req.params.id));
      res.json(jsonResult({ restored: true }));
    }),
  );

  router.post(
    '/purge',
    asyncRoute(async (req, res) => {
      const input = trashBulkActionSchema.parse(req.body);
      const purged = await purgeBulk(req.ctx.user!.id, input.items);
      res.json(jsonResult({ purged }));
    }),
  );

  router.post(
    '/purge/:type/:id',
    asyncRoute(async (req, res) => {
      trashItemSchema.parse({ type: String(req.params.type), id: String(req.params.id) });
      await purgeItem(req.ctx.user!.id, String(req.params.type), String(req.params.id));
      res.json(jsonResult({ purged: true }));
    }),
  );

  router.post(
    '/purge-expired',
    asyncRoute(async (req, res) => {
      const result = await purgeExpired(req.ctx.user!.id);
      res.json(jsonResult(result));
    }),
  );

  return router;
};