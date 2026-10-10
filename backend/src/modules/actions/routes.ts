/**
 * CodeConClave — P2 unified action runtime routes.
 *   GET  /api/v1/actions/surfaces   honest surface availability catalogue
 *   POST /api/v1/actions            route one action to the correct surface
 *   POST /api/v1/actions/plan       ground an objective into a validated plan
 *   POST /api/v1/actions/stop-all   cancel active local assignments (+ project tasks)
 *
 * Gated by UNIFIED_ACTION_RUNTIME_ENABLED; a disabled runtime refuses before
 * doing any work so it can never be a hidden bypass around the task fabric.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { listActionSurfaces, routeAction, stopAllWork } from './service.js';
import { planObjective } from './planner.js';
import { unifiedActionRuntimeEnabled } from './contract.js';

export const actionRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/surfaces',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ enabled: unifiedActionRuntimeEnabled(), surfaces: listActionSurfaces() }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.projectId !== 'string' || typeof body.title !== 'string') {
        throw AppError.badRequest('invalid_input', 'projectId and title are required');
      }
      const result = await routeAction({
        userId: req.ctx.user!.id,
        projectId: body.projectId,
        title: body.title,
        description: typeof body.description === 'string' ? body.description : null,
        conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
        surface: typeof body.surface === 'string' ? body.surface : undefined,
        riskLevel: body.riskLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined,
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        dependsOn: Array.isArray(body.dependsOn) ? (body.dependsOn as string[]) : undefined,
        localInstruction: body.localInstruction,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
      });
      res.status(201).json(jsonResult({ surface: result.surface, executionMode: result.executionMode, task: result.task, session: result.session }));
    }),
  );

  router.post(
    '/plan',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const plan = planObjective({
        projectId: typeof body.projectId === 'string' ? body.projectId : '',
        objective: typeof body.objective === 'string' ? body.objective : '',
        steps: Array.isArray(body.steps) ? (body.steps as never[]) : [],
      });
      res.json(jsonResult({ plan }));
    }),
  );

  router.post(
    '/stop-all',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await stopAllWork({
        userId: req.ctx.user!.id,
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      res.json(jsonResult({ stopped: result }));
    }),
  );

  return router;
};
