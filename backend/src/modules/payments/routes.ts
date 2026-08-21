/**
 * CodeConClave — payments routes + webhook (Razorpay native).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  createPaymentSession,
  getSession,
  listSessions,
  handleReturn,
  verifySession,
  paymentCapability,
  getEntitlements,
  listPaymentAudit,
  logPaymentAudit,
  adminPaymentAction,
  requestPlanCancellation,
  toEntitlementJson,
  paymentStatus,
  type AdminPaymentAction,
} from './service.js';
import {
  createPaymentIntent,
  getIntent,
  listIntents,
  intentInstructions,
  sweepIntentExpiry,
} from './intents.js';
import { ingestEvidence, refreshIntentEvidence, listEvidenceForIntent } from './pipeline.js';
import { refundIntent, revokeIntent, chargebackIntent } from './activation.js';
import { resendReceipt } from './receipts.js';
import { runReconciliation, listReconciliations } from './reconciliation.js';
import { generateFounderDigest, listDigests } from './digest.js';
import { env } from '../../config/env.js';

export const paymentRoutes = (): Router => {
  const router = Router();

  // ---------------------------------------------------------------- user API
  router.use(requireAuth);

  router.get(
    '/capabilities',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult(paymentCapability()));
    }),
  );

  router.post(
    '/sessions',
    asyncRoute(async (req, res) => {
      const planId = String(req.body?.planId ?? '');
      if (!['pro', 'team'].includes(planId)) throw AppError.badRequest('invalid_plan', 'planId must be pro or team');
      const session = await createPaymentSession(req.ctx.user!.id, planId);
      res.status(201).json(
        jsonResult({
          session,
          redirectUrl: session.reference ?? null,
          capability: paymentCapability(),
          note: session.state === 'PENDING' ? 'Pending verification from payment provider.' : undefined,
        }),
      );
    }),
  );

  router.get(
    '/sessions/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ session: await getSession(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.get(
    '/sessions',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ sessions: await listSessions(req.ctx.user!.id) }));
    }),
  );

  // paid-link return; the UI redirects here after Razorpay
  router.get(
    '/sessions/:id/return',
    asyncRoute(async (req, res) => {
      const session = await handleReturn(req.ctx.user!.id, req.params.id!, String(req.query.paid ?? req.query.status ?? ''));
      res.json(jsonResult({ session, note: session.state === 'VERIFIED' ? 'Payment verified.' : 'Payment pending verification.' }));
    }),
  );

  router.get(
    '/sessions/:id/audit',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ audit: await listPaymentAudit(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.get(
    '/entitlements',
    asyncRoute(async (req, res) => {
      const rows = await getEntitlements(req.ctx.user!.id);
      res.json(jsonResult({ entitlements: rows.map(toEntitlementJson) }));
    }),
  );

  // Admin payment action — gated by the Phase 4C Approval Center. The
  // approval authorizes the action; it can never bypass payment verification.
  router.post(
    '/sessions/:id/admin',
    asyncRoute(async (req, res) => {
      const action = String(req.body?.action ?? '') as AdminPaymentAction;
      const approvalId = String(req.body?.approvalId ?? '');
      if (!['revoke', 'mark_refunded'].includes(action)) {
        throw AppError.badRequest('invalid_action', 'action must be revoke or mark_refunded');
      }
      if (!approvalId) throw AppError.badRequest('approval_required', 'approvalId is required');
      const session = await adminPaymentAction(req.ctx.user!.id, req.params.id!, action, approvalId);
      res.json(jsonResult({ session }));
    }),
  );

  // Phase 14 — downgrade/cancel foundation: creates the owner-scoped
  // PAYMENT_OP approval that the Approval Center must approve (and execute)
  // before any revocation happens. Never turns an unverified payment active.
  router.post(
    '/sessions/:id/cancel-request',
    asyncRoute(async (req, res) => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined;
      res.json(jsonResult(await requestPlanCancellation(req.ctx.user!.id, req.params.id!, reason)));
    }),
  );

  // ---------------------------------------------------- STAGE 26H intents
  router.get(
    '/status',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await paymentStatus(req.ctx.user!.id)));
    }),
  );

  router.post(
    '/intents',
    asyncRoute(async (req, res) => {
      const planId = String(req.body?.planId ?? '');
      if (!['pro', 'team'].includes(planId)) throw AppError.badRequest('invalid_plan', 'planId must be pro or team');
      const intent = await createPaymentIntent(req.ctx.user!.id, planId);
      res.status(201).json(jsonResult({ intent }));
    }),
  );

  router.get(
    '/intents',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ intents: await listIntents(req.ctx.user!.id) }));
    }),
  );

  router.get(
    '/intents/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ intent: await getIntent(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.get(
    '/intents/:id/instructions',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await intentInstructions(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.get(
    '/intents/:id/evidence',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ evidence: await listEvidenceForIntent(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // Evidence rail ingestion: source id + payload (OCR text for 'ocr', raw
  // event for 'razorpay_webhook'; ignored for passive sources).
  router.post(
    '/intents/:id/evidence',
    asyncRoute(async (req, res) => {
      const sourceId = String(req.body?.source ?? '');
      const payload = req.body?.payload ?? undefined;
      const result = await ingestEvidence(req.ctx.user!.id, req.params.id!, sourceId, payload);
      res.status(201).json(jsonResult(result));
    }),
  );

  // Refresh: pull evidence from every available passive source (gmail/api).
  router.post(
    '/intents/:id/refresh',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await refreshIntentEvidence(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.post(
    '/intents/:id/receipt',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await resendReceipt(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.post(
    '/intents/:id/refund',
    asyncRoute(async (req, res) => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : 'refund';
      res.json(jsonResult({ intent: await refundIntent(req.ctx.user!.id, req.params.id!, reason) }));
    }),
  );

  router.post(
    '/intents/:id/revoke',
    asyncRoute(async (req, res) => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : 'revoked';
      res.json(jsonResult({ intent: await revokeIntent(req.ctx.user!.id, req.params.id!, reason) }));
    }),
  );

  router.post(
    '/intents/:id/chargeback',
    asyncRoute(async (req, res) => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : 'chargeback';
      res.json(jsonResult({ intent: await chargebackIntent(req.ctx.user!.id, req.params.id!, reason) }));
    }),
  );

  // ---------------------------------------------------- STAGE 26H ops
  router.post(
    '/reconciliations',
    asyncRoute(async (req, res) => {
      res.status(201).json(jsonResult(await runReconciliation(req.ctx.user!.id)));
    }),
  );

  router.get(
    '/reconciliations',
    asyncRoute(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
      res.json(jsonResult({ reconciliations: await listReconciliations(req.ctx.user!.id, limit) }));
    }),
  );

  router.get(
    '/digest',
    asyncRoute(async (req, res) => {
      const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 90);
      res.json(jsonResult(await generateFounderDigest(req.ctx.user!.id, days)));
    }),
  );

  router.get(
    '/digests',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ digests: await listDigests(req.ctx.user!.id) }));
    }),
  );

  return router;
};

/** Razorpay webhook endpoint (enabled only when WEBHOOK mode + secret configured). */
export const paymentWebhookRoutes = (): Router => {
  const router = Router();
  router.post(
    '/razorpay',
    asyncRoute(async (req, res) => {
      if (!env.RAZORPAY_WEBHOOK_SECRET || env.RAZORPAY_MODE !== 'webhook') {
        throw AppError.notFound('Webhook not configured');
      }
      const body = JSON.stringify(req.body);
      const signature = String(req.headers['x-razorpay-signature'] ?? '');
      const { createHmac, timingSafeEqual } = await import('node:crypto');
      const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
      const signatureValid =
        signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

      const event = req.body as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } }; payment_link?: { entity?: { id?: string; notes?: Record<string, string> } } } };
      const sessionId = event.payload?.payment_link?.entity?.notes?.session_id;
      if (!sessionId) {
        res.json({ ok: false, reason: 'no_session' });
        return;
      }
      if (!signatureValid) {
        await logPaymentAudit(sessionId, null, 'webhook.signature_invalid', { event: event.event });
        res.status(400).json({ ok: false, reason: 'invalid_signature' });
        return;
      }
      await logPaymentAudit(sessionId, null, `webhook.${event.event}`, { paymentId: event.payload?.payment?.entity?.id });
      if (event.event === 'payment.captured' || event.event === 'payment_link.paid') {
        const session = (await listSessionsBySystem(sessionId))[0];
        if (session) {
          await verifySession(session.user_id, session.id, {
            source: 'WEBHOOK',
            provider_payment_id: event.payload?.payment?.entity?.id ?? event.payload?.payment_link?.entity?.id,
            provider_order_id: event.payload?.payment?.entity?.order_id,
            raw: event,
          });
        }
      }
      res.json({ ok: true });
    }),
  );
  return router;
};

async function listSessionsBySystem(sessionId: string): Promise<Array<{ id: string; user_id: string }>> {
  const { queryMany } = await import('../../shared/db.js');
  return queryMany<{ id: string; user_id: string }>('SELECT id, user_id FROM payment_sessions WHERE id = $1', [sessionId]);
}