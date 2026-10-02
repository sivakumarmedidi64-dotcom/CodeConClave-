/**
 * CodeConClave — access status for the app entry gate.
 * Ungated workspace endpoint: an authenticated user always gets their access
 * state so the client can render the correct surface (Billing vs workspace).
 * Never returns account secrets — only plan/entitlement status.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { workspaceAccess } from '../../middleware/entitlement.js';

export const accessRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const user = req.ctx!.user!;
      const access = await workspaceAccess(user.id);
      res.json(
        jsonResult({
          access,
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName ?? null,
            rbacRole: user.rbacRole,
          },
        }),
      );
    }),
  );

  return router;
};