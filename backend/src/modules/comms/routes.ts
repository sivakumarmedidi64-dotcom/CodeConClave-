/**
 * CodeConClave — comms routes (/api/v1/comms).
 *   POST /email/triage   triage a Gmail connection's unread (or provided threads) + build drafts
 *   POST /email/draft    build one reply draft (data only, never sent)
 *
 * Authenticated + paid middleware (see app.ts). No send endpoint exists here
 * by design — sending stays behind the approval-gated plugin execute flow.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { triageEmailInbox, draftEmailReply } from './service.js';
import type { EmailThread } from './emailTriage.js';

export const commsRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/email/triage',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!projectId) throw AppError.badRequest('invalid_input', 'projectId is required');
      const threads = Array.isArray(body.threads) ? (body.threads as EmailThread[]) : undefined;
      const result = await triageEmailInbox(req.ctx.user!.id, {
        projectId,
        connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
        query: typeof body.query === 'string' ? body.query : undefined,
        maxResults: typeof body.maxResults === 'number' ? body.maxResults : undefined,
        threads,
      });
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/email/draft',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const thread = body.thread as EmailThread | undefined;
      if (!thread || typeof thread.id !== 'string' || typeof thread.from !== 'string') {
        throw AppError.badRequest('invalid_input', 'thread {id, from} is required');
      }
      res.json(jsonResult({ draft: draftEmailReply(thread) }));
    }),
  );

  return router;
};
