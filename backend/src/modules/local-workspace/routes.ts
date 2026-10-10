/**
 * CodeConClave — P2 local workspace bridge routes (/api/v1/local-workspace).
 *
 *   GET  /devices                      owned paired devices (+ online)
 *   GET  /workspaces?deviceId=         granted workspace roots on a device
 *   GET  /tree?deviceId=&path=&limit=  browse a directory in scope
 *   GET  /file?deviceId=&path=         read a file (+ metadata) in scope
 *   PUT  /file                         write a file in scope (audited)
 *   POST /exec                         run a permitted command on the device
 *
 * All execution + scope enforcement happens on the paired Local Agent; this is
 * a thin, authenticated, audited bridge. Device ownership is structural.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  listLocalDevices,
  listLocalTree,
  listLocalWorkspaces,
  readLocalFile,
  runLocalCommand,
  writeLocalFile,
} from './service.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw AppError.badRequest('invalid_input', `${field} is required`);
  }
  return value;
}

export const localWorkspaceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/devices',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ devices: await listLocalDevices(req.ctx.user!.id) }));
    }),
  );

  router.get(
    '/workspaces',
    asyncRoute(async (req, res) => {
      const deviceId = requireString(req.query.deviceId, 'deviceId');
      res.json(jsonResult({ workspaces: await listLocalWorkspaces(req.ctx.user!.id, deviceId) }));
    }),
  );

  router.get(
    '/tree',
    asyncRoute(async (req, res) => {
      const deviceId = requireString(req.query.deviceId, 'deviceId');
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
      res.json(jsonResult(await listLocalTree(req.ctx.user!.id, deviceId, path, Number.isFinite(limit) ? limit : 200)));
    }),
  );

  router.get(
    '/file',
    asyncRoute(async (req, res) => {
      const deviceId = requireString(req.query.deviceId, 'deviceId');
      const path = requireString(req.query.path, 'path');
      res.json(jsonResult(await readLocalFile(req.ctx.user!.id, deviceId, path)));
    }),
  );

  router.put(
    '/file',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deviceId = requireString(body.deviceId, 'deviceId');
      const path = requireString(body.path, 'path');
      if (typeof body.content !== 'string') throw AppError.badRequest('invalid_input', 'content is required');
      res.json(jsonResult(await writeLocalFile(req.ctx.user!.id, deviceId, path, body.content)));
    }),
  );

  router.post(
    '/exec',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deviceId = requireString(req.body?.deviceId, 'deviceId');
      const command = requireString(body.command, 'command');
      const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
      res.json(jsonResult(await runLocalCommand(req.ctx.user!.id, deviceId, command, cwd)));
    }),
  );

  return router;
};
