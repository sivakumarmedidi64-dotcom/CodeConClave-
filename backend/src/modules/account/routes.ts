/**
 * CodeConClave — account data rights (/api/v1/account).
 * Mounted behind requireAuth only, NOT the paid gate: export and deletion
 * stay available after a subscription lapses.
 */
import { Router } from 'express';
import { z } from 'zod';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { AppError } from '../../shared/errors.js';
import { cancelDeletion, deletionStatus, exportAccount, requestDeletion } from './service.js';

const deletionBody = z.object({ confirmEmail: z.string().min(3).max(320) });

export const accountRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/export',
    rateLimit({ name: 'account_export', limit: 5, windowMs: 60 * 60 * 1000 }),
    asyncRoute(async (req, res) => {
      const data = await exportAccount(req.ctx!.user!.id);
      const day = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="codeconclave-export-${day}.json"`);
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    }),
  );

  router.get(
    '/deletion',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ request: await deletionStatus(req.ctx!.user!.id) }));
    }),
  );

  router.post(
    '/deletion',
    asyncRoute(async (req, res) => {
      const body = deletionBody.safeParse(req.body);
      if (!body.success) throw AppError.badRequest('invalid_body', 'confirmEmail is required');
      res.status(201).json(jsonResult({ request: await requestDeletion(req.ctx!.user!.id, body.data.confirmEmail) }));
    }),
  );

  router.delete(
    '/deletion',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ request: await cancelDeletion(req.ctx!.user!.id) }));
    }),
  );

  return router;
};
