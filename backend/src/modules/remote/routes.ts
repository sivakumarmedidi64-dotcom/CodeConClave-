/**
 * CodeConClave — remote-control routes (/api/v1/remote).
 * Sessions, revocation, screenshot authorization and the honest screenshot
 * attempt (typed adapter; 501 when no real capture source exists).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { remoteSessionCreateSchema } from '@codeconclave/shared';
import { AppError } from '../../shared/errors.js';
import {
  authorizeScreenshot,
  createRemoteSession,
  listRemoteSessions,
  requestScreenshot,
  revokeRemoteSession,
} from './service.js';
import { agentWs } from '../agent/ws.js';
import { listDeviceStatus } from '../agent/service.js';

export const remoteRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/devices',
    asyncRoute(async (req, res) => {
      const hub = agentWs();
      res.json(jsonResult({ devices: await listDeviceStatus(req.ctx.user!.id, (u, d) => hub.isOnline(u, d)) }));
    }),
  );

  router.get(
    '/sessions',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ sessions: await listRemoteSessions(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/sessions',
    asyncRoute(async (req, res) => {
      const input = remoteSessionCreateSchema.parse(req.body);
      const session = await createRemoteSession(req.ctx.user!.id, input.deviceId);
      res.status(201).json(jsonResult({ session }));
    }),
  );

  router.delete(
    '/sessions/:id',
    asyncRoute(async (req, res) => {
      await revokeRemoteSession(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/sessions/:id/screenshot-auth',
    asyncRoute(async (req, res) => {
      await authorizeScreenshot(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/sessions/:id/screenshot',
    asyncRoute(async (req, res) => {
      const result = await requestScreenshot(req.ctx.user!.id, req.params.id!);
      if (!result.image) {
        throw AppError.unavailable(
          'screenshot_source_unavailable',
          'No real screenshot source exists on this platform — the typed adapter is wired, but capture is an external limitation (never simulated)',
        );
      }
      res.set('Content-Type', 'image/png').send(Buffer.from(result.image));
    }),
  );

  return router;
};