/**
 * CodeConClave — Stage 26G control-plane routes (/api/v1/control).
 * Risk policies, kill switch, undo, secret guard, usage/cost/ROI analytics and
 * the change heatmap. All tenant-scoped to the authenticated user.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { listControlPolicies, upsertControlPolicy, deleteControlPolicy } from './policies.js';
import { killSwitchStatus, setKillSwitch } from './killSwitch.js';
import { listUndoable, undoAction, recordUndoable, UNDOABLE_KINDS } from './undo.js';
import { listSecretGuardScans, scanContent, SECRET_GUARD_TARGETS } from '../secretGuard/service.js';
import {
  costPerFeature,
  costPerTask,
  roiEstimate,
  transparencyLog,
  changeHeatmap,
  refreshUsageRollups,
  listUsageRollups,
} from '../usage/analytics.js';
import { runPluginSandbox, listPluginSandboxRuns } from '../plugins/sandbox.js';
import { getProofOfWork, generateProofOfWork } from '../proofOfWork.js';

const daysParam = (raw: unknown, def = 30): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 90) : def;
};

export const controlRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/policies',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ policies: await listControlPolicies(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/policies',
    asyncRoute(async (req, res) => {
      const { scope, action, riskLevel, requirement, enabled } = req.body ?? {};
      if (!scope || !action || !riskLevel) {
        throw AppError.badRequest('invalid_policy_input', 'scope, action and riskLevel are required');
      }
      const policy = await upsertControlPolicy(req.ctx.user!.id, {
        scope: String(scope),
        action: String(action),
        riskLevel: String(riskLevel),
        requirement: requirement ? String(requirement) : undefined,
        enabled: enabled === undefined ? undefined : Boolean(enabled),
      });
      res.json(jsonResult({ policy }));
    }),
  );

  router.delete(
    '/policies/:policyId',
    asyncRoute(async (req, res) => {
      await deleteControlPolicy(req.ctx.user!.id, req.params.policyId!);
      res.json(jsonResult({ deleted: true }));
    }),
  );

  router.get(
    '/kill-switch',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ scopes: await killSwitchStatus(req.ctx.user!.id) }));
    }),
  );

  router.put(
    '/kill-switch',
    asyncRoute(async (req, res) => {
      const { scope, active, reason } = req.body ?? {};
      if (!scope || typeof active !== 'boolean') {
        throw AppError.badRequest('invalid_kill_switch_input', 'scope and active are required');
      }
      const row = await setKillSwitch(req.ctx.user!.id, String(scope), active, reason ? String(reason) : undefined);
      res.json(jsonResult({ killSwitch: row }));
    }),
  );

  router.get(
    '/undo',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ entries: await listUndoable(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/undo',
    asyncRoute(async (req, res) => {
      const { actionType, description, payload } = req.body ?? {};
      if (!actionType || !description || !UNDOABLE_KINDS.includes(String(actionType) as (typeof UNDOABLE_KINDS)[number])) {
        throw AppError.badRequest('invalid_undo_input', 'actionType (reversible kind) and description are required');
      }
      res.json(
        jsonResult({
          entry: await recordUndoable(req.ctx.user!.id, {
            actionType: String(actionType) as (typeof UNDOABLE_KINDS)[number],
            description: String(description),
            payload: (payload as Record<string, unknown>) ?? {},
          }),
        }),
      );
    }),
  );

  router.post(
    '/undo/:undoId',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ entry: await undoAction(req.ctx.user!.id, req.params.undoId!) }));
    }),
  );

  router.get(
    '/secret-guard/scans',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ scans: await listSecretGuardScans(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/secret-guard/scan',
    asyncRoute(async (req, res) => {
      const { targetType, targetRef, content } = req.body ?? {};
      if (!targetType || typeof content !== 'string') {
        throw AppError.badRequest('invalid_scan_input', 'targetType and content are required');
      }
      if (!SECRET_GUARD_TARGETS.includes(String(targetType))) {
        throw AppError.badRequest('invalid_scan_target', `Unknown scan target ${targetType}`);
      }
      const scan = await scanContent(req.ctx.user!.id, {
        targetType: String(targetType),
        targetRef: targetRef ? String(targetRef) : undefined,
        content,
      });
      res.json(jsonResult({ scan }));
    }),
  );

  router.get(
    '/usage/cost-per-feature',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ features: await costPerFeature(req.ctx.user!.id, daysParam(req.query.days, 30)) }));
    }),
  );

  router.get(
    '/usage/cost-per-task/:taskId',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ cost: await costPerTask(req.ctx.user!.id, req.params.taskId!) }));
    }),
  );

  router.get(
    '/usage/roi',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await roiEstimate(req.ctx.user!.id, daysParam(req.query.days, 30))));
    }),
  );

  router.get(
    '/usage/transparency',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ calls: await transparencyLog(req.ctx.user!.id, daysParam(req.query.days, 7)) }));
    }),
  );

  router.post(
    '/usage/rollup',
    asyncRoute(async (req, res) => {
      const days = daysParam((req.body ?? {}).days, 7);
      const features = await refreshUsageRollups(req.ctx.user!.id, days);
      res.json(jsonResult({ rolledUp: features, rollups: await listUsageRollups(req.ctx.user!.id, days) }));
    }),
  );

  router.get(
    '/usage/rollups',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ rollups: await listUsageRollups(req.ctx.user!.id, daysParam(req.query.days, 7)) }));
    }),
  );

  router.get(
    '/pow/:taskId',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ proof: await getProofOfWork(req.ctx.user!.id, req.params.taskId!) }));
    }),
  );

  router.post(
    '/pow',
    asyncRoute(async (req, res) => {
      const { taskId } = req.body ?? {};
      if (!taskId || typeof taskId !== 'string') {
        throw AppError.badRequest('invalid_pow_input', 'taskId is required');
      }
      res.json(jsonResult({ proof: await generateProofOfWork(req.ctx.user!.id, taskId) }));
    }),
  );

  router.get(
    '/activity/heatmap/:projectId',
    asyncRoute(async (req, res) => {
      res.json(
        jsonResult({
          heatmap: await changeHeatmap(req.ctx.user!.id, req.params.projectId!, daysParam(req.query.days, 14)),
        }),
      );
    }),
  );

  router.get(
    '/plugins/sandbox/runs',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ runs: await listPluginSandboxRuns(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/plugins/sandbox/run',
    asyncRoute(async (req, res) => {
      const { pluginType, action, input } = req.body ?? {};
      if (!pluginType || !action) {
        throw AppError.badRequest('sandbox_invalid_input', 'pluginType and action are required');
      }
      res.json(
        jsonResult({
          result: await runPluginSandbox(req.ctx.user!.id, {
            pluginType: String(pluginType),
            action: String(action),
            input: (input as Record<string, unknown>) ?? {},
          }),
        }),
      );
    }),
  );

  return router;
};