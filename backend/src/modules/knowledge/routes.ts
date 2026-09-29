/**
 * CodeConClave — Knowledge Routes (PKG-12).
 * REST endpoints for knowledge retrieval with proper authorization.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { knowledgeService } from './service.js';
import type {
  RetrievalOptions,
  DocumentationQuery,
  PackageKnowledgeQuery,
  SecurityAdvisoryQuery,
  KnowledgeGraphQuery,
  LLMKnowledgeRequest,
} from './types.js';

export const knowledgeRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  // Web knowledge search
  router.post(
    '/search',
    asyncRoute(async (req, res) => {
      const {
        query,
        projectId,
        sourceTypes,
        maxResults,
        maxAgeMs,
        requireFresh,
      } = req.body as RetrievalOptions & { query: string };

      if (!query?.trim()) {
        return res.status(400).json({ error: 'Query is required' });
      }

      const result = await knowledgeService.searchWeb({
        query: query.trim(),
        userId: req.ctx.user!.id,
        projectId,
        sourceTypes,
        maxResults,
        maxAgeMs,
        requireFresh,
      });

      res.json(jsonResult(result));
    }),
  );

  // Documentation retrieval
  router.post(
    '/documentation',
    asyncRoute(async (req, res) => {
      const { technology, topic, version, projectId } = req.body as DocumentationQuery;

      if (!technology?.trim()) {
        return res.status(400).json({ error: 'Technology is required' });
      }

      const result = await knowledgeService.getDocumentation({
        technology: technology.trim(),
        topic: topic?.trim(),
        version: version?.trim(),
        userId: req.ctx.user!.id,
        projectId,
      });

      res.json(jsonResult(result));
    }),
  );

  // Package knowledge
  router.post(
    '/package',
    asyncRoute(async (req, res) => {
      const { packageName, registry, version, projectId } = req.body as PackageKnowledgeQuery;

      if (!packageName?.trim()) {
        return res.status(400).json({ error: 'Package name is required' });
      }

      const result = await knowledgeService.getPackageInfo({
        packageName: packageName.trim(),
        registry,
        version: version?.trim(),
        userId: req.ctx.user!.id,
        projectId,
      });

      res.json(jsonResult(result));
    }),
  );

  // Security advisories
  router.post(
    '/security-advisories',
    asyncRoute(async (req, res) => {
      const { packageName, version, ecosystem, projectId } = req.body as SecurityAdvisoryQuery;

      if (!packageName?.trim()) {
        return res.status(400).json({ error: 'Package name is required' });
      }

      const result = await knowledgeService.getSecurityAdvisories({
        packageName: packageName.trim(),
        version: version?.trim(),
        ecosystem,
        userId: req.ctx.user!.id,
        projectId,
      });

      res.json(jsonResult(result));
    }),
  );

  // Knowledge graph
  router.post(
    '/graph',
    asyncRoute(async (req, res) => {
      const { centerNode, nodeTypes, maxDepth, maxNodes, projectId } = req.body as KnowledgeGraphQuery;

      if (!centerNode?.trim()) {
        return res.status(400).json({ error: 'Center node is required' });
      }

      const result = await knowledgeService.getKnowledgeGraph({
        centerNode: centerNode.trim(),
        nodeTypes,
        maxDepth,
        maxNodes,
        userId: req.ctx.user!.id,
        projectId,
      });

      res.json(jsonResult(result));
    }),
  );

  // LLM-answered question with citations
  router.post(
    '/ask',
    asyncRoute(async (req, res) => {
      const { question, projectId, context, modelOptions } = req.body as LLMKnowledgeRequest;

      if (!question?.trim()) {
        return res.status(400).json({ error: 'Question is required' });
      }

      const result = await knowledgeService.askWithCitations({
        question: question.trim(),
        userId: req.ctx.user!.id,
        projectId,
        context,
        modelOptions,
      });

      res.json(jsonResult(result));
    }),
  );

  // Multi-source search
  router.post(
    '/search-all',
    asyncRoute(async (req, res) => {
      const { query, projectId } = req.body as { query: string; projectId?: string };

      if (!query?.trim()) {
        return res.status(400).json({ error: 'Query is required' });
      }

      const result = await knowledgeService.searchAllSources(query.trim(), req.ctx.user!.id, projectId);

      res.json(jsonResult(result));
    }),
  );

  // Cache stats
  router.get(
    '/cache/stats',
    asyncRoute(async (req, res) => {
      const stats = knowledgeService.getCacheStats();
      res.json(jsonResult(stats));
    }),
  );

  // Cache management
  router.post(
    '/cache/clear',
    asyncRoute(async (req, res) => {
      await knowledgeService.clearCache();
      res.json(jsonResult({ cleared: true }));
    }),
  );

  // Live source status
  router.get(
    '/sources/status',
    asyncRoute(async (req, res) => {
      const status = knowledgeService.getLiveSourceStatus();
      res.json(jsonResult(status));
    }),
  );

  // Configuration (admin only)
  router.get(
    '/config',
    asyncRoute(async (req, res) => {
      const config = knowledgeService.getConfig();
      res.json(jsonResult(config));
    }),
  );

  return router;
};