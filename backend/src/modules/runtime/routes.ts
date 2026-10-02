/**
 * CodeConClave — PKG-19 runtime — routes (/api/v1/runtime).
 * Authenticated + project-owned runtime surface anchored to F34 (Terminal),
 * F90 (Local Terminal Execution), F38 (Preview) and F49 (WebSocket Hub):
 *   - /executions            controlled streaming execution + lifecycle
 *   - /background            background development tasks
 *   - /console, /network     capture boundaries (evidence-only, redacted)
 *   - /verify                deterministic runtime verification
 *   - /smoke                 smoke-test foundation
 *   - /correlate             frontend/backend runtime correlation
 *   - /events                realtime event SSE stream (F49)
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { runtimeCapabilities } from './service.js';
import { runtimeExecutionsEngine } from './executions.js';
import { runtimeBackgroundEngine } from './background.js';
import { runtimeCaptureEngine } from './capture.js';
import { runtimeVerificationEngine } from './verification.js';
import { runtimeSmokeEngine, parseSmokeConfig } from './smoke.js';
import { runtimeCorrelationEngine } from './correlation.js';
import { subscribeRuntime } from './events.js';

function required(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw Object.assign(new Error(`${key}_required`), { status: 400 });
  }
  return v.trim();
}

function optionalStr(body: unknown, key: string): string | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 2000) : undefined;
}

function optionalNum(body: unknown, key: string): number | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function projectIdFrom(req: import('express').Request): string {
  const viaQuery = req.query.projectId;
  const viaBody = (req.body as { projectId?: unknown } | undefined)?.projectId;
  const pid = typeof viaQuery === 'string' ? viaQuery : typeof viaBody === 'string' ? viaBody : '';
  if (!pid) throw Object.assign(new Error('project_required'), { status: 400 });
  return pid;
}

export const runtimeRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  router.get('/capabilities', asyncRoute(async (_req, res) => {
    res.json(jsonResult(runtimeCapabilities()));
  }));

  // ------------------------------------------------------------- executions
  router.post('/executions', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const projectId = projectIdFrom(req);
    const command = required(params, 'command');
    const kind = optionalStr(params, 'kind');
    const timeoutMs = optionalNum(params, 'timeoutMs');
    res.json(jsonResult(await runtimeExecutionsEngine.execute(uid(req), { projectId, command, kind: kind as never, timeoutMs })));
  }));

  router.get('/executions', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json(jsonResult(await runtimeExecutionsEngine.list(uid(req), projectId, limit)));
  }));

  router.get('/executions/:id', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.json(jsonResult(await runtimeExecutionsEngine.get(uid(req), projectId, req.params.id!)));
  }));

  // ------------------------------------------------------------ background
  router.post('/background', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const projectId = projectIdFrom(req);
    const label = required(params, 'label');
    const command = required(params, 'command');
    const kind = optionalStr(params, 'kind');
    const timeoutMs = optionalNum(params, 'timeoutMs');
    res.json(jsonResult(await runtimeBackgroundEngine.start(uid(req), { projectId, label, kind, command, timeoutMs })));
  }));

  router.get('/background', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json(jsonResult(await runtimeBackgroundEngine.list(uid(req), projectId, limit)));
  }));

  router.get('/background/:id', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.json(jsonResult(await runtimeBackgroundEngine.get(uid(req), projectId, req.params.id!)));
  }));

  router.post('/background/:id/stop', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.json(jsonResult(await runtimeBackgroundEngine.stop(uid(req), projectId, req.params.id!)));
  }));

  // --------------------------------------------------------------- console
  router.post('/console', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const projectId = projectIdFrom(req);
    const level = optionalStr(params, 'level') ?? 'log';
    const message = required(params, 'message');
    const stack = optionalStr(params, 'stack');
    const sourceUrl = optionalStr(params, 'sourceUrl');
    res.json(jsonResult(await runtimeCaptureEngine.recordConsole(uid(req), projectId, level, message, stack, sourceUrl)));
  }));

  router.get('/console', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    res.json(jsonResult(await runtimeCaptureEngine.listConsole(uid(req), projectId, limit)));
  }));

  // --------------------------------------------------------------- network
  router.post('/network', asyncRoute(async (req, res) => {
    const params = req.body as Record<string, unknown> | undefined;
    const projectId = projectIdFrom(req);
    const method = optionalStr(params, 'method') ?? 'GET';
    const url = required(params, 'url');
    const status = optionalNum(params, 'status');
    const durationMs = optionalNum(params, 'durationMs');
    const requestId = optionalStr(params, 'requestId');
    res.json(jsonResult(await runtimeCaptureEngine.recordNetwork(uid(req), projectId, method, url, status, durationMs, requestId)));
  }));

  router.get('/network', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    res.json(jsonResult(await runtimeCaptureEngine.listNetwork(uid(req), projectId, limit)));
  }));

  router.post('/capture/clear', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    const channel = optionalStr(req.body, 'channel');
    await runtimeCaptureEngine.clear(uid(req), projectId, channel === 'console' ? 'console' : channel === 'network' ? 'network' : undefined);
    res.json(jsonResult({ ok: true }));
  }));

  // ------------------------------------------------------------ verify
  router.post('/verify', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.json(jsonResult({ results: await runtimeVerificationEngine.verify(uid(req), projectId) }));
  }));

  // -------------------------------------------------------------- smoke
  router.post('/smoke/run', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    const overridesRaw = Array.isArray((req.body as { overrides?: unknown })?.overrides) ? (req.body as { overrides: SmokeOverride[] }).overrides : undefined;
    const overrides = overridesRaw?.map((o) => ({
      name: String(o.name ?? 'check'),
      method: String(o.method ?? 'GET'),
      url: String(o.url ?? ''),
      expectedStatus: typeof o.expectedStatus === 'number' ? o.expectedStatus : undefined,
      timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : undefined,
    }));
    res.json(jsonResult(await runtimeSmokeEngine.run(uid(req), projectId, overrides)));
  }));

  router.get('/smoke/history', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.json(jsonResult(await runtimeSmokeEngine.history(uid(req), projectId)));
  }));

  router.get('/smoke/config', asyncRoute(async (_req, res) => {
    res.json(jsonResult({ checks: parseSmokeConfig() }));
  }));

  // ----------------------------------------------------------- correlate
  router.post('/correlate', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.json(jsonResult(await runtimeCorrelationEngine.correlate(uid(req), projectId)));
  }));

  // -------------------------------------------------------------- events
  router.get('/events', asyncRoute(async (req, res) => {
    const projectId = projectIdFrom(req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    write({ type: 'connected', projectId });
    const unsubscribe = subscribeRuntime(projectId, write);
    req.on('close', unsubscribe);
  }));

  return router;
};

interface SmokeOverride {
  name?: string;
  method?: string;
  url?: string;
  expectedStatus?: number;
  timeoutMs?: number;
}
