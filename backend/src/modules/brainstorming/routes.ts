/**
 * CodeConClave — brainstorming routes (Phase 13).
 */
import { Router } from 'express';
import {
  brainstormCaptureSchema,
  brainstormCreateSchema,
  brainstormGenerateSchema,
  brainstormParticipantAddSchema,
} from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import {
  addParticipant,
  archiveSession,
  captureIdea,
  completeSession,
  createSession,
  generateIdeas,
  getSessionDetail,
  listSessions,
} from './service.js';

export const brainstormingRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const sessions = await listSessions(req.ctx.user!.id);
      res.json(jsonResult({ sessions }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const input = brainstormCreateSchema.parse(req.body);
      const session = await createSession(req.ctx.user!.id, input);
      res.status(201).json(jsonResult({ session }));
    }),
  );

  router.get(
    '/:sessionId',
    asyncRoute(async (req, res) => {
      const detail = await getSessionDetail(req.ctx.user!.id, String(req.params.sessionId));
      res.json(jsonResult(detail));
    }),
  );

  router.post(
    '/:sessionId/participants',
    asyncRoute(async (req, res) => {
      const { userId } = brainstormParticipantAddSchema.parse(req.body);
      const participants = await addParticipant(req.ctx.user!.id, String(req.params.sessionId), userId);
      res.status(201).json(jsonResult({ participants }));
    }),
  );

  router.post(
    '/:sessionId/capture',
    asyncRoute(async (req, res) => {
      const input = brainstormCaptureSchema.parse(req.body);
      const result = await captureIdea(req.ctx.user!.id, String(req.params.sessionId), input);
      res.status(201).json(jsonResult(result));
    }),
  );

  router.post(
    '/:sessionId/generate',
    asyncRoute(async (req, res) => {
      const input = brainstormGenerateSchema.parse(req.body);
      const result = await generateIdeas(req.ctx.user!.id, String(req.params.sessionId), input);
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/:sessionId/complete',
    asyncRoute(async (req, res) => {
      const session = await completeSession(req.ctx.user!.id, String(req.params.sessionId));
      res.json(jsonResult({ session }));
    }),
  );

  router.post(
    '/:sessionId/archive',
    asyncRoute(async (req, res) => {
      const session = await archiveSession(req.ctx.user!.id, String(req.params.sessionId));
      res.json(jsonResult({ session }));
    }),
  );

  return router;
};