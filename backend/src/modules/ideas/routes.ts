/**
 * CodeConClave — ideas routes (Phase 13).
 */
import { Router } from 'express';
import {
  ideaArchiveSchema,
  ideaCommentCreateSchema,
  ideaCreateSchema,
  ideaUpdateSchema,
  ideaVoteSchema,
} from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import {
  addIdeaComment,
  createIdea,
  deleteIdeaComment,
  getIdea,
  ideaVoteState,
  listIdeaComments,
  listIdeas,
  restoreIdea,
  setIdeaArchived,
  toIdeaJson,
  trashIdea,
  updateIdea,
  voteIdea,
} from './service.js';

export const ideasRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const q = req.query.q ? String(req.query.q) : undefined;
      const status = req.query.status ? String(req.query.status) : undefined;
      const priority = req.query.priority ? String(req.query.priority) : undefined;
      const category = req.query.category ? String(req.query.category) : undefined;
      const tag = req.query.tag ? String(req.query.tag) : undefined;
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const teamId = req.query.teamId ? String(req.query.teamId) : undefined;
      const assigneeId = req.query.assigneeId ? String(req.query.assigneeId) : undefined;
      const archived = req.query.archived !== undefined ? req.query.archived === '1' || req.query.archived === 'true' : undefined;
      const trashed = req.query.trashed === '1' || req.query.trashed === 'true';
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const result = await listIdeas(req.ctx.user!.id, {
        q,
        status,
        priority,
        category,
        tag,
        projectId,
        teamId,
        assigneeId,
        archived,
        trashed,
        limit,
        offset,
      });
      res.json(
        jsonResult({
          ideas: result.items.map(toIdeaJson),
          total: result.total,
          limit,
          offset,
        }),
      );
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const input = ideaCreateSchema.parse(req.body);
      const idea = await createIdea(req.ctx.user!.id, input);
      res.status(201).json(jsonResult({ idea }));
    }),
  );

  router.get(
    '/:ideaId',
    asyncRoute(async (req, res) => {
      const idea = await getIdea(req.ctx.user!.id, String(req.params.ideaId));
      res.json(jsonResult({ idea, voted: await ideaVoteState(req.ctx.user!.id, idea.id) }));
    }),
  );

  router.patch(
    '/:ideaId',
    asyncRoute(async (req, res) => {
      const input = ideaUpdateSchema.parse(req.body);
      const idea = await updateIdea(req.ctx.user!.id, String(req.params.ideaId), input);
      res.json(jsonResult({ idea }));
    }),
  );

  router.post(
    '/:ideaId/vote',
    asyncRoute(async (req, res) => {
      const { on } = ideaVoteSchema.parse(req.body);
      const idea = await voteIdea(req.ctx.user!.id, String(req.params.ideaId), on);
      res.json(jsonResult({ idea, voted: on }));
    }),
  );

  router.get(
    '/:ideaId/comments',
    asyncRoute(async (req, res) => {
      const comments = await listIdeaComments(req.ctx.user!.id, String(req.params.ideaId));
      res.json(jsonResult({ comments }));
    }),
  );

  router.post(
    '/:ideaId/comments',
    asyncRoute(async (req, res) => {
      const input = ideaCommentCreateSchema.parse(req.body);
      const comment = await addIdeaComment(req.ctx.user!.id, String(req.params.ideaId), input);
      res.status(201).json(jsonResult({ comment }));
    }),
  );

  router.delete(
    '/:ideaId/comments/:commentId',
    asyncRoute(async (req, res) => {
      const result = await deleteIdeaComment(
        req.ctx.user!.id,
        String(req.params.ideaId),
        String(req.params.commentId),
      );
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/:ideaId/archive',
    asyncRoute(async (req, res) => {
      const { archived } = ideaArchiveSchema.parse(req.body);
      const idea = await setIdeaArchived(req.ctx.user!.id, String(req.params.ideaId), archived);
      res.json(jsonResult({ idea }));
    }),
  );

  router.post(
    '/:ideaId/trash',
    asyncRoute(async (req, res) => {
      const result = await trashIdea(req.ctx.user!.id, String(req.params.ideaId));
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/:ideaId/restore',
    asyncRoute(async (req, res) => {
      const idea = await restoreIdea(req.ctx.user!.id, String(req.params.ideaId));
      res.json(jsonResult({ idea }));
    }),
  );

  return router;
};