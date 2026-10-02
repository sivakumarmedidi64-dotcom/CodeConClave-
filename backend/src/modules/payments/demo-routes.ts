/**
 * CodeConClave — DEMO PAYMENT routes (redirect-only; strictly non-production).
 *
 * Mounted at /api/v1/payments/demo, BEHIND requireAuth + CSRF (browser-cookie
 * authenticated). Every handler re-checks the hard server-side production
 * guard; in production each endpoint returns 403 demo_mode_disabled with the
 * message "Redirect-only payment verification is disabled in production."
 *
 *   POST /session      — create a short-lived HMAC-signed demo session
 *   GET  /return?s=..  — validate signed session; issue one-time activation
 *                        token; enqueue DEMO-labeled email; return confirm URL
 *   POST /activate     — consume one-time token (email ownership proof only);
 *                        record DEMO_REDIRECT / is_real_payment=false
 *
 * NOTHING here is payment verification. An email click proves email ownership
 * only. There is no production entitlement and no "payment verified" state.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';
import { enqueueOutbox } from '../outbox/service.js';
import { wrapEmailHtml } from '../email/brand.js';
import {
  demoModeEnabled,
  demoGuardError,
  createDemoSession,
  verifyDemoSessionToken,
  issueDemoActivation,
  consumeDemoActivation,
  DEMO_VERIFICATION_METHOD,
  toDemoActivationView,
  type DemoPlan,
} from './demo.js';

const DEMO_ROUTE_BASE = '/api/v1/payments/demo';

function reqBaseUrl(): string {
  return env.API_URL || env.APP_URL || 'http://localhost:3000';
}

async function sendDemoActivationEmail(email: string, plan: DemoPlan, amountInr: number, activationUrl: string): Promise<void> {
  const subject = `[DEMO MODE — NO REAL PAYMENT] CodeConClave ${plan.toUpperCase()} activation (test only)`;
  const html = wrapEmailHtml(
    `[DEMO MODE — NO REAL PAYMENT] ${plan.toUpperCase()} activation (test only)`,
    [
      `<p><strong>DEMO / TEST environment. This is NOT a real payment and does NOT verify a payment.</strong></p>`,
      `<p>Intended plan: <strong>${plan.toUpperCase()}</strong> (₹${amountInr.toLocaleString('en-IN')}).</p>`,
      `<p>Clicking the link proves you own this email address. It does NOT prove you paid.</p>`,
      `<p><a href="${activationUrl}" style="display:inline-block;padding:12px 24px;background:#f59e0b;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">DEMO ACTIVATION LINK (TEST)</a></p>`,
      `<p>This link is single-use and expires in ${Math.round(env.DEMO_ACTIVATION_TTL_SECONDS / 60)} minutes.</p>`,
      `<p>If you did not request this, ignore this email. No charge has been made.</p>`,
    ].join('\n'),
  );

  await enqueueOutbox('payment.demo_activation_email', {
    channel: 'email',
    to: email,
    subject,
    html,
  }, { dedupeKey: `demo_activation_email:${email}:${plan}` });
}

export const demoPaymentRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  // Alias checked per request — a client can never enable this in production.
  router.use((_req, _res, next) => {
    next();
  });

  /**
   * POST /session — create a signed demo session for the authenticated user.
   */
  router.post(
    '/session',
    asyncRoute(async (req, res) => {
      if (!demoModeEnabled(req.ctx.user!.email)) throw demoGuardError();
      const planId = String(req.body?.planId ?? '');
      if (!['pro', 'team'].includes(planId)) throw AppError.badRequest('invalid_plan', 'planId must be pro or team');
      const { token, claims } = createDemoSession(req.ctx.user!.id, req.ctx.user!.email, planId as DemoPlan);
      await recordAudit({
        action: 'payment.demo_session_created',
        actorUserId: req.ctx.user!.id,
        scope: 'SYSTEM',
        resourceType: 'payment_session',
        detail: { plan: claims.plan, demo: true, method: DEMO_VERIFICATION_METHOD },
      });
      res.status(201).json(
        jsonResult({
          demo: true,
          method: DEMO_VERIFICATION_METHOD,
          is_real_payment: false,
          sessionToken: token,
          expiresAt: claims.expiresAt,
          plan: claims.plan,
          amountInr: claims.amountInr,
          // The signed session is NOT a redirect target; it is exchanged for a
          // demo "return" that issues the one-time activation token.
          returnUrl: `${DEMO_ROUTE_BASE}/return`,
          note: 'DEMO MODE — NO REAL PAYMENT VERIFICATION.',
        }),
      );
    }),
  );

  /**
   * GET /return?s=<signed> — validate the signed demo session, issue a one-time
   * activation token, email the DEMO-labeled activation link, then hand back a
   * confirmation payload. The returned activation token is distinct from the
   * signed session and is consumed exactly once on /activate.
   */
  router.get(
    '/return',
    asyncRoute(async (req, res) => {
      if (!demoModeEnabled(req.ctx.user!.email)) throw demoGuardError();
      const s = String(req.query.s ?? '');
      if (!s) throw AppError.badRequest('demo_session_required', 's is required');
      const session = verifyDemoSessionToken(s, { userId: req.ctx.user!.id, email: req.ctx.user!.email });
      const { activationUrl, view } = await issueDemoActivation(session, reqBaseUrl());
      await recordAudit({
        action: 'payment.demo_activation_issued',
        actorUserId: req.ctx.user!.id,
        scope: 'SYSTEM',
        resourceType: 'payment_evidence',
        detail: { method: DEMO_VERIFICATION_METHOD, demo: true, plan: view.plan },
      });
      await sendDemoActivationEmail(view.email, view.plan, view.amountInr, activationUrl);
      res.json(
        jsonResult({
          demo: true,
          method: DEMO_VERIFICATION_METHOD,
          is_real_payment: false,
          status: 'DEMO_PENDING',
          activationUrl,
          activation: view,
          note: 'DEMO ACTIVATION EMAIL SENT — NO REAL PAYMENT VERIFICATION. Clicking the link proves email ownership only.',
        }),
      );
    }),
  );

  /**
   * POST /activate — consume the one-time activation token. Proves email
   * ownership only. Records DEMO_REDIRECT / is_real_payment=false. Never a
   * production entitlement and never "payment verified".
   */
  router.post(
    '/activate',
    asyncRoute(async (req, res) => {
      if (!demoModeEnabled(req.ctx.user!.email)) throw demoGuardError();
      const token = String(req.body?.token ?? '');
      if (!token) throw AppError.badRequest('invalid_token', 'token is required');
      const record = await consumeDemoActivation(token, { userId: req.ctx.user!.id, email: req.ctx.user!.email });
      await recordAudit({
        action: 'payment.demo_activated',
        actorUserId: req.ctx.user!.id,
        scope: 'SYSTEM',
        resourceType: 'payment_claim',
        detail: { method: DEMO_VERIFICATION_METHOD, demo: true, plan: record.plan, is_real_payment: false },
      });
      res.json(
        jsonResult({
          demo: true,
          method: DEMO_VERIFICATION_METHOD,
          is_real_payment: false,
          status: 'DEMO_ACTIVATED',
          activation: toDemoActivationView(record),
          note: 'DEMO ACTIVATION COMPLETE — NO REAL PAYMENT VERIFIED. This is a test-flow activation only.',
        }),
      );
    }),
  );

  return router;
};
