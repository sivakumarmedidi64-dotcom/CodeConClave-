/**
 * CodeConClave — workspace routes.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import {
  returnToWorkConfigSchema,
  workspaceReconcileSchema,
  workspaceRestoreSchema,
  workspaceUpdateSchema,
  preferencesUpdateSchema,
} from '@codeconclave/shared';
import {
  checkFreeLimits,
  contextIndicator,
  getFeatureFlags,
  getPreferences,
  getUsageOverview,
  getWorkspaceStateDetailed,
  listWorkspaceState,
  reconcileWorkspaceState,
  restoreWorkspaceState,
  setWorkspaceState,
  updatePreferences,
} from './service.js';
import {
  dismissReturnToWork,
  getReturnToWork,
  getReturnToWorkConfig,
  markReturnToWorkRead,
  updateReturnToWorkConfig,
} from '../returnToWork/service.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';

export const workspaceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/state',
    asyncRoute(async (req, res) => res.json(jsonResult({ state: await listWorkspaceState(req.ctx.user!.id) }))),
  );

  router.put(
    '/state/:key',
    asyncRoute(async (req, res) => {
      const key = String(req.params.key ?? '').slice(0, 80);
      const input = workspaceUpdateSchema.parse(req.body);
      const entry = await setWorkspaceState(req.ctx.user!.id, key, input.value, input.baseVersion);
      res.json(jsonResult({ entry }));
    }),
  );

  router.get(
    '/state/:key',
    asyncRoute(async (req, res) => {
      const value = await getWorkspaceStateDetailed(req.ctx.user!.id, String(req.params.key));
      res.json(jsonResult({ value }));
    }),
  );

  /**
   * Multi-device reconciliation: never fails on a version mismatch; the
   * server state is preserved and the client's version merged deterministically.
   */
  router.post(
    '/state/reconcile',
    asyncRoute(async (req, res) => {
      const input = workspaceReconcileSchema.parse(req.body);
      const result = await reconcileWorkspaceState(req.ctx.user!.id, input.key, input.value, input.baseVersion);
      res.json(jsonResult(result));
    }),
  );

  /** Bulk restore of a workspace snapshot (device return / workspace switch). */
  router.post(
    '/state/restore',
    asyncRoute(async (req, res) => {
      const input = workspaceRestoreSchema.parse(req.body);
      const result = await restoreWorkspaceState(req.ctx.user!.id, input.entries);
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/preferences',
    asyncRoute(async (req, res) => res.json(jsonResult({ prefs: await getPreferences(req.ctx.user!.id) }))),
  );

  router.put(
    '/preferences',
    asyncRoute(async (req, res) => {
      const input = preferencesUpdateSchema.parse(req.body);
      const merged = await updatePreferences(req.ctx.user!.id, input.prefs);
      res.json(jsonResult({ prefs: merged }));
    }),
  );

  router.get(
    '/usage',
    asyncRoute(async (req, res) => res.json(jsonResult(await checkFreeLimits(req.ctx.user!.id, 'message')))),
  );

  router.get(
    '/usage/overview',
    asyncRoute(async (req, res) => res.json(jsonResult({ overview: await getUsageOverview(req.ctx.user!.id) }))),
  );

  router.get(
    '/flags',
    asyncRoute(async (req, res) => res.json(jsonResult({ flags: await getFeatureFlags() }))),
  );

  router.get(
    '/context',
    asyncRoute(async (req, res) => res.json(jsonResult(await contextIndicator(req.ctx.user!.id)))),
  );

  router.get(
    '/return-to-work',
    asyncRoute(async (req, res) => res.json(jsonResult(await getReturnToWork(req.ctx.user!.id)))),
  );

  router.get(
    '/return-to-work/config',
    asyncRoute(async (req, res) => res.json(jsonResult({ config: await getReturnToWorkConfig(req.ctx.user!.id) }))),
  );

  router.put(
    '/return-to-work/config',
    asyncRoute(async (req, res) => {
      const input = returnToWorkConfigSchema.parse(req.body);
      if (Object.keys(input).length === 0) {
        res.json(jsonResult({ config: await getReturnToWorkConfig(req.ctx.user!.id) }));
        return;
      }
      res.json(jsonResult({ config: await updateReturnToWorkConfig(req.ctx.user!.id, input) }));
    }),
  );

  router.post(
    '/return-to-work/:id/read',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ summary: await markReturnToWorkRead(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/return-to-work/:id/dismiss',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ summary: await dismissReturnToWork(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  return router;
};