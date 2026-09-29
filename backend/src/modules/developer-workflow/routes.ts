/**
 * CodeConClave — Developer Workflow & Release Operations Routes (PKG-17).
 * Authenticated REST endpoints for workspace migration (#29), doc drift (#34),
 * contextual debugging (#41), hotspot profiler (#44), branch strategy (#31),
 * rollback predictor (#32), hotfix fast-track (#33), feature-flag orchestrator
 * (#35), health dashboard (#43), error recovery playbook (#45). All routes are
 * advisory and enforce auth + project ownership.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { developerWorkflowService } from './service.js';
import { buildMigrationAgentReport } from './migrationAgent.js';
import { buildDocDriftReport } from './docDrift.js';
import { buildContextualDebugReport } from './contextualDebug.js';
import { buildHotspotProfilerReport } from './hotspotProfiler.js';
import { buildBranchStrategyReport } from './branchStrategy.js';
import { buildRollbackPredictorReport } from './rollbackPredictor.js';
import { buildHotfixFastTrackReport } from './hotfix.js';
import { buildFeatureFlagOrchestratorReport } from './featureFlagOrchestrator.js';
import { buildHealthDashboardReport } from './healthDashboard.js';
import { buildErrorRecoveryPlaybook } from './errorRunbook.js';
import { DevWorkflowReportInputSchema } from './types.js';

function parseReq(q: unknown, body: unknown): { projectId: string } {
  const projectId = typeof q === 'string' ? q : (body as { projectId?: string } | undefined)?.projectId;
  if (!projectId) throw Object.assign(new Error('project_required'), { status: 400 });
  const parsed = DevWorkflowReportInputSchema.safeParse({ projectId });
  if (!parsed.success) throw Object.assign(new Error('invalid_project'), { status: 400 });
  return { projectId: parsed.data.projectId };
}

function str(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw Object.assign(new Error(`${key}_required`), { status: 400 });
  }
  return v.trim().slice(0, 2000);
}

export const developerWorkflowRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  router.get(
    '/capabilities',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(developerWorkflowService.getCapabilities()));
    }),
  );

  router.post(
    '/migration',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      res.json(jsonResult(await buildMigrationAgentReport(uid(req), projectId)));
    }),
  );

  router.post(
    '/doc-drift',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      res.json(jsonResult(await buildDocDriftReport(uid(req), projectId)));
    }),
  );

  router.post(
    '/contextual-debug',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      const errorSignature = str(req.body, 'errorSignature');
      res.json(jsonResult(await buildContextualDebugReport(uid(req), projectId, errorSignature)));
    }),
  );

  router.post(
    '/hotspot-profiler',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      res.json(jsonResult(await buildHotspotProfilerReport(uid(req), projectId)));
    }),
  );

  router.post(
    '/branch-strategy',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      res.json(jsonResult(await buildBranchStrategyReport(uid(req), projectId)));
    }),
  );

  router.post(
    '/rollback-predictor',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      const body = req.body as { deploymentCommit?: unknown; previousCommit?: unknown };
      const deploymentCommit = typeof body.deploymentCommit === 'string' ? body.deploymentCommit.slice(0, 100) : undefined;
      const previousCommit = typeof body.previousCommit === 'string' ? body.previousCommit.slice(0, 100) : undefined;
      res.json(jsonResult(await buildRollbackPredictorReport(uid(req), projectId, deploymentCommit, previousCommit)));
    }),
  );

  router.post(
    '/hotfix',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      const incidentTitle = str(req.body, 'incidentTitle');
      res.json(jsonResult(await buildHotfixFastTrackReport(uid(req), projectId, incidentTitle)));
    }),
  );

  router.post(
    '/feature-flags',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      res.json(jsonResult(await buildFeatureFlagOrchestratorReport(uid(req), projectId)));
    }),
  );

  router.post(
    '/health-dashboard',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      res.json(jsonResult(await buildHealthDashboardReport(uid(req), projectId)));
    }),
  );

  router.post(
    '/error-runbook',
    asyncRoute(async (req, res) => {
      const { projectId } = parseReq(req.query.projectId, req.body);
      const errorSignature = str(req.body, 'errorSignature');
      res.json(jsonResult(await buildErrorRecoveryPlaybook(uid(req), projectId, errorSignature)));
    }),
  );

  return router;
};