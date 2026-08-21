/**
 * CodeConClave — projects routes.
 */
import { Router } from 'express';
import { createProjectSchema, updateProjectSchema } from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import {
  addProjectMember,
  archiveProject,
  completeProject,
  createProject,
  getProject,
  listProjectActivity,
  listProjectMembers,
  listProjects,
  onHoldProject,
  projectStats,
  removeProjectMember,
  restoreProject,
  softDeleteProject,
  toggleFavoriteProject,
  trashCandidates,
  updateProject,
} from './service.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';

export const projectRoutes = (): Router => {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
      const filters: { favorite?: boolean; status?: string; tag?: string } = {};
      if (req.query.favorite === '1' || req.query.favorite === 'true') filters.favorite = true;
      if (typeof req.query.status === 'string' && req.query.status) {
        if (!['ACTIVE', 'ARCHIVED', 'COMPLETED', 'ON_HOLD'].includes(req.query.status)) {
          throw AppError.badRequest('invalid_status', 'Status must be ACTIVE, ARCHIVED, COMPLETED, or ON_HOLD');
        }
        filters.status = req.query.status;
      }
      if (typeof req.query.tag === 'string' && req.query.tag) filters.tag = req.query.tag;
      const projects = await listProjects(req.ctx.user!.id, includeArchived, filters);
      res.json(jsonResult({ projects }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const input = createProjectSchema.parse(req.body);
      const project = await createProject(req.ctx.user!.id, input);
      res.status(201).json(jsonResult({ project }));
    }),
  );

  router.get(
    '/trash',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ projects: await trashCandidates(req.ctx.user!.id) }));
    }),
  );

  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      const project = await getProject(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ project }));
    }),
  );

  router.patch(
    '/:id',
    asyncRoute(async (req, res) => {
      const input = updateProjectSchema.parse(req.body);
      const project = await updateProject(req.ctx.user!.id, req.params.id!, {
        ...input,
        status: input.status as 'ACTIVE' | 'ARCHIVED' | 'COMPLETED' | 'ON_HOLD' | undefined,
      });
      res.json(jsonResult({ project }));
    }),
  );

  router.post(
    '/:id/archive',
    asyncRoute(async (req, res) => {
      const project = await archiveProject(req.ctx.user!.id, req.params.id!, true);
      res.json(jsonResult({ project }));
    }),
  );

  router.post(
    '/:id/complete',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ project: await completeProject(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/on-hold',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ project: await onHoldProject(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/favorite',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ project: await toggleFavoriteProject(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.get(
    '/:id/activity',
    asyncRoute(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      res.json(jsonResult({ activity: await listProjectActivity(req.ctx.user!.id, req.params.id!, limit) }));
    }),
  );

  router.post(
    '/:id/restore',
    asyncRoute(async (req, res) => {
      const project = await restoreProject(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ project }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      await softDeleteProject(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/:id/stats',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await projectStats(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.get(
    '/:id/members',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ members: await listProjectMembers(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/members',
    asyncRoute(async (req, res) => {
      const email = String(req.body.email ?? '');
      const role = String(req.body.role ?? 'member');
      if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
        throw AppError.badRequest('invalid_role', 'Role must be owner, admin, member, or viewer');
      }
      await addProjectMember(req.ctx.user!.id, req.params.id!, email, role);
      res.status(201).json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/:id/members/:userId',
    asyncRoute(async (req, res) => {
      await removeProjectMember(req.ctx.user!.id, req.params.id!, req.params.userId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  return router;
};