/**
 * CodeConClave — Express application.
 * Middleware order: request context → security headers → CORS → cookies →
 * CSRF cookie → optional auth → rate limits → route groups. CSRF is enforced
 * on all state-changing API calls; webhooks and /agent/ are exempt by
 * signature/token authentication.
 */
import express from 'express';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { requestContext, requestLogger } from './middleware/context.js';
import { securityHeaders, cors, notFound, errorHandler, asyncRoute } from './middleware/security.js';
import { ensureCsrfCookie, csrfProtection } from './middleware/csrf.js';
import { optionalAuth } from './middleware/auth.js';
import { globalLimit } from './middleware/rate-limit.js';
import { authRoutes } from './modules/auth/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { teamRoutes } from './modules/teams/routes.js';
import { workspaceRoutes } from './modules/workspace/routes.js';
import { conversationRoutes, chatRoutes } from './modules/conversations/routes.js';
import { memoryRoutes } from './modules/memory/routes.js';
import { dnaRoutes } from './modules/dna/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { artifactRoutes } from './modules/artifacts/routes.js';
import { dataCentreRoutes } from './modules/datacentre/routes.js';
import { executionRoutes } from './modules/execution/routes.js';
import { paymentRoutes, paymentWebhookRoutes } from './modules/payments/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { pluginRoutes } from './modules/plugins/routes.js';
import { agentRoutes as multiAgentRoutes } from './modules/agents/routes.js';
import { schedulingRoutes } from './modules/scheduling/routes.js';
import { previewRoutes } from './modules/preview/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { ideasRoutes } from './modules/ideas/routes.js';
import { brainstormingRoutes } from './modules/brainstorming/routes.js';
import { historyRoutes } from './modules/history/routes.js';
import { recommendationsRoutes } from './modules/recommendations/routes.js';
import { trashRoutes } from './modules/trash/routes.js';
import { activityRoutes } from './modules/activity/routes.js';
import { digestRoutes } from './modules/digests/routes.js';
import { operationRoutes } from './modules/operations/routes.js';
import { automationRoutes, webhookRoutes } from './modules/automations/routes.js';
import { recoveryRoutes } from './modules/recovery/routes.js';
import { engineeringRoutes } from './modules/engineering/routes.js';
import { controlRoutes } from './modules/control/routes.js';
import { agentWs } from './modules/agent/ws.js';
import { browserRelay } from './modules/agent/browser.js';
import { agentRoutes } from './modules/agent/routes.js';
import { terminalRoutes } from './modules/terminal/routes.js';
import { remoteRoutes } from './modules/remote/routes.js';
import { registerCoreTools } from './modules/execution/tools.js';
import { storage } from './integrations/storage.js';
import { logger } from './shared/logger.js';
import { env } from './config/env.js';
import { computeHealth } from './health/health.js';
import { apiLatency } from './middleware/perf.js';
import type { Server } from 'node:http';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === 'true');
  app.use(requestContext);
  app.use(securityHeaders);
  app.use(cors);
  app.use(requestLogger);
  app.use(cookieParser());
  app.use(ensureCsrfCookie);
  app.use(
    express.json({
      limit: '2mb',
      type: ['application/json', 'application/*+json'],
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  // Stage 26D: inbound webhooks must see the RAW body for HMAC verification —
  // consume the stream as a Buffer for /api/v1/webhooks/* before the JSON parser.
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '2mb' }));
  app.use(optionalAuth);
  app.use(csrfProtection);

  app.get('/health', asyncRoute(async (_req: Request, res: Response) => {
    const health = await computeHealth();
    // Backward-compatible envelope + honest state labels (never secrets).
    res.json({
      ok: health.ok,
      name: health.name,
      provider: storage.kind,
      queue: env.QUEUE_PROVIDER,
      time: health.time,
      status: health.status,
      checks: health.checks,
    });
  }));

  // Phase 18: liveness — the process is up and answering. No dependency checks.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Phase 18: readiness — load balancers / orchestrators should only route
  // traffic here when core dependencies are up. FAILED (e.g. database down)
  // returns 503; DEGRADED/NOT_CONFIGURED providers stay ready but are
  // reported honestly in the body and via /health.
  app.get('/ready', asyncRoute(async (_req: Request, res: Response) => {
    const health = await computeHealth();
    const ready = health.status !== 'FAILED';
    res.status(ready ? 200 : 503).json({
      ok: ready,
      status: health.status,
      checks: health.checks,
    });
  }));

  app.use('/api/v1', globalLimit());
  // Phase 16: per-route API latency (route pattern only — never user content).
  app.use(apiLatency());
  app.use('/api/v1/auth', authRoutes());
  app.use('/api/v1/projects', projectRoutes());
  app.use('/api/v1/teams', teamRoutes());
  app.use('/api/v1/workspace', workspaceRoutes());
  app.use('/api/v1/conversations/chat', chatRoutes()); // SSE chat (must precede conversationRoutes)
  app.use('/api/v1/conversations', conversationRoutes());
  app.use('/api/v1/memory', memoryRoutes());
  app.use('/api/v1/dna', dnaRoutes());
  app.use('/api/v1/ai', aiRoutes());
  app.use('/api/v1/files', fileRoutes());
  app.use('/api/v1/search', searchRoutes());
  app.use('/api/v1/artifacts', artifactRoutes());
  app.use('/api/v1/data-centre', dataCentreRoutes());
  app.use('/api/v1/execution', executionRoutes());
  app.use('/api/v1/payments', paymentRoutes());
  app.use('/api/v1/payments/webhook', paymentWebhookRoutes());
  app.use('/api/v1/notifications', notificationRoutes());
  app.use('/api/v1/plugins', pluginRoutes());
  app.use('/api/v1/agents', multiAgentRoutes());
  app.use('/api/v1/scheduling', schedulingRoutes());
  app.use('/api/v1/preview', previewRoutes());
  app.use('/api/v1/audit', auditRoutes());
  app.use('/api/v1/ideas', ideasRoutes());
  app.use('/api/v1/brainstorming', brainstormingRoutes());
  app.use('/api/v1/history', historyRoutes());
  app.use('/api/v1/cleanup', recommendationsRoutes());
  app.use('/api/v1/trash', trashRoutes());
  app.use('/api/v1/activity', activityRoutes());
  app.use('/api/v1/digests', digestRoutes());
  app.use('/api/v1/operations', operationRoutes());
  app.use('/api/v1/automations', automationRoutes());
  app.use('/api/v1/webhooks', webhookRoutes());
  app.use('/api/v1/recovery', recoveryRoutes());
  app.use('/api/v1/engineering', engineeringRoutes());
  app.use('/api/v1/control', controlRoutes());
  app.use('/api/v1/agent', agentRoutes());
  app.use('/api/v1/terminal', terminalRoutes());
  app.use('/api/v1/remote', remoteRoutes());

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/** Attach the Local Agent WebSocket hub (upgrade path for /agent). */
export function attachAgentHub(server: Server): void {
  const hub = agentWs();
  const relay = browserRelay();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/agent') {
      hub.handleUpgrade(req, socket, head);
      return;
    }
    if (url.pathname === '/agent-browser') {
      relay.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });
  logger.info('agent ws hub attached (/agent, /agent-browser)');
}

let toolsRegistered = false;
export function ensureTools(): void {
  if (!toolsRegistered) {
    registerCoreTools();
    toolsRegistered = true;
  }
}