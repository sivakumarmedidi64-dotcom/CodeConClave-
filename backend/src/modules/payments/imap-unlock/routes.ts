/**
 * CodeConClave — IMAP auto-unlock routes (founder/admin only).
 *
 * Read-only observability plus an on-demand sweep trigger. Access uses the
 * SAME gate as the private Payment Control Center (founder email or
 * admin/owner role). No endpoint can grant, force, or bypass activation —
 * the sweep only feeds the existing trusted evidence pipeline.
 */
import { Router } from 'express';
import { asyncRoute } from '../../../middleware/security.js';
import { requireAuth } from '../../../middleware/auth.js';
import { jsonResult } from '../../auth/schemas.js';
import { assertControlCenterAccess } from '../control-center.js';
import { imapUnlockStatus, pollMailbox } from './service.js';

export const imapUnlockRoutes = (): Router => {
  const router = Router();

  router.use(requireAuth);
  router.use(async (req, res, next) => {
    try {
      await assertControlCenterAccess(req.ctx?.user ?? null);
      next();
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/payments/imap-unlock/status — rail capability + last config.
  router.get(
    '/status',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ status: imapUnlockStatus() }));
    }),
  );

  // POST /api/v1/payments/imap-unlock/poll — trigger one mailbox sweep now.
  router.post(
    '/poll',
    asyncRoute(async (_req, res) => {
      const report = await pollMailbox();
      res.json(jsonResult({ report }));
    }),
  );

  return router;
};
