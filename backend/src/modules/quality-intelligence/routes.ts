/**
 * CodeConClave — Quality Intelligence Routes (PKG-14).
 * Authenticated REST endpoints for static code-quality & correctness analysis:
 * Code Smell Agent (#6), Concurrent Bug Detector (#7), Memory Leak Hunter (#8),
 * Type Safety Enhancer (#9), Invariant Keeper (#10). All routes enforce auth and
 * workspace isolation; findings are advisory.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { qualityIntelligenceService } from './service.js';
import {
  AnalyzeProjectRequestSchema,
  AnalyzeFileRequestSchema,
} from './types.js';

export const qualityIntelligenceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  // Analyze a project (or explicit file subset) across the requested kinds.
  router.post(
    '/analyze',
    asyncRoute(async (req, res) => {
      const parsed = AnalyzeProjectRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await qualityIntelligenceService.analyzeProject(uid(req), parsed.data);
      res.json(jsonResult(result));
    }),
  );

  // Analyze a single uploaded source file by id.
  router.post(
    '/file',
    asyncRoute(async (req, res) => {
      const parsed = AnalyzeFileRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await qualityIntelligenceService.analyzeFile(uid(req), parsed.data);
      res.json(jsonResult(result));
    }),
  );

  // Honest capability report for the five analyzers.
  router.get(
    '/capabilities',
    asyncRoute(async (req, res) => {
      const result = qualityIntelligenceService.getCapabilities();
      res.json(jsonResult(result));
    }),
  );

  return router;
};
