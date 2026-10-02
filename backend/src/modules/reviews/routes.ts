/**
 * CodeConClave — B1 cowork safety review loop: HTTP routes (/api/v1/reviews).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  createReview,
  getReview,
  getReviewStatus,
  listReviews,
  decideHunk,
  acceptAllHunks,
  rejectAllHunks,
  applyReview,
  runReviewTests,
  undoReview,
  commitReview,
  cancelReview,
} from './service.js';

export const reviewRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  // ---------------------------------------------------------- list / create
  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      res.json(jsonResult({ reviews: await listReviews(req.ctx.user!.id, projectId) }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!body.taskId || typeof body.taskId !== 'string') {
        throw AppError.badRequest('invalid_input', 'taskId is required');
      }
      if (!Array.isArray(body.files) || body.files.length === 0) {
        throw AppError.badRequest('invalid_input', 'files[] is required');
      }
      const projectId = String(body.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const view = await createReview(req.ctx.user!.id, projectId, {
        taskId: body.taskId,
        runId: body.runId ?? null,
        title: body.title ?? null,
        files: body.files,
        testCommand: body.testCommand ?? null,
      });
      res.status(201).json(jsonResult({ review: view }));
    }),
  );

  // -------------------------------------------------------- accept/reject all
  router.post(
    '/:id/hunks/accept-all',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await acceptAllHunks(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/hunks/reject-all',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await rejectAllHunks(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // -------------------------------------------------------- per-hunk decisions
  router.post(
    '/:id/hunks/:hunkId/accept',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await decideHunk(req.ctx.user!.id, req.params.id!, req.params.hunkId!, 'ACCEPTED') }));
    }),
  );

  router.post(
    '/:id/hunks/:hunkId/reject',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await decideHunk(req.ctx.user!.id, req.params.id!, req.params.hunkId!, 'REJECTED') }));
    }),
  );

  // ---------------------------------------------------------- review actions
  router.post(
    '/:id/apply',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await applyReview(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/run-tests',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await runReviewTests(req.ctx.user!.id, req.params.id!, req.body?.command ?? undefined) }));
    }),
  );

  router.post(
    '/:id/undo',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await undoReview(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/commit',
    asyncRoute(async (req, res) => {
      const message = String(req.body?.message ?? '').trim();
      if (!message) throw AppError.badRequest('review_commit_message_required', 'a commit message is required');
      res.json(jsonResult({ review: await commitReview(req.ctx.user!.id, req.params.id!, message) }));
    }),
  );

  router.post(
    '/:id/cancel',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await cancelReview(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ------------------------------------------------------------ read detail
  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await getReview(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.get(
    '/:id/status',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await getReviewStatus(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  return router;
};