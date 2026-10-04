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
          // TEMPORARY DEMO / EARLY ACCESS MODE: an explicit, honest mode block so
          // a client never has to infer demo access from a plan field. These three
          // booleans are independent on purpose —
          //   paymentRequired=false + paidEntitlement=false => open ONLY because
          //   TEMPORARY_DEMO_MODE is on, and no payment was taken or recorded.
          // No payment/entitlement row is created or read to produce this block.
          mode: {
            temporaryDemoMode: access.demoMode,
            paymentRequired: access.paymentRequired,
            paidEntitlement: access.paidEntitlement,
            // TEMPORARY: while demo mode is on the purchase rail is not offered.
            // Set to false again to re-enable the commercial flow untouched.
            purchaseEnabled: !access.demoMode,
            // Unchanged commercial model — demo mode is not a new plan.
            commercialPlans: { solo: 999, team: 4999, apiAccess: 9999 },
          },
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