/**
 * CodeConClave — PKG-20 — environment & terminal-safety routes (/api/v1/environment).
 * Authenticated + project-owned. Complements (does not duplicate) the PKG-19
 * runtime surface by adding environment status/validation, command preflight
 * and risk classification, and auditable environment selection. Names-only —
 * secret values are never accepted or returned.
 *
 *   - GET  /status          active environment + validation names-only
 *   - POST /validate        validate a requested environment
 *   - POST /preflight       command × environment preflight decision
 *   - POST /classify        deterministic command-risk classification
 *   - POST /select          switch active environment (auditable; production confirms)
 *   - GET  /history         recent environment switches
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { environmentService } from './service.js';
import { ENVIRONMENTS, type Environment } from './types.js';

function projectIdFrom(req: import('express').Request): string {
  const q = req.query.projectId;
  const b = (req.body as { projectId?: unknown } | undefined)?.projectId;
  const pid = typeof q === 'string' ? q : typeof b === 'string' ? b : '';
  if (!pid) throw Object.assign(new Error('project_required'), { status: 400 });
  return pid;
}

function asEnvironment(v: unknown): Environment | undefined {
  if (typeof v !== 'string') return undefined;
  const e = v.toLowerCase();
  return (ENVIRONMENTS as readonly string[]).includes(e) ? (e as Environment) : undefined;
}

function optionalStr(body: unknown, key: string): string | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 2000) : undefined;
}

export const environmentRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  router.get('/status', asyncRoute(async (req, res) => {
    const pid = projectIdFrom(req);
    const env = asEnvironment(req.query.environment);
    res.json(jsonResult(await environmentService.getStatus(uid(req), pid, env)));
  }));

  router.post('/validate', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const pid = projectIdFrom(req);
    const env = asEnvironment(params?.environment) ?? 'development';
    res.json(jsonResult(await environmentService.validate(uid(req), pid, env)));
  }));

  router.post('/preflight', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const pid = projectIdFrom(req);
    const command = optionalStr(params, 'command');
    if (!command) throw Object.assign(new Error('command_required'), { status: 400 });
    const env = asEnvironment(params?.environment);
    res.json(jsonResult(await environmentService.preflight(uid(req), pid, command, env)));
  }));

  router.post('/classify', asyncRoute(async (req, res) => {
    const command = optionalStr(req.body, 'command');
    if (!command) throw Object.assign(new Error('command_required'), { status: 400 });
    res.json(jsonResult(environmentService.classify(uid(req), command)));
  }));

  router.post('/select', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const pid = projectIdFrom(req);
    const toEnv = asEnvironment(params?.environment);
    if (!toEnv) throw Object.assign(new Error('environment_required'), { status: 400 });
    const reason = optionalStr(params, 'reason');
    const confirmed = params?.confirmed === true;
    try {
      const environment = await environmentService.select(uid(req), pid, toEnv, { reason, confirmed });
      res.json(jsonResult({ environment, switched: true }));
    } catch (err) {
      const e = err as { requiresConfirmation?: boolean; status?: number };
      if (e.requiresConfirmation) {
        res.status(400).json(jsonResult({ environment: toEnv, switched: false, requiresConfirmation: true }));
        return;
      }
      throw err;
    }
  }));

  router.get('/history', asyncRoute(async (req, res) => {
    const pid = projectIdFrom(req);
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    res.json(jsonResult(await environmentService.history(uid(req), pid, limit)));
  }));

  return router;
};
