/**
 * CodeConClave — Visual Intelligence Routes (PKG-13).
 * Authenticated REST endpoints for image/screenshot/UI analysis, diagram &
 * architecture & state-machine visualization, advisory code proposals, honest
 * capability reporting, and cache management. All routes enforce auth, ownership/
 * workspace isolation, and payload bounds.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { visualIntelligenceService } from './service.js';
import {
  VisualAnalysisRequestSchema,
  DiagramToCodeRequestSchema,
  CodeProposalRequestSchema,
  DiagramGenerateRequestSchema,
  ArchitectureRequestSchema,
  StateMachineRequestSchema,
  CacheClearRequestSchema,
} from './types.js';

const MAX_DIAGRAM_CONTENT = 200000;

export const visualIntelligenceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  // Analyze an image / screenshot / UI (by uploaded file id).
  router.post(
    '/analyze',
    asyncRoute(async (req, res) => {
      const parsed = VisualAnalysisRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await visualIntelligenceService.analyzeImage(uid(req), parsed.data);
      res.json(jsonResult(result));
    }),
  );

  // Advisory code proposal from analysis (B1 review required, never auto-applied).
  router.post(
    '/code-proposal',
    asyncRoute(async (req, res) => {
      const parsed = CodeProposalRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await visualIntelligenceService.generateCodeProposal(uid(req), parsed.data);
      res.json(jsonResult(result));
    }),
  );

  // Generate a diagram (reuses flowDiagram.ts).
  router.post(
    '/diagram/generate',
    asyncRoute(async (req, res) => {
      const parsed = DiagramGenerateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await visualIntelligenceService.generateDiagram(uid(req), parsed.data);
      res.json(jsonResult(result));
    }),
  );

  // Diagram (Mermaid text) → advisory code scaffold.
  router.post(
    '/diagram/to-code',
    asyncRoute(async (req, res) => {
      const parsed = DiagramToCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      if (parsed.data.content.length > MAX_DIAGRAM_CONTENT) {
        return res.status(413).json({ error: 'diagram_too_large' });
      }
      const result = await visualIntelligenceService.generateDiagramCode(uid(req), parsed.data);
      res.json(jsonResult(result));
    }),
  );

  // Architecture visualization (reuses architectureOracle.ts).
  router.post(
    '/architecture',
    asyncRoute(async (req, res) => {
      const parsed = ArchitectureRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await visualIntelligenceService.getArchitectureVisualization(uid(req), parsed.data.projectId);
      res.json(jsonResult(result));
    }),
  );

  // State-machine visualization (uses flowDiagram.ts state type).
  router.post(
    '/state-machine',
    asyncRoute(async (req, res) => {
      const parsed = StateMachineRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await visualIntelligenceService.getStateMachineVisualization(
        uid(req),
        parsed.data.projectId,
        parsed.data.scope,
      );
      res.json(jsonResult(result));
    }),
  );

  // Visual regression (honest NOT_IMPLEMENTED for pixel comparison).
  router.post(
    '/regression',
    asyncRoute(async (req, res) => {
      const { before, after } = req.body as { before?: unknown; after?: unknown };
      const result = await visualIntelligenceService.getVisualRegression(uid(req), before as never, after as never);
      res.json(jsonResult(result));
    }),
  );

  // Honest provider capability report.
  router.get(
    '/capabilities',
    asyncRoute(async (req, res) => {
      const result = await visualIntelligenceService.getProviderCapabilities(uid(req));
      res.json(jsonResult(result));
    }),
  );

  // Cache management.
  router.post(
    '/cache/clear',
    asyncRoute(async (req, res) => {
      const parsed = CacheClearRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const result = await visualIntelligenceService.clearCache(parsed.data.pattern);
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/cache/stats',
    asyncRoute(async (req, res) => {
      const result = visualIntelligenceService.getCacheStats();
      res.json(jsonResult(result));
    }),
  );

  return router;
};
