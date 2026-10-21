/**
 * CodeConClave — MCP servers API (/api/v1/mcp). Article 8.
 *   GET    /servers                 list (tools included; auth values never returned)
 *   POST   /servers                 connect a server (discovers tools right away)
 *   PATCH  /servers/:id             { enabled }
 *   DELETE /servers/:id
 *   POST   /servers/:id/refresh     re-discover tools
 *   POST   /call                    { server, tool, arguments } — policy-gated
 *   POST   /approvals/:id/run       run the exact call an APPROVED approval holds, once
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { addServer, callMcpTool, deleteServer, listServers, refreshServer, runApprovedMcpCall, setServerEnabled } from './service.js';

export const mcpRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/servers',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ servers: await listServers(req.ctx.user!.id), maxServers: env.MCP_MAX_SERVERS }));
    }),
  );

  router.post(
    '/servers',
    asyncRoute(async (req, res) => {
      res.status(201).json(jsonResult({ server: await addServer(req.ctx.user!.id, req.body) }));
    }),
  );

  router.patch(
    '/servers/:id',
    asyncRoute(async (req, res) => {
      if (typeof req.body?.enabled !== 'boolean') throw AppError.badRequest('invalid_enabled', 'enabled must be true or false');
      res.json(jsonResult({ server: await setServerEnabled(req.ctx.user!.id, String(req.params.id), req.body.enabled) }));
    }),
  );

  router.delete(
    '/servers/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ deleted: await deleteServer(req.ctx.user!.id, String(req.params.id)) }));
    }),
  );

  router.post(
    '/servers/:id/refresh',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ server: await refreshServer(req.ctx.user!.id, String(req.params.id)) }));
    }),
  );

  router.post(
    '/call',
    asyncRoute(async (req, res) => {
      const outcome = await callMcpTool(req.ctx.user!.id, {
        server: String(req.body?.server ?? ''),
        tool: String(req.body?.tool ?? ''),
        arguments: req.body?.arguments,
        via: 'manual',
      });
      res.json(jsonResult({ outcome }));
    }),
  );

  router.post(
    '/approvals/:id/run',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ result: await runApprovedMcpCall(req.ctx.user!.id, String(req.params.id)) }));
    }),
  );

  return router;
};
