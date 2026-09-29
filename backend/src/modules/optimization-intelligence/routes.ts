/**
 * CodeConClave — Optimization Intelligence Routes (PKG-16).
 * Authenticated REST endpoints for Performance Timeline (#16), Database Query
 * Optimizer (#17), Batch Processing Optimizer (#19), Cost-Aware Refactoring (#20).
 * All routes enforce auth + project ownership (via existing services + RLS);
 * findings are advisory.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { optimizationIntelligenceService } from './service.js';
import { buildPerformanceTimeline } from './timeline.js';
import { runQueryOptimizer } from './queryOptimizer.js';
import { runBatchOptimizer } from './batchOptimizer.js';
import { buildCostAwareRefactor } from './costRefactoring.js';
import { OptimizationReportInputSchema } from './types.js';

function parseProjectId(q: unknown, body: unknown): { projectId: string; fileIds?: string[] } {
  const projectId = typeof q === 'string' ? q : (body as { projectId?: string } | undefined)?.projectId;
  if (!projectId) throw Object.assign(new Error('project_required'), { status: 400 });
  const fileIds = Array.isArray((body as { fileIds?: unknown } | undefined)?.fileIds)
    ? ((body as { fileIds: string[] }).fileIds).slice(0, 500)
    : undefined;
  const parsed = OptimizationReportInputSchema.safeParse({ projectId });
  if (!parsed.success) throw Object.assign(new Error('invalid_project'), { status: 400 });
  return { projectId: parsed.data.projectId, fileIds };
}

export const optimizationIntelligenceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  // Honest capability report for the four capabilities.
  router.get(
    '/capabilities',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(optimizationIntelligenceService.getCapabilities()));
    }),
  );

  // #16 — performance timeline
  router.post(
    '/timeline',
    asyncRoute(async (req, res) => {
      const { projectId, fileIds } = parseProjectId(req.query.projectId, req.body);
      const report = await buildPerformanceTimeline(uid(req), projectId, fileIds);
      res.json(jsonResult(report));
    }),
  );

  // #17 — database query optimizer
  router.post(
    '/query-optimizer',
    asyncRoute(async (req, res) => {
      const { projectId, fileIds } = parseProjectId(req.query.projectId, req.body);
      const report = await runQueryOptimizer(uid(req), projectId, fileIds);
      res.json(jsonResult(report));
    }),
  );

  // #19 — batch processing optimizer
  router.post(
    '/batch-optimizer',
    asyncRoute(async (req, res) => {
      const { projectId } = parseProjectId(req.query.projectId, req.body);
      const report = await runBatchOptimizer(uid(req), projectId);
      res.json(jsonResult(report));
    }),
  );

  // #20 — cost-aware refactoring
  router.post(
    '/cost-refactoring',
    asyncRoute(async (req, res) => {
      const { projectId } = parseProjectId(req.query.projectId, req.body);
      const report = await buildCostAwareRefactor(uid(req), projectId);
      res.json(jsonResult(report));
    }),
  );

  return router;
};