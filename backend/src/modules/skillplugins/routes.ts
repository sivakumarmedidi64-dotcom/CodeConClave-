/**
 * CodeConClave — skill-plugin routes (/api/v1/skill-plugins).
 */
import { Router } from 'express';
import { z } from 'zod';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  activePlugins,
  deleteCustomPlugin,
  installPlugin,
  listCatalog,
  listCommands,
  manageableTeams,
  publishTeamPlugin,
  saveCustomPlugin,
  setPluginEnabled,
  teamPluginVersions,
  uninstallPlugin,
  unpublishTeamPlugin,
} from './service.js';

const slugParam = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40);
const teamIdParam = z.string().regex(/^[A-Za-z0-9_-]+$/).max(64);

function teamIdOf(raw: unknown): string {
  const parsed = teamIdParam.safeParse(raw);
  if (!parsed.success) throw AppError.badRequest('invalid_team', 'Invalid team id');
  return parsed.data;
}
const enabledBody = z.object({ enabled: z.boolean() });

function slugOf(raw: unknown): string {
  const parsed = slugParam.safeParse(raw);
  if (!parsed.success) throw AppError.badRequest('invalid_slug', 'Invalid plugin slug');
  return parsed.data;
}

export const skillPluginRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ plugins: await listCatalog(req.ctx!.user!.id) }));
    }),
  );

  router.get(
    '/commands',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ commands: listCommands(await activePlugins(req.ctx!.user!.id)) }));
    }),
  );

  router.post(
    '/:slug/install',
    asyncRoute(async (req, res) => {
      res.status(201).json(jsonResult({ plugin: await installPlugin(req.ctx!.user!.id, slugOf(req.params.slug)) }));
    }),
  );

  router.patch(
    '/:slug',
    asyncRoute(async (req, res) => {
      const body = enabledBody.safeParse(req.body);
      if (!body.success) throw AppError.badRequest('invalid_body', 'Expected { enabled: boolean }');
      await setPluginEnabled(req.ctx!.user!.id, slugOf(req.params.slug), body.data.enabled);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/:slug/install',
    asyncRoute(async (req, res) => {
      await uninstallPlugin(req.ctx!.user!.id, slugOf(req.params.slug));
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/custom',
    asyncRoute(async (req, res) => {
      res.status(201).json(jsonResult({ manifest: await saveCustomPlugin(req.ctx!.user!.id, req.body?.manifest) }));
    }),
  );

  // Team plugins (Team #4 shared instructions, #11 approved workflows).
  router.get(
    '/teams',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ teams: await manageableTeams(req.ctx!.user!.id) }));
    }),
  );

  router.post(
    '/teams/:teamId',
    asyncRoute(async (req, res) => {
      const manifest = await publishTeamPlugin(req.ctx!.user!.id, teamIdOf(req.params.teamId), req.body?.manifest);
      res.status(201).json(jsonResult({ manifest }));
    }),
  );

  router.delete(
    '/teams/:teamId/:slug',
    asyncRoute(async (req, res) => {
      await unpublishTeamPlugin(req.ctx!.user!.id, teamIdOf(req.params.teamId), slugOf(req.params.slug));
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/teams/:teamId/:slug/versions',
    asyncRoute(async (req, res) => {
      const versions = await teamPluginVersions(req.ctx!.user!.id, teamIdOf(req.params.teamId), slugOf(req.params.slug));
      res.json(jsonResult({ versions }));
    }),
  );

  router.delete(
    '/custom/:slug',
    asyncRoute(async (req, res) => {
      await deleteCustomPlugin(req.ctx!.user!.id, slugOf(req.params.slug));
      res.json(jsonResult({ ok: true }));
    }),
  );

  return router;
};
