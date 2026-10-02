/**
 * CodeConClave — Admin Dashboard API Routes.
 * Admin-only endpoints for dashboard statistics and user management.
 */
import { Router } from 'express';
import { asyncRoute } from '../../middleware/security.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireUserRole } from '../auth/rbac.js';
import { jsonResult } from '../auth/schemas.js';
import {
  getAdminStats,
  getAdminUsers,
  getAiUsageStats,
  AdminStats,
  AdminUser,
  AiUsageStats,
} from './service.js';
import {
  listClaimInbox,
  approveClaim,
  rejectClaim,
} from '../payments/claims/service.js';
import {
  getEffectiveUnlockMode,
  setRuntimeUnlockMode,
  autopilotReadiness,
  getRuntimeUnlockMode,
  type UnlockMode,
} from '../payments/autopilot/service.js';

export const adminRoutes = (): import('express').Router => {
  const router = Router();

  // All admin routes require authentication and admin role
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (!['admin', 'owner'].includes(req.ctx?.user?.rbacRole || '')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });

  // GET /api/v1/admin/stats
  router.get(
    '/stats',
    asyncRoute(async (_req, res) => {
      const stats = await getAdminStats();
      res.json(stats);
    }),
  );

  // GET /api/v1/admin/users
  router.get(
    '/users',
    asyncRoute(async (req, res) => {
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
      const search = req.query.search ? String(req.query.search) : undefined;
      const result = await getAdminUsers(page, limit, search);
      res.json({ users: result.users, total: result.total, page: result.page, limit: result.limit });
    }),
  );

  // GET /api/v1/admin/ai-usage
  router.get(
    '/ai-usage',
    asyncRoute(async (req, res) => {
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? '30'), 10)));
      const stats = await getAiUsageStats(days);
      res.json(stats);
    }),
  );

  // ------------------------------------------------------------ MANUAL PAYMENT CLAIMS
  // Founder inbox for UNLOCK_MODE=MANUAL. Approve grants the entitlement via the
  // existing authority (exactly-once, transactional); reject never touches
  // entitlement/intent state.

  // GET /api/v1/admin/payments/claims?status=PENDING&limit=50&offset=0
  router.get(
    '/payments/claims',
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
      const inbox = await listClaimInbox({ status, limit, offset });
      res.json({ claims: inbox.claims, total: inbox.total, limit, offset });
    }),
  );

  // POST /api/v1/admin/payments/claims/:id/approve
  router.post(
    '/payments/claims/:id/approve',
    asyncRoute(async (req, res) => {
      res.json({ claim: await approveClaim(req.ctx.user!.id, req.params.id!) });
    }),
  );

  // POST /api/v1/admin/payments/claims/:id/reject  { reason: string }
  router.post(
    '/payments/claims/:id/reject',
    asyncRoute(async (req, res) => {
      res.json({ claim: await rejectClaim(req.ctx.user!.id, req.params.id!, req.body?.reason) });
    }),
  );

  // ------------------------------------------------------------ PAYMENT AUTOPILOT
  // UNLOCK_MODE=AUTOPILOT runtime control. Read shows the effective mode
  // (runtime override else env default) + the fail-closed readiness checks;
  // write flips the mode (enable AUTOPILOT requires readiness; MANUAL is the
  // kill switch). All admin routes above share the admin/owner RBAC gate.

  // GET /api/v1/admin/payments/autopilot
  router.get(
    '/payments/autopilot',
    asyncRoute(async (_req, res) => {
      const [effective, runtime, readiness] = await Promise.all([
        getEffectiveUnlockMode(),
        getRuntimeUnlockMode(),
        autopilotReadiness(),
      ]);
      res.json({ mode: effective, runtimeMode: runtime, readiness });
    }),
  );

  // POST /api/v1/admin/payments/autopilot  { mode: 'MANUAL' | 'AUTOPILOT' }
  router.post(
    '/payments/autopilot',
    asyncRoute(async (req, res) => {
      const raw = String(req.body?.mode ?? '').toUpperCase();
      const mode: UnlockMode = raw === 'AUTOPILOT' ? 'AUTOPILOT' : 'MANUAL';
      const effective = await setRuntimeUnlockMode(mode, req.ctx.user!.id);
      const readiness = await autopilotReadiness();
      res.json({ mode: effective, readiness });
    }),
  );

  return router;
};