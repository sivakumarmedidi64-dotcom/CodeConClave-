/**
 * CodeConClave — Artifact Center routes (Phase 8).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { createTaskArtifact, listArtifacts, downloadArtifact, artifactReferences } from './service.js';

export const artifactRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const { taskId, name, kind, content, verification, attemptId } = req.body ?? {};
      if (!taskId || !name || !kind) {
        throw AppError.badRequest('invalid_input', 'taskId, name and kind are required');
      }
      if (content !== undefined && typeof content !== 'string') {
        throw AppError.badRequest('invalid_content', 'content must be a string');
      }
      const artifact = await createTaskArtifact({
        userId: req.ctx.user!.id,
        taskId: String(taskId),
        name: String(name),
        kind: String(kind),
        content: content !== undefined ? content : undefined,
        verification: verification !== undefined ? String(verification) : null,
        attemptId: attemptId !== undefined ? String(attemptId) : null,
      });
      res.status(201).json(jsonResult({ artifact }));
    }),
  );

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const { taskId, projectId, kind } = req.query;
      const artifacts = await listArtifacts(req.ctx.user!.id, {
        taskId: taskId ? String(taskId) : undefined,
        projectId: projectId ? String(projectId) : undefined,
        kind: kind ? String(kind) : undefined,
      });
      res.json(jsonResult({ artifacts }));
    }),
  );

  router.get(
    '/:id/download',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await downloadArtifact(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.get(
    '/:id/references',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ references: await artifactReferences(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  return router;
};