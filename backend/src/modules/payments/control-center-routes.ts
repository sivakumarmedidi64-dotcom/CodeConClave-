/**
 * CodeConClave — PRIVATE PAYMENT CONTROL CENTER.
 *
 * OBSERVABILITY FIRST. All read endpoints are GET, founder/admin + auth gated,
 * and READ canonical payment state. The ONLY write is the founder-only
 * "Verify payment with Razorpay" action (POST /verify-payment): it runs a
 * SERVER-SIDE Razorpay API verification and then funnels the result through the
 * EXISTING authority (requestAutoApproval -> applyDecision ->
 * activateEntitlement) — there is still NO dashboard endpoint that directly
 * activates, approves, force-active or grants anything, and no dashboard user
 * can write PRO_VERIFIED. Responses contain no secrets (no tokens, no
 * credentials, no raw evidence payloads); reconcile rows expose redacted
 * payment ids only.
 */
import { Router } from 'express';
import { asyncRoute } from '../../middleware/security.js';
import { requireAuth } from '../../middleware/auth.js';
import { jsonResult } from '../auth/schemas.js';
import { AppError } from '../../shared/errors.js';
import {
  assertControlCenterAccess,
  controlCenterSummary,
  controlCenterPayments,
  controlCenterPayment,
  controlCenterStats,
  controlCenterPool,
} from './control-center.js';
import { verifyPaymentWithRazorpay, listReconcileRows, reconcileCredentialStatus } from './reconcile/service.js';

export const controlCenterRoutes = (): import('express').Router => {
  const router = Router();

  router.use(requireAuth);
  router.use(async (req, res, next) => {
    try {
      await assertControlCenterAccess(req.ctx?.user ?? null);
      next();
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/payments/control-center/summary — TODAY aggregates.
  router.get(
    '/summary',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ summary: await controlCenterSummary() }));
    }),
  );

  // GET /api/v1/payments/control-center/payments — table with read-only filters.
  router.get(
    '/payments',
    asyncRoute(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
      const plan = typeof req.query.plan === 'string' ? req.query.plan : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const correlation = typeof req.query.correlation === 'string' ? req.query.correlation : undefined;
      const verification = typeof req.query.verification === 'string' ? req.query.verification : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const customer = typeof req.query.customer === 'string' ? req.query.customer : undefined;
      const paymentId = typeof req.query.paymentId === 'string' ? req.query.paymentId : undefined;
      const payments = await controlCenterPayments(
        { plan, status, correlation, verification, source, from, to, customer, paymentId },
        limit,
      );
      res.json(jsonResult({ payments }));
    }),
  );

  // GET /api/v1/payments/control-center/payments/:id — detail + verification chain.
  router.get(
    '/payments/:id',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id ?? '');
      if (!id) throw AppError.badRequest('payment_id_required', 'payment intent id is required');
      const detail = await controlCenterPayment(id);
      if (!detail) throw AppError.notFound('Payment intent');
      res.json(jsonResult(detail));
    }),
  );

  // GET /api/v1/payments/control-center/stats — aggregate stats (read-only).
  router.get(
    '/stats',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ stats: await controlCenterStats() }));
    }),
  );

  // GET /api/v1/payments/control-center/pool — READ-ONLY Payment Link-Pool
  // health (pool size, active/reserved/fulfilled links, expired reservations,
  // fulfilled intents, ambiguous/orphaned callbacks, failed signatures, replay
  // attempts, watchdog status). No manual activate/grant control.
  router.get(
    '/pool',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ pool: await controlCenterPool() }));
    }),
  );

  // GET /api/v1/payments/control-center/reconcile — READ-ONLY reconciliation
  // bookkeeping (attempt/state/due, redacted payment ids). No manual controls.
  router.get(
    '/reconcile',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ reconcile: await listReconcileRows({ limit: 200 }) }));
    }),
  );

  // GET /api/v1/payments/control-center/reconcile/credentials — presence-only
  // Razorpay API credential health (MISSING/VALID/INVALID/PRESENT). Values are
  // never returned.
  router.get(
    '/reconcile/credentials',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ credentials: await reconcileCredentialStatus() }));
    }),
  );

  // POST /api/v1/payments/control-center/verify-payment — founder-only recovery
  // action. Server-side Razorpay verification THEN the existing pipeline; never
  // a direct grant. Requires an existing intent (PENDING/REVIEW) and full
  // amount/plan/link/payer validation on a captured payment.
  router.post(
    '/verify-payment',
    asyncRoute(async (req, res) => {
      const intentId = typeof (req.body as { intentId?: unknown })?.intentId === 'string' ? (req.body as { intentId: string }).intentId.trim() : '';
      if (!/^pin_[A-Za-z0-9_-]{8,64}$/.test(intentId)) {
        throw AppError.badRequest('intent_id_required', 'a valid payment intent id (pin_…) is required');
      }
      const actor = req.ctx?.user;
      if (!actor?.id) throw AppError.forbidden('founder_only', 'founder/admin auth required');
      const outcome = await verifyPaymentWithRazorpay(intentId, actor.id);
      res.json(jsonResult({ outcome }));
    }),
  );

  return router;
};