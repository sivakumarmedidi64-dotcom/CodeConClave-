/**
 * CodeConClave — payments routes + webhook (Razorpay native).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { withSystem, withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { NotificationType } from '@codeconclave/shared';
import { notify } from '../notifications/service.js';
import {
  createPaymentSession,
  getSession,
  listSessions,
  handleReturn,
  paymentCapability,
  getEntitlements,
  listPaymentAudit,
  adminPaymentAction,
  requestPlanCancellation,
  toEntitlementJson,
  paymentStatus,
  revokeEntitlement,
  type AdminPaymentAction,
} from './service.js';
import {
  createPaymentIntent,
  getIntent,
  listIntents,
  intentInstructions,
  sweepIntentExpiry,
} from './intents.js';
import { ingestEvidence, refreshIntentEvidence, listEvidenceForIntent, isUserAssertableEvidenceSource } from './pipeline.js';
// refundIntent / revokeIntent / chargebackIntent are intentionally NOT imported
// here: they are provider-driven and reachable only from the signed webhook and
// admin paths, never from a customer-authenticated request. See the comment at
// the old /intents/:id/refund route.
import { resendReceipt } from './receipts.js';
import { runReconciliation, listReconciliations } from './reconciliation.js';
import { generateFounderDigest, listDigests } from './digest.js';
import { submitPaymentClaim, listUserClaims, getUserClaim } from './claims/service.js';
import { resolveAutopilotIntent, autopilotSignalPayload } from './autopilot/service.js';
import { requestAutoApproval, type ApprovalSignalPayload } from './autoapproval/service.js';
import { env } from '../../config/env.js';
import {
  selfServiceEnabled,
  checkPaymentConfirmation,
  issueOwnershipConfirmationToken,
  redeemOwnershipConfirmationToken,
} from './self-service.js';

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
      if (!['pro', 'team', 'api'].includes(planId)) throw AppError.badRequest('invalid_plan', 'planId must be pro, team or api');
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
      if (!['pro', 'team', 'api'].includes(planId)) throw AppError.badRequest('invalid_plan', 'planId must be pro, team or api');
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

  // Evidence rail ingestion: ONLY user-asserted sources ('ocr', 'manual').
  // Server-driven sources (razorpay_webhook / razorpay_callback /
  // razorpay_autopilot / gmail / gmail_imap / razorpay_api) are rejected here:
  // their collect() functions anchor the intent's own reference and would
  // treat user-supplied JSON as provider truth, allowing self-activation
  // without payment. They are ingested exclusively via their internal
  // callers (signed webhook handler, pool callback, autopilot sweep,
  // IMAP poller, refresh).
  router.post(
    '/intents/:id/evidence',
    asyncRoute(async (req, res) => {
      const sourceId = String(req.body?.source ?? '');
      if (!isUserAssertableEvidenceSource(sourceId)) {
        throw AppError.forbidden(
          'evidence_source_not_user_assertable',
          `Evidence source '${sourceId || '(missing)'}' cannot be submitted directly; it is ingested server-side only`,
        );
      }
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

  // Security fix: refund / revoke / chargeback are PROVIDER-DRIVEN lifecycle
  // events, not customer actions. These routes previously let any authenticated
  // user POST them for their own intent, which meant:
  //   - a user could flip their own entitlement to PRO_REFUNDED / REVOKED at will
  //     and corrupt the revenue record (and the founder's reconciliation mirror),
  //   - `chargeback` was reachable by any user who could guess an intent id that
  //     happened to carry provider evidence, because the only guard was the
  //     evidence row, never the caller's authority,
  //   - the intent state machine accepted a client-asserted transition that
  //     provider evidence had not caused.
  // They are now server-only. The signed Razorpay webhook, the Razorpay API
  // reconciliation path, and admin tooling call the activation service
  // directly. There is no customer-facing route, by design.

  // ---------------------------------------------------- MANUAL CLAIMS (UNLOCK_MODE=MANUAL)
  // The user pays the static payment link for their intent, then submits the
  // REAL Razorpay Payment ID. Server derives plan/purchase/amount from the
  // authenticated intent; an admin approves/rejects on the Admin page.
  router.post(
    '/claims',
    asyncRoute(async (req, res) => {
      const intentId = String(req.body?.intentId ?? '');
      if (!intentId) throw AppError.badRequest('intent_required', 'intentId is required');
      res.status(201).json(
        jsonResult({ claim: await submitPaymentClaim(req.ctx.user!.id, intentId, req.body?.paymentId) }),
      );
    }),
  );

  router.get(
    '/claims',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ claims: await listUserClaims(req.ctx.user!.id) }));
    }),
  );

  router.get(
    '/claims/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ claim: await getUserClaim(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ---------------------------------------------------- SELF-SERVICE (CONDITIONAL, flag-gated)
  // All endpoints behind requireAuth (router.use(requireAuth) above). Only active
  // when AIOS_PAYMENT_SELF_SERVICE=true; otherwise a conflict is returned and no
  // behavior changes. Fail-closed: never promotes weak evidence, never bypasses
  // the authoritative entitlement gate, binds every token to the authenticated
  // account + intent + plan.
  router.get(
    '/self-service',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ enabled: selfServiceEnabled() }));
    }),
  );

  router.post(
    '/self-service/check',
    asyncRoute(async (req, res) => {
      const intentId = String(req.body?.intentId ?? '');
      if (!intentId) throw AppError.badRequest('intent_required', 'intentId is required');
      const baseUrl = env.APP_URL ?? '';
      res.json(jsonResult({ result: await checkPaymentConfirmation(req.ctx.user!.id, intentId, baseUrl) }));
    }),
  );

  router.post(
    '/self-service/email',
    asyncRoute(async (req, res) => {
      const intentId = String(req.body?.intentId ?? '');
      if (!intentId) throw AppError.badRequest('intent_required', 'intentId is required');
      res.json(jsonResult(await issueOwnershipConfirmationToken(req.ctx.user!.id, intentId)));
    }),
  );

  router.post(
    '/self-service/activate',
    asyncRoute(async (req, res) => {
      const token = String(req.body?.token ?? '');
      if (!token) throw AppError.badRequest('token_required', 'token is required');
      res.json(jsonResult(await redeemOwnershipConfirmationToken(token, { userId: req.ctx.user!.id })));
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

/**
 * Razorpay webhook — the TRUSTED VERIFICATION RAIL for automatic payment
 * activation (independent of the checkout mode). Only enabled when
 * RAZORPAY_WEBHOOK_ENABLED=true and RAZORPAY_WEBHOOK_SECRET is configured.
 *
 * Flow:
 *   raw body -> HMAC-SHA256 signature verification (RAZORPAY_WEBHOOK_SECRET)
 *   -> event-level idempotency (payment_webhook_events, keyed by event.id)
 *   -> resolve the exact internal payment intent via server-authoritative
 *      identifiers (provider_reference_id / provider_payment_link_id /
 *      internal reference) — NEVER by email alone
 *   -> AUTOPILOT fallback: when nothing resolved but UNLOCK_MODE=AUTOPILOT,
 *      bind via the configured Payment Link product identity
 *      (payment_link.entity.id -> RAZORPAY_*_PAYMENT_LINK_ID) + plan price +
 *      unique pending intent, then route through the trusted 26H pipeline
 *      (razorpay_autopilot source) to activate the entitlement exactly-once
 *   -> plan/amount validation against the intent (server map)
 *   -> route through the trusted 26H pipeline (razorpay_webhook source) to
 *      auto-activate the entitlement (exactly-once via the pipeline guards)
 *
 * Any webhook that cannot be resolved to an unambiguous intent, or whose
 * amount/plan does not match, is NOT auto-activated: it is recorded for
 * review. A customer can never self-verify or fabricate a paid entitlement.
 */
export const paymentWebhookRoutes = (): Router => {
  const router = Router();
  router.post(
    '/razorpay',
    asyncRoute(async (req, res) => {
      if (!env.RAZORPAY_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_ENABLED !== 'true') {
        throw AppError.notFound('Webhook not configured');
      }

      // Raw body must be the exact bytes Razorpay signed. With the express.raw
      // mount for this path, req.body is a Buffer; if it is somehow already an
      // object, re-serialization would break the HMAC, so treat as invalid.
      const raw = req.body;
      const rawBuffer = Buffer.isBuffer(raw) ? raw : null;
      if (!rawBuffer) {
        throw AppError.badRequest('invalid_body', 'Webhook requires a raw JSON body');
      }

      const signature = String(req.headers['x-razorpay-signature'] ?? '');
      const { createHmac, timingSafeEqual } = await import('node:crypto');

      // Defense-in-depth: when INTERNAL_WEBHOOK_TOKEN is configured, only the
      // Cloudflare adapter (which verifies the HMAC and holds this token) may
      // reach the origin. Direct Razorpay-to-origin mode keeps working when it
      // is unset. Either way the HMAC below is still mandatory.
      const internalToken = env.INTERNAL_WEBHOOK_TOKEN;
      if (internalToken) {
        const bearer = String(req.headers['authorization'] ?? '');
        const expectedBearer = `Bearer ${internalToken}`;
        const provided = Buffer.from(bearer);
        const expected = Buffer.from(expectedBearer);
        const matches =
          provided.length === expected.length && timingSafeEqual(provided, expected);
        if (!matches) {
          await recordAudit({
            action: 'payment.webhook_internal_token_invalid',
            actorUserId: null,
            scope: 'SYSTEM',
            resourceType: 'payment_webhook',
            detail: { reason: 'invalid_internal_token' },
          });
          throw AppError.unauthorized('invalid_internal_token', 'Missing or invalid internal webhook token');
        }
      }

      // Current secret, plus optional legacy secret to accept a Razorpay
      // replay signed with the secret active at event time (remove after).
      const legacySecret = process.env.RAZORPAY_WEBHOOK_SECRET_LEGACY;
      const secrets = legacySecret
        ? [env.RAZORPAY_WEBHOOK_SECRET, legacySecret]
        : [env.RAZORPAY_WEBHOOK_SECRET];
      const signatureValid = secrets.some((s) => {
        const expected = createHmac('sha256', s).update(rawBuffer).digest('hex');
        return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      });
      if (!signatureValid) {
        await recordAudit({
          action: 'payment.webhook_signature_invalid',
          actorUserId: null,
          scope: 'SYSTEM',
          resourceType: 'payment_webhook',
          detail: { reason: 'invalid_signature' },
        });
        throw AppError.unauthorized('invalid_signature', 'Invalid Razorpay webhook signature');
      }

      let payload: {
        event?: string;
        id?: string;
        payload?: { payment?: { entity?: { id?: string; amount?: number; email?: string; created_at?: number; notes?: Record<string, string> } }; payment_link?: { entity?: { id?: string; reference_id?: string; notes?: Record<string, string> } } };
      };
      try {
        payload = JSON.parse(rawBuffer.toString('utf8'));
      } catch {
        throw AppError.badRequest('malformed_payload', 'Webhook payload is not valid JSON');
      }

      const eventId = payload.id;
      const eventType = payload.event ?? '';
      const paymentId = payload.payload?.payment?.entity?.id;
      const linkId = payload.payload?.payment_link?.entity?.id;
      const referenceId =
        payload.payload?.payment_link?.entity?.reference_id ??
        payload.payload?.payment?.entity?.notes?.reference ??
        null;

      if (eventId) {
        // Delivery-level idempotency: a re-delivered event.id is a no-op.
        const dedupe = await withSystem((q) =>
          q.query(
            `INSERT INTO payment_webhook_events (event_id, event_type, payload_sha, handled)
             VALUES ($1,$2,$3,true)
             ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
            [eventId, eventType, createHmac('sha256', `${eventId}:${paymentId ?? ''}`).digest('hex')],
          ),
        );
        if ((dedupe.rowCount ?? 0) === 0) {
          res.json({ ok: true, duplicate: true, event: eventType });
          return;
        }
      }

      // Resolve the exact intent from trusted, server-authoritative identifiers
      // only. We never bind by email; a missing/unambiguous match is NOT
      // auto-activated.
      const resolveKeys = [
        { col: 'provider_reference_id', val: referenceId },
        { col: 'provider_payment_link_id', val: linkId },
        { col: 'reference', val: referenceId },
      ];
      let intent: {
        id: string; owner_id: string; plan_id: string; amount_inr: number;
        reference: string; status: string;
      } | null = null;
      let viaAutopilot = false;
      for (const { col, val } of resolveKeys) {
        if (!val) continue;
        const rows = await withSystem<{
          id: string; owner_id: string; plan_id: string; amount_inr: number;
          reference: string; status: string;
        }[]>(async (q) =>
          (
            await q.query<{
              id: string; owner_id: string; plan_id: string; amount_inr: number;
              reference: string; status: string;
            }>(
              `SELECT id, owner_id, plan_id, amount_inr, reference, status FROM payment_intents WHERE ${col} = $1 ORDER BY created_at DESC LIMIT 1`,
              [val],
            )
          ).rows,
        );
        if (rows[0]) {
          intent = rows[0];
          break;
        }
      }

      if (!intent) {
        // AUTOPILOT fallback: static per-plan links carry no per-user reference
        // (provider ids are null), so the exact resolver above finds nothing.
        // Bind by configured Payment Link product identity + amount + unique
        // pending intent; fail closed when ambiguous/unmatched. Only resolves
        // when UNLOCK_MODE=AUTOPILOT and the webhook rail is configured.
        try {
          const autopilot = await resolveAutopilotIntent(payload);
          if (autopilot && autopilot.intent) {
            intent = autopilot.intent;
            viaAutopilot = true;
          }
        } catch {
          // A DB/config failure must never auto-activate: fall through to an
          // unmatched audit + manual review, exactly as if nothing resolved.
        }
      }

      if (!intent) {
        await recordAudit({
          action: 'payment.webhook_unmatched',
          actorUserId: null,
          scope: 'SYSTEM',
          resourceType: 'payment_webhook',
          detail: { eventType, eventId: eventId ?? null, paymentId: paymentId ?? null, linkId: linkId ?? null, referenceId: referenceId ?? null },
        });
        res.json({ ok: false, reason: 'no_matching_intent', event: eventType });
        return;
      }

      // A reversal (refund OR dispute/chargeback) must first stop any pending
      // autopilot window for the same payment: otherwise the sweep could
      // auto-approve a payment that Razorpay just took back. Idempotent.
      if (paymentId) {
        await withSystem((q) =>
          q.query(
            `UPDATE payment_auto_approvals SET state = 'STOPPED', stop_reason = 'payment_reversed', stopped_at = now()
              WHERE payment_id = $1 AND state = 'PENDING_APPROVAL'`,
            [paymentId],
          ),
        );
      }

      if (
        eventType === 'payment.dispute.created' ||
        eventType.startsWith('payment.dispute.') ||
        eventType.includes('chargeback')
      ) {
        // Disputes/chargebacks revoke exactly like refunds (money is gone or
        // contested) but keep a distinct intent status + audit trail so a
        // dispute is never confused with a voluntary refund.
        if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
          await withTenant(intent.owner_id, (q) =>
            q.query(
              `UPDATE payment_intents SET status = 'CHARGEBACK', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status IN ('ACTIVE','GRACE')`,
              [intent.id, intent.owner_id],
            ),
          );
          // Guard: only revoke the entitlement if it was granted by THIS
          // intent (via its id as the payment_session_id anchor). Without
          // this check a stale chargeback on an older intent could revoke
          // access from a newer, valid payment for the same plan.
          const currentEnt = await withTenant<{ id: string; payment_session_id: string | null } | null>(
            intent.owner_id,
            async (q) =>
              q
                .query<{ id: string; payment_session_id: string | null }>(
                  `SELECT id, payment_session_id FROM entitlements WHERE user_id = $1 AND plan_id = $2 AND state = 'PRO_VERIFIED'`,
                  [intent.owner_id, intent.plan_id],
                )
                .then((r) => r.rows[0] ?? null),
          );
          if (!currentEnt || currentEnt.payment_session_id === intent.id) {
            try {
              await revokeEntitlement(intent.owner_id, intent.plan_id, `webhook:chargeback`);
            } catch (e: any) {
              // Idempotent: if the entitlement was already revoked or never
              // granted, the chargeback still succeeds — the intent status
              // transition above is the authoritative record.
              if (e?.code !== 'entitlement_not_active') throw e;
            }
          } else {
            // Entitlement was granted by a newer intent — do not revoke.
            await recordAudit({
              action: 'payment.webhook_chargeback_skipped',
              actorUserId: null,
              scope: 'SYSTEM',
              tenantId: intent.owner_id,
              resourceType: 'payment_intent',
              resourceId: intent.id,
              detail: { plan: intent.plan_id, reason: 'entitlement_bound_to_newer_intent' },
            });
          }
        }
        await recordAudit({
          action: 'payment.webhook_chargeback',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: intent.owner_id,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          detail: { plan: intent.plan_id, paymentId: paymentId ?? null, eventType },
        });
        await notify(intent.owner_id, NotificationType.PAYMENT_STATUS, 'Payment disputed', {
          body: `A dispute was raised on your ${intent.plan_id.toUpperCase()} payment. Access was suspended pending resolution.`,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          email: true,
        });
        res.json({ ok: true, handled: 'chargeback' });
        return;
      }

      if (
        eventType === 'payment.refunded' ||
        eventType === 'payment_link.payment_refunded' ||
        eventType === 'refund.created' ||
        eventType === 'refund.processed'
      ) {
        if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
          await withTenant(intent.owner_id, (q) =>
            q.query(
              `UPDATE payment_intents SET status = 'REFUNDED', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status IN ('ACTIVE','GRACE')`,
              [intent.id, intent.owner_id],
            ),
          );
          // Guard: only revoke the entitlement if it was granted by THIS
          // intent (via its id as the payment_session_id anchor). Without
          // this check a stale refund on an older intent could revoke
          // access from a newer, valid payment for the same plan.
          const currentEnt = await withTenant<{ id: string; payment_session_id: string | null } | null>(
            intent.owner_id,
            async (q) =>
              q
                .query<{ id: string; payment_session_id: string | null }>(
                  `SELECT id, payment_session_id FROM entitlements WHERE user_id = $1 AND plan_id = $2 AND state = 'PRO_VERIFIED'`,
                  [intent.owner_id, intent.plan_id],
                )
                .then((r) => r.rows[0] ?? null),
          );
          if (!currentEnt || currentEnt.payment_session_id === intent.id) {
            try {
              await revokeEntitlement(intent.owner_id, intent.plan_id, `webhook:refunded`);
            } catch (e: any) {
              // Idempotent: if the entitlement was already revoked or never
              // granted, the refund still succeeds — the intent status
              // transition above is the authoritative record.
              if (e?.code !== 'entitlement_not_active') throw e;
            }
          } else {
            // Entitlement was granted by a newer intent — do not revoke.
            await recordAudit({
              action: 'payment.webhook_refund_skipped',
              actorUserId: null,
              scope: 'SYSTEM',
              tenantId: intent.owner_id,
              resourceType: 'payment_intent',
              resourceId: intent.id,
              detail: { plan: intent.plan_id, reason: 'entitlement_bound_to_newer_intent' },
            });
          }
        }
        await recordAudit({
          action: 'payment.webhook_refunded',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: intent.owner_id,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          detail: { plan: intent.plan_id, paymentId: paymentId ?? null },
        });
        await notify(intent.owner_id, NotificationType.PAYMENT_STATUS, 'Payment refunded', {
          body: `Your ${intent.plan_id.toUpperCase()} payment was refunded.`,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          email: true,
        });
        const isRefundEvent = eventType === 'payment.refunded' || eventType === 'payment_link.payment_refunded' || eventType === 'refund.created' || eventType === 'refund.processed';
        const handledLabel = eventType === 'refund.created' ? 'refund_created' :
          eventType === 'refund.processed' ? 'refund_processed' : 'refunded';
        res.json({ ok: true, handled: handledLabel });
        return;
      }

      // Only settled-payment events can activate. `payment.authorized` is
      // deliberately excluded: an authorization hold is not a capture and can
      // lapse — activating on it would grant paid plans for unsettled money.
      // All other lifecycle events are recorded (idempotent) but change nothing.
      if (eventType !== 'payment.captured' && eventType !== 'payment_link.paid') {
        await recordAudit({
          action: 'payment.webhook_event',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: intent.owner_id,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          detail: { eventType, eventId: eventId ?? null, paymentId: paymentId ?? null },
        });
        res.json({ ok: true, event: eventType });
        return;
      }

      // Plan/amount validation (server-authoritative map). A mismatch must be
      // flagged and never auto-activate.
      const claimedAmountInr =
        typeof payload.payload?.payment?.entity?.amount === 'number'
          ? Math.round(payload.payload.payment.entity.amount / 100)
          : null;
      if (claimedAmountInr !== null && claimedAmountInr !== intent.amount_inr) {
        await recordAudit({
          action: 'payment.webhook_amount_mismatch',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: intent.owner_id,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          detail: { plan: intent.plan_id, expectedInr: intent.amount_inr, claimedInr: claimedAmountInr },
        });
        res.json({ ok: false, reason: 'amount_mismatch' });
        return;
      }

      if (intent.status !== 'PENDING' && intent.status !== 'REVIEW') {
        // Already ACTIVE/EXPIRED/etc — idempotent no-op for this intent.
        res.json({ ok: true, state: intent.status });
        return;
      }

      // AUTOPILOT: a successfully resolved verified payment enters the durable
      // 2-second intervention window (payment_auto_approvals) instead of
      // activating synchronously. The founder can STOP/HOLD; otherwise the
      // server-side sweep auto-approves through the SAME trusted authority
      // (ingestEvidence -> applyDecision -> activateEntitlement). This window is
      // NOT payment verification — the signed-webhook resolver above already
      // proved product binding, amount and a unique pending intent before this
      // code runs; the window only decides WHO approves (founder STOP) vs WHEN.
      if (viaAutopilot) {
        const outcome = await requestAutoApproval({
          intent,
          signal: autopilotSignalPayload(payload) as ApprovalSignalPayload,
        });
        await recordAudit({
          action: 'payment.auto_approval_request',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: intent.owner_id,
          resourceType: 'payment_intent',
          resourceId: intent.id,
          detail: {
            eventType,
            paymentId: paymentId ?? null,
            planned: outcome.planned,
            reason: 'reason' in outcome ? outcome.reason : null,
          },
        });
        res.json({
          ok: true,
          intentId: intent.id,
          autoApproval: outcome.planned,
          ...('reason' in outcome ? { reason: outcome.reason } : {}),
        });
        return;
      }

      // Trusted pipeline activation (non-autopilot rail): razorpay_webhook is a
      // trusted source, so it may reach ACTIVE synchronously (unlike manual/ocr
      // which are forced to REVIEW). The evidence source anchors the intent's
      // own reference, so per-intent link payments reach ACTIVE instead of dying
      // at unmatched/review.
      const result = await ingestEvidence(intent.owner_id, intent.id, 'razorpay_webhook', payload);
      await recordAudit({
        action: 'payment.webhook_processed',
        actorUserId: null,
        scope: 'SYSTEM',
        tenantId: intent.owner_id,
        resourceType: 'payment_intent',
        resourceId: intent.id,
        detail: { eventType, source: 'razorpay_webhook', intentStatus: result.result?.intentStatus, decision: result.result?.decision, confidence: result.result?.confidence },
      });

      res.json({
        ok: true,
        intentId: intent.id,
        status: result.result?.intentStatus ?? null,
        decision: result.result?.decision ?? null,
        confidence: result.result?.confidence ?? null,
      });
    }),
  );
  return router;
};