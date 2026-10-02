/**
 * CodeConClave — PAYMENT LINK-POOL routes (POLICY B).
 *
 * Two routers:
 *   poolRoutes()            authenticated intent + heartbeat + status
 *   poolCallbackRoutes()    unauthenticated provider callback (HMAC-verified)
 *
 * The callback MUST be mounted OUTSIDE the auth-gated /api/v1/payments router
 * (which enforces requireAuth first), like paymentWebhookRoutes / gmailClaimRoutes.
 */
import { Router } from 'express';
import { jsonResult } from '../../auth/schemas.js';
import { requireAuth } from '../../../middleware/auth.js';
import { asyncRoute } from '../../../middleware/security.js';
import { AppError } from '../../../shared/errors.js';
import { assignLink, heartbeat, getIntentStatus, poolEnabled } from './service.js';
import { handlePoolCallback } from './callback.js';

export const poolRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ enabled: poolEnabled() }));
    }),
  );

  // POST /intent — authenticated checkout: create intent + atomically reserve a link.
  router.post(
    '/intent',
    asyncRoute(async (req, res) => {
      if (!poolEnabled()) throw AppError.conflict('pool_disabled', 'Payment link pool is not enabled');
      const planId = String(req.body?.planId ?? '');
      if (!['pro', 'team', 'api'].includes(planId)) throw AppError.badRequest('invalid_plan', 'planId must be pro, team or api');
      const userId = req.ctx.user!.id;
      const workspaceId = String(req.body?.workspaceId ?? '') || null;
      const clientIp = req.ctx.ip ?? null;
      const sessionId = String(req.body?.sessionId ?? '') || null;
      const result = await assignLink(userId, workspaceId, planId, { sessionId, clientIp });
      res.status(201).json(jsonResult({ intent: result }));
    }),
  );

  // POST /heartbeat — authenticated telemetry refresh (NEVER grants entitlement).
  router.post(
    '/heartbeat',
    asyncRoute(async (req, res) => {
      const intentId = String(req.body?.intentId ?? '');
      if (!intentId) throw AppError.badRequest('intent_required', 'intentId is required');
      const result = await heartbeat(
        req.ctx.user!.id,
        intentId,
        String(req.body?.sessionId ?? '') || null,
        req.ctx.ip ?? null,
      );
      res.json(jsonResult(result));
    }),
  );

  // GET /status/:intentId — authenticated + ownership-checked.
  router.get(
    '/status/:intentId',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ status: await getIntentStatus(req.ctx.user!.id, req.params.intentId!) }));
    }),
  );

  return router;
};

/**
 * Unauthenticated provider callback. Authentication is the HMAC signature, so
 * the route itself is public. It stays server-authoritative: only a correctly
 * signed + fully validated payment can reach activation.ts.
 */
export const poolCallbackRoutes = (): Router => {
  const router = Router();
  router.get(
    '/:linkIndex',
    asyncRoute(async (req, res) => {
      if (!poolEnabled()) {
        res.status(404).json({ ok: false, reason: 'pool_disabled' });
        return;
      }
      const result = await handlePoolCallback(req.params.linkIndex!, (req.query ?? {}) as Record<string, unknown>);
      const statusByOutcome: Record<string, number> = {
        accepted: 200,
        duplicate: 200,
        bad_link_index: 404,
        link_disabled: 409,
        link_id_mismatch: 400,
        reference_mismatch: 400,
        bad_status: 400,
        no_reservation: 404,
        reservation_expired: 410,
        reservation_released: 410,
        reservation_fulfilled: 409,
        intent_not_found: 404,
        intent_plan_mismatch: 400,
        amount_mismatch: 400,
        currency_mismatch: 400,
        ownership_revoked: 403,
        fraud_blocked: 409,
        orphaned: 404,
        ambiguous: 409,
        invalid_signature: 401,
      };
      res.status(statusByOutcome[result.outcome] ?? 400).json({ ok: result.activated, outcome: result.outcome, reason: result.reason });
    }),
  );
  return router;
};
