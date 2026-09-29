/**
 * CodeConClave — workspace share routes.
 *
 * Authenticated routes (require session):
 *   GET    /api/v1/workspace/shares           list shares for a project
 *   POST   /api/v1/workspace/shares           create a share link (public or private)
 *   POST   /api/v1/workspace/shares/:id/revoke revoke a share link
 *
 * Public route (NO auth required):
 *   GET    /api/v1/workspace/shares/public/:token  resolve a public share token
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  createWorkspaceShare,
  listWorkspaceShares,
  revokeWorkspaceShare,
  resolvePublicShare,
} from './shares-service.js';

export const workspaceShareRoutes = (): Router => {
  const router = Router();

  // Public route — must come before requireAuth
  router.get(
    '/public/:token',
    asyncRoute(async (req, res) => {
      const token = String(req.params.token ?? '');
      if (!token) throw AppError.badRequest('token_required', 'A share token is required.');
      const share = await resolvePublicShare(token);
      if (!share) throw AppError.notFound('Share link');
      res.json(jsonResult({ share }));
    }),
  );

  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required.');
      const shares = await listWorkspaceShares(req.ctx.user!.id, projectId);
      res.json(jsonResult({ shares }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required.');
      const visibility = req.body?.visibility === 'PRIVATE' ? 'PRIVATE' as const : 'PUBLIC' as const;
      const mode = ['WATCH', 'COMMENT', 'CO_CONTROL'].includes(req.body?.mode) ? req.body.mode : 'WATCH';
      const expiresInDays = req.body?.expiresInDays != null ? Number(req.body.expiresInDays) : undefined;
      const oneTime = req.body?.oneTime === true;
      const share = await createWorkspaceShare(req.ctx.user!.id, projectId, {
        visibility,
        mode,
        expiresInDays,
        oneTime,
      });
      res.json(jsonResult({ share }));
    }),
  );

  router.post(
    '/:id/revoke',
    asyncRoute(async (req, res) => {
      await revokeWorkspaceShare(req.ctx.user!.id, String(req.params.id ?? ''));
      res.json(jsonResult({ ok: true }));
    }),
  );

  return router;
};