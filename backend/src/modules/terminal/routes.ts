/**
 * CodeConClave — terminal routes (/api/v1/terminal).
 * Sessions are owner-scoped; the status of a session is whatever the paired
 * local agent really reports (RUNNING only with a real pid). Search/log
 * endpoints support the Local Terminal workspace (history, logs download).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import {
  terminalCreateSchema,
  terminalInputSchema,
  terminalListQuerySchema,
  terminalSearchQuerySchema,
} from '@codeconclave/shared';
import {
  createTerminalSession,
  downloadLogs,
  getSession,
  killSession,
  listSessions,
  restartSession,
  searchHistory,
  sendInput,
} from './service.js';

export const terminalRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/sessions',
    asyncRoute(async (req, res) => {
      const input = terminalCreateSchema.parse(req.body);
      const session = await createTerminalSession(req.ctx.user!.id, input);
      res.status(201).json(jsonResult({ session }));
    }),
  );

  router.get(
    '/sessions',
    asyncRoute(async (req, res) => {
      const query = terminalListQuerySchema.parse(req.query);
      res.json(jsonResult({ sessions: await listSessions(req.ctx.user!.id, query.limit) }));
    }),
  );

  router.get(
    '/sessions/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await getSession(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.post(
    '/sessions/:id/input',
    asyncRoute(async (req, res) => {
      const input = terminalInputSchema.parse(req.body);
      await sendInput(req.ctx.user!.id, req.params.id!, input.input);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/sessions/:id/kill',
    asyncRoute(async (req, res) => {
      await killSession(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/sessions/:id/restart',
    asyncRoute(async (req, res) => {
      await restartSession(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/sessions/:id/logs',
    asyncRoute(async (req, res) => {
      const text = await downloadLogs(req.ctx.user!.id, req.params.id!);
      res.type('text/plain').send(text);
    }),
  );

  router.get(
    '/search',
    asyncRoute(async (req, res) => {
      const query = terminalSearchQuerySchema.parse(req.query);
      res.json(jsonResult({ lines: await searchHistory(req.ctx.user!.id, query.q, query.limit) }));
    }),
  );

  return router;
};