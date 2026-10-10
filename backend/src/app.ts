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
import { apiKeyAuth } from './middleware/api-key-auth.js';
import { requireWorkspaceEntitlement } from './middleware/entitlement.js';
import { globalLimit } from './middleware/rate-limit.js';
import { accessRoutes } from './modules/access/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { teamRoutes } from './modules/teams/routes.js';
import { teamCollabRoutes } from './modules/teamcollab/routes.js';
import { workspaceRoutes } from './modules/workspace/routes.js';
import { conversationRoutes, chatRoutes } from './modules/conversations/routes.js';
import { memoryRoutes } from './modules/memory/routes.js';
import { memoryCodingRoutes } from './modules/memorycoding/routes.js';
import { copilotRoutes } from './modules/copilot/routes.js';
import { autonomyRoutes } from './modules/autonomy/routes.js';
import { dnaRoutes } from './modules/dna/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { artifactRoutes } from './modules/artifacts/routes.js';
import { dataCentreRoutes } from './modules/datacentre/routes.js';
import { executionRoutes } from './modules/execution/routes.js';
import { paymentRoutes, paymentWebhookRoutes } from './modules/payments/routes.js';
import { founderRoutes } from './modules/payments/founder/routes.js';
import { poolRoutes, poolCallbackRoutes } from './modules/payments/pool/routes.js';
import { controlCenterRoutes } from './modules/payments/control-center-routes.js';
import { gmailClaimRoutes } from './modules/payments/gmail-claim-routes.js';
import { imapUnlockRoutes } from './modules/payments/imap-unlock/routes.js';
import { demoPaymentRoutes } from './modules/payments/demo-routes.js';
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
import { apiKeyRoutes } from './modules/apikeys/routes.js';
import { workspaceShareRoutes } from './modules/workspace/shares-routes.js';
import { automationRoutes, webhookRoutes } from './modules/automations/routes.js';
import { recoveryRoutes } from './modules/recovery/routes.js';
import { engineeringRoutes } from './modules/engineering/routes.js';
import { controlRoutes } from './modules/control/routes.js';
import { engineeringIntelligenceRoutes } from './modules/engineering-intelligence/routes.js';
import { securityIntelligenceRoutes } from './modules/security-intelligence/routes.js';
import { developerProductivityRoutes } from './modules/developer-productivity/routes.js';
import { productionIntelligenceRoutes } from './modules/production-intelligence/routes.js';
import { deploymentWizardRoutes } from './modules/deployment-wizard/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { agentWs } from './modules/agent/ws.js';
import { startLocalRecoverySweep } from './modules/agent/dispatch.js';
import { browserRelay } from './modules/agent/browser.js';
import { agentRoutes } from './modules/agent/routes.js';
import { reviewRoutes } from './modules/reviews/routes.js';
import { codeWorkspaceRoutes } from './modules/codeworkspace/routes.js';
import { superpowerRoutes } from './modules/superpowers/routes.js';
import { registerKnownRoutes } from './modules/superpowers/specs.js';
import { terminalRoutes } from './modules/terminal/routes.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { visualIntelligenceRoutes } from './modules/visual-intelligence/routes.js';
import { qualityIntelligenceRoutes } from './modules/quality-intelligence/routes.js';
import { securityOperationsRoutes } from './modules/security-operations-intelligence/routes.js';
import { optimizationIntelligenceRoutes } from './modules/optimization-intelligence/routes.js';
import { developerWorkflowRoutes } from './modules/developer-workflow/routes.js';
import { runtimeRoutes } from './modules/runtime/routes.js';
import { environmentRoutes } from './modules/environment/routes.js';
import { releaseRoutes } from './modules/release/routes.js';
import { integrationHubRoutes } from './modules/integration-hub/routes.js';
import { kubernsRoutes } from './modules/kuberns/routes.js';
import { actionRoutes } from './modules/actions/routes.js';
import { localWorkspaceRoutes } from './modules/local-workspace/routes.js';
import { remoteRoutes } from './modules/remote/routes.js';
import { registerCoreTools } from './modules/execution/tools.js';
import { storage } from './integrations/storage.js';
import { logger } from './shared/logger.js';
import { env, trustProxyModel } from './config/env.js';
import { computeHealth } from './health/health.js';
import { apiLatency } from './middleware/perf.js';
import { mountSwagger } from './docs/swagger.js';
import { healthRoutes } from './health/routes.js';
import { desktopDownloadRoutes } from './modules/downloads/routes.js';
import { spaMiddleware } from './static/spa.js';
import { toExpressTrustProxy } from './config/trust-proxy.js';
import type { Server } from 'node:http';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', toExpressTrustProxy(trustProxyModel));
  app.use(requestContext);
  app.use(securityHeaders);
  app.use(cors);
  app.use(requestLogger);
  app.use(cookieParser());
  app.use(ensureCsrfCookie);
  // Stage 26H: the Razorpay payment webhook must verify a signature over the
  // RAW bytes, so consume the stream as a Buffer BEFORE the global JSON parser
  // for /api/v1/payments/webhook/* (global parser then skips via req._body).
  app.use('/api/v1/payments/webhook', express.raw({ type: '*/*', limit: '2mb' }));
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

  /**
 * @openapi
 * /health:
 *   get:
 *     summary: Comprehensive health check
 *     description: Returns detailed health status including database, Redis, and external service checks
 *     tags: [Health]
 *     responses:
 *       '200':
 *         description: Health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 name:
 *                   type: string
 *                 provider:
 *                   type: string
 *                 queue:
 *                   type: string
 *                 time:
 *                   type: string
 *                   format: date-time
 *                 status:
 *                   type: string
 *                 checks:
 *                   type: object
 *       '503':
 *         description: Service unhealthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   enum: [false]
 *                 status:
 *                   type: string
 *                 checks:
 *                   type: object
 */
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

  /**
   * @openapi
   * /healthz:
 *   get:
 *     summary: Liveness probe
 *     description: Simple liveness check - returns 200 if process is alive
 *     tags: [Health]
 *     responses:
 *       '200':
 *         description: Service is alive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   enum: [true]
 */
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

  // Swagger/OpenAPI Documentation
  mountSwagger(app);

  // Deep health check endpoint
  app.use('/api/v1', healthRoutes());

  // Public desktop installer download (+ info) for the marketing landing page.
  app.use('/api/v1/downloads', desktopDownloadRoutes());

  app.use('/api/v1', globalLimit());
  // Phase 16: per-route API latency (route pattern only — never user content).
  app.use(apiLatency());
  app.use('/api/v1/auth', authRoutes());
  // Entry gate: ungated authenticated status so clients can route to Billing
  // vs the workspace (server remains authoritative for the actual gates below).
  app.use('/api/v1/access', accessRoutes());

  // NO FREE TIER — every vendor-listed workspace router behind this comment is
  // mounted ONLY behind requireWorkspaceEntitlement(): an authenticated user
  // must hold an ACTIVE VERIFIED paid entitlement (Solo/Team). Payment rail
  // routers (payments/*, /cb, /api/pay/pool, founder, control-center), the AI
  // API (/api/v1/ai — its own apiKeyAuth 402 gate), apikeys and admin are not
  // mounted here because they enforce their own, stricter, gates.
  const paid = requireWorkspaceEntitlement();
  app.use('/api/v1/projects', paid, projectRoutes());
  // `paid` accepts Solo OR Team. Team collaboration is a distinct, higher-priced
  // product, so teamRoutes() additionally gates every escalatory endpoint on
  // the Team plan itself (see requireTeamPlan in modules/teams/routes.ts).
  app.use('/api/v1/teams', paid, teamRoutes());
  // teamcollab is deliberately NOT behind requireTeamPlan. Its entitlement
  // belongs to the TEAM, not to the caller: only a Team-plan account can create
  // a team, and every /:teamId handler re-resolves the caller's membership and
  // role through teams/service.requireTeamRole on each call (fails closed). A
  // Solo user here is necessarily an invited member of somebody's team, and
  // gating on their own plan would charge them twice for one seat and break
  // presence/handoff for the very members Team is sold to. What must stay
  // blocked is CREATING the team, which is gated in modules/teams/routes.ts.
  app.use('/api/v1/teamcollab', paid, teamCollabRoutes());
  app.use('/api/v1/workspace', workspaceShareRoutes());
  app.use('/api/v1/workspace', paid, workspaceRoutes());
  app.use('/api/v1/conversations/chat', paid, chatRoutes()); // SSE chat (must precede conversationRoutes)
  app.use('/api/v1/conversations', paid, conversationRoutes());
  app.use('/api/v1/memory', paid, memoryRoutes());
  app.use('/api/v1/memorycoding', paid, memoryCodingRoutes());
  app.use('/api/v1/copilot', paid, copilotRoutes());
  app.use('/api/v1/autonomy', paid, autonomyRoutes());
  app.use('/api/v1/dna', paid, dnaRoutes());
  // The AI API routes are the ONE choke point external (Bearer cc_live_* key)
  // clients use. apiKeyAuth gates them per key: authentication, the ₹9,999 API
  // Access entitlement (402 if absent) and STRICT per-key rate limits (window,
  // daily, concurrency). Requests without a Bearer key pass through unchanged
  // (session flow) and the gateway's own entitlement check covers those.
  app.use('/api/v1/ai', apiKeyAuth(), aiRoutes());
  app.use('/api/v1/files', paid, fileRoutes());
  app.use('/api/v1/search', paid, searchRoutes());
  app.use('/api/v1/artifacts', paid, artifactRoutes());
  app.use('/api/v1/data-centre', paid, dataCentreRoutes());
  app.use('/api/v1/execution', paid, executionRoutes());
  app.use('/api/v1/payments/webhook', paymentWebhookRoutes());
  app.use('/api/v1/payments/gmail-claim', gmailClaimRoutes());
  app.use('/api/v1/payments/imap-unlock', imapUnlockRoutes());
  app.use('/api/v1/payments/demo', demoPaymentRoutes());
  app.use('/api/v1/payments', paymentRoutes());
  app.use('/api/v1/payments/control-center', controlCenterRoutes());
  app.use('/api/v1/founder', founderRoutes());
  // Payment Link-Pool (POLICY B): /cb is the unauthenticated provider callback
  // (HMAC-verified), mounted outside any auth-gated router; /api/pay/pool is the
  // authenticated intent/heartbeat/status API.
  app.use('/cb', poolCallbackRoutes());
  app.use('/api/pay/pool', poolRoutes());
  app.use('/api/v1/notifications', paid, notificationRoutes());
  app.use('/api/v1/plugins', paid, pluginRoutes());
  app.use('/api/v1/knowledge', paid, knowledgeRoutes());
  app.use('/api/v1/visual-intelligence', paid, visualIntelligenceRoutes());
  app.use('/api/v1/quality-intelligence', paid, qualityIntelligenceRoutes());
  app.use('/api/v1/security-operations', paid, securityOperationsRoutes());
  app.use('/api/v1/optimization-intelligence', paid, optimizationIntelligenceRoutes());
  app.use('/api/v1/developer-workflow', paid, developerWorkflowRoutes());
  app.use('/api/v1/runtime', paid, runtimeRoutes());
  app.use('/api/v1/environment', paid, environmentRoutes());
  app.use('/api/v1/release', paid, releaseRoutes());
  app.use('/api/v1/integrations', paid, integrationHubRoutes());
  app.use('/api/v1/kuberns', paid, kubernsRoutes());
  app.use('/api/v1/actions', paid, actionRoutes());
  app.use('/api/v1/local-workspace', paid, localWorkspaceRoutes());
  app.use('/api/v1/agents', paid, multiAgentRoutes());
  app.use('/api/v1/scheduling', paid, schedulingRoutes());
  app.use('/api/v1/preview', paid, previewRoutes());
  app.use('/api/v1/audit', paid, auditRoutes());
  app.use('/api/v1/ideas', paid, ideasRoutes());
  app.use('/api/v1/brainstorming', paid, brainstormingRoutes());
  app.use('/api/v1/history', paid, historyRoutes());
  app.use('/api/v1/cleanup', paid, recommendationsRoutes());
  app.use('/api/v1/trash', paid, trashRoutes());
  app.use('/api/v1/activity', paid, activityRoutes());
  app.use('/api/v1/digests', paid, digestRoutes());
  app.use('/api/v1/operations', paid, operationRoutes());
  app.use('/api/v1/apikeys', apiKeyRoutes());
  app.use('/api/v1/automations', paid, automationRoutes());
  app.use('/api/v1/webhooks', webhookRoutes());
  app.use('/api/v1/recovery', paid, recoveryRoutes());
  app.use('/api/v1/admin', adminRoutes());
  app.use('/api/v1/engineering', paid, engineeringRoutes());
  app.use('/api/v1/engineering-intelligence', paid, engineeringIntelligenceRoutes());
  app.use('/api/v1/security-intelligence', paid, securityIntelligenceRoutes());
  app.use('/api/v1/developer-productivity', paid, developerProductivityRoutes());
  app.use('/api/v1/production-intelligence', paid, productionIntelligenceRoutes());
  app.use('/api/v1/deployment-wizard', paid, deploymentWizardRoutes());
  app.use('/api/v1/control', paid, controlRoutes());
  // Local Agent surface. NOT behind `paid`: `requireWorkspaceEntitlement()`
  // rejects any request without `req.ctx.user`, but POST /pair is called by the
  // CLI, which has no browser session — so the gate made pairing permanently
  // unreachable (401) regardless of entitlement. The router authenticates each
  // route itself: /pair by the 6-digit pairing code + attempt cap, /status by
  // requireAuth. Neither route returns workspace/project data.
  app.use('/api/v1/agent', agentRoutes());
  app.use('/api/v1/terminal', paid, terminalRoutes());
  app.use('/api/v1/remote', paid, remoteRoutes());
  app.use('/api/v1/reviews', paid, reviewRoutes());
  app.use('/api/v1/codeworkspace', paid, codeWorkspaceRoutes());
  app.use('/api/v1/superpowers', paid, superpowerRoutes());

  // ENDPOINT specs are checked against the REAL route table (Spec Linter).
  registerKnownRoutes([
    '/api/v1/auth', '/api/v1/projects', '/api/v1/teams', '/api/v1/teamcollab',
    '/api/v1/workspace', '/api/v1/conversations', '/api/v1/memory', '/api/v1/memorycoding',
    '/api/v1/copilot', '/api/v1/autonomy', '/api/v1/dna', '/api/v1/ai', '/api/v1/ai/chat/completions', '/api/v1/files',
    '/api/v1/search', '/api/v1/artifacts', '/api/v1/data-centre', '/api/v1/execution',
    '/api/v1/payments/webhook', '/api/v1/payments', '/api/v1/payments/control-center', '/api/v1/founder',
    '/api/v1/notifications', '/api/v1/plugins', '/api/v1/knowledge',
    '/api/v1/visual-intelligence', '/api/v1/quality-intelligence', '/api/v1/security-operations',
    '/api/v1/optimization-intelligence', '/api/v1/developer-workflow', '/api/v1/runtime',
    '/api/v1/environment', '/api/v1/release', '/api/v1/integrations', '/api/v1/agents',
    '/api/v1/scheduling', '/api/v1/preview', '/api/v1/audit', '/api/v1/ideas',
    '/api/v1/brainstorming', '/api/v1/history', '/api/v1/cleanup', '/api/v1/trash',
    '/api/v1/activity', '/api/v1/digests', '/api/v1/operations', '/api/v1/automations',
    '/api/v1/webhooks', '/api/v1/recovery', '/api/v1/admin', '/api/v1/engineering',
    '/api/v1/apikeys',
    '/api/v1/engineering-intelligence', '/api/v1/security-intelligence',
    '/api/v1/developer-productivity', '/api/v1/production-intelligence',
    '/api/v1/deployment-wizard', '/api/v1/control', '/api/v1/agent', '/api/v1/terminal',
    '/api/v1/remote', '/api/v1/reviews', '/api/v1/codeworkspace', '/api/v1/superpowers',
    '/api/v1/apikeys',
  ]);

  // Built-in SPA host (OPT-IN): serves frontend/dist when it exists in the
  // image, so the website and the API share one production origin. Without a
  // bundle it is a no-op and the notFound handler below still wins.
  app.use(spaMiddleware);

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
  // P0 local execution fabric: lease-expiry recovery (no-op unless enabled).
  startLocalRecoverySweep();
}

let toolsRegistered = false;
export function ensureTools(): void {
  if (!toolsRegistered) {
    registerCoreTools();
    toolsRegistered = true;
  }
}