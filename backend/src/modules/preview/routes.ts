/**
 * CodeConClave — preview routes (Stage 25.5).
 * State, build trigger, offline mark, SSE stream and the sandboxed content
 * endpoint. Content is only served for READY builds from the sandboxed output
 * dir with strict CSP; everything else returns an honest non-200.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { previewBuildSchema } from '@codeconclave/shared';
import {
  getPreview,
  requestBuild,
  markPreviewOffline,
  subscribePreview,
  previewContent,
  previewConfigured,
} from './service.js';
import {
  addPreviewComment,
  listPreviewComments,
  resolvePreviewComment,
} from './comments.js';
import {
  capturePreviewSnapshot,
  previewVisualDiff,
} from './snapshots.js';

export const previewRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/:projectId',
    asyncRoute(async (req, res) => {
      const session = await getPreview(req.ctx.user!.id, req.params.projectId!);
      res.json(jsonResult({ session, configured: previewConfigured() }));
    }),
  );

  router.post(
    '/:projectId/build',
    asyncRoute(async (req, res) => {
      const parsed = previewBuildSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw AppError.badRequest('invalid_preview_input', 'Invalid preview build payload');
      const session = await requestBuild(req.ctx.user!.id, req.params.projectId!, parsed.data.taskId);
      res.json(jsonResult({ session }));
    }),
  );

  router.post(
    '/:projectId/refresh',
    asyncRoute(async (req, res) => {
      const session = await requestBuild(req.ctx.user!.id, req.params.projectId!);
      res.json(jsonResult({ session }));
    }),
  );

  router.post(
    '/:projectId/offline',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ session: await markPreviewOffline(req.ctx.user!.id, req.params.projectId!) }));
    }),
  );

  router.get(
    '/:projectId/stream',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const session = await getPreview(userId, req.params.projectId!);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      write({ state: session.state, version: session.version, taskId: session.task_id, error: session.error });
      const unsubscribe = subscribePreview(req.params.projectId!, write);
      req.on('close', unsubscribe);
    }),
  );

  router.get(
    '/:projectId/content',
    asyncRoute(async (req, res) => {
      const content = await previewContent(req.ctx.user!.id, req.params.projectId!);
      if (!content) {
        res.status(409).json(jsonResult({ error: 'preview_not_ready' }));
        return;
      }
      for (const [k, v] of Object.entries(content.headers)) res.setHeader(k, v);
      res.type('html').send(content.html);
    }),
  );

  router.get(
    '/:projectId/comments',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ comments: await listPreviewComments(req.ctx.user!.id, req.params.projectId!) }));
    }),
  );

  router.post(
    '/:projectId/comments',
    asyncRoute(async (req, res) => {
      const { selector, comment } = req.body ?? {};
      if (!selector || !comment) {
        throw AppError.badRequest('comment_invalid_input', 'selector and comment are required');
      }
      res.json(
        jsonResult({
          comment: await addPreviewComment(req.ctx.user!.id, {
            projectId: req.params.projectId!,
            selector: String(selector),
            comment: String(comment),
          }),
        }),
      );
    }),
  );

  router.post(
    '/:projectId/comments/:commentId/resolve',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ comment: await resolvePreviewComment(req.ctx.user!.id, req.params.commentId!) }));
    }),
  );

  router.post(
    '/:projectId/snapshots',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ snapshot: await capturePreviewSnapshot(req.ctx.user!.id, req.params.projectId!) }));
    }),
  );

  router.get(
    '/:projectId/diff',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ diff: await previewVisualDiff(req.ctx.user!.id, req.params.projectId!) }));
    }),
  );

  return router;
};