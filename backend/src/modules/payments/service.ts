/**
 * CodeConClave — payments + entitlements.
 * Razorpay-native with capability detection: with API credentials present we
 * create real payment links and verify them via the API; without credentials
 * (current env) sessions are created with the configured link and remain
 * PENDING until independent provider evidence (webhook or API fetch) — the
 * UI never fakes success. Entitlements only activate on VERIFIED.
 */
import { pool, withSystem, withTenant, type DbQueryable } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { outboundSignal } from '../../shared/http-timeout.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { NotificationType, ApprovalActionType, AuditAction } from '@codeconclave/shared';
import { evidenceProviders, validateProviderEvidence, evidenceSources26H, gmailDetectorAvailable, type ProviderEvidence } from './evidence.js';
import { refreshIntentEvidence, type IngestResult } from './pipeline.js';

export type PaymentMode = 'PAYMENT_LINK' | 'API' | 'WEBHOOK';

export interface PaymentSessionRow {
  id: string;
  user_id: string;
  plan_id: string;
  amount_inr: number;
  currency: string;
  mode: PaymentMode;
  state: string;
  reference: string | null;
  provider_payment_id: string | null;
  provider_order_id: string | null;
  verification_evidence: Record<string, unknown> | null;
  expires_at: Date;
  created_at: Date;
  tenant_id?: string | null;
  idempotency_key?: string | null;
}

export const PLAN_PRICES_INR: Record<string, number> = { pro: 999, team: 4999, api: 9999 };
export const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Server-authoritative plan -> payment link mapping (from trusted config).
 * SOLO/PRO -> ₹999 link, TEAM -> ₹4999 link, API ACCESS -> ₹9,999 link.
 * Product identity is NEVER derived from amount/link alone: the intent's own
 * plan + purchase_type is the source of truth. API Access is a SEPARATE
 * product whose link is founder-provided (RAZORPAY_API_PAYMENT_LINK); there is
 * NO fallback between plans, and never any amount-based product inference.
 */
export const PLAN_PAYMENT_LINK_INR: Record<string, string> = {
  pro: env.RAZORPAY_PRO_PAYMENT_LINK,
  team: env.RAZORPAY_TEAM_PAYMENT_LINK,
  api: env.RAZORPAY_API_PAYMENT_LINK ?? '',
};

/** Human label used in payment links / descriptions (never the entitlement key). */
export function planDisplayLabel(planId: string): string {
  switch (planId) {
    case 'pro':
      return 'Pro';
    case 'team':
      return 'Team';
    case 'api':
      return 'API Access';
    default:
      return planId.toUpperCase();
  }
}

/**
 * Resolve the server-authoritative payment link for a plan.
 * Unknown/invalid plans fail safely; a plan without a configured link (e.g.
 * API Access before RAZORPAY_API_PAYMENT_LINK is set) FAILS SAFELY and NEVER
 * falls back to another plan's link.
 */
export function paymentLinkForPlan(planId: string): string {
  if (!(planId in PLAN_PRICES_INR)) throw AppError.badRequest('invalid_plan', 'plan must be pro, team or api');
  const link = { pro: env.RAZORPAY_PRO_PAYMENT_LINK, team: env.RAZORPAY_TEAM_PAYMENT_LINK, api: env.RAZORPAY_API_PAYMENT_LINK ?? '' }[planId]!;
  if (!link) {
    throw AppError.conflict(
      'payment_link_unconfigured',
      `No payment link is configured yet for ${planDisplayLabel(planId)}. Contact support for the exact ₹${PLAN_PRICES_INR[planId]} link.`,
    );
  }
  return link;
}

/** Current Razorpay capability for this deployment (server-derived, honest). */
export function paymentCapability(): {
  api: boolean;
  webhook: boolean;
  link: boolean;
  mode: string;
  unlockMode: string;
  plans: Record<string, number>;
  evidence: ReturnType<typeof evidenceProviders>;
  evidenceSources: Array<{ id: string; label: string; enabled: boolean; reason: string | null }>;
  razorpayConfigured: boolean;
} {
  return {
    api: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    webhook: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
    link: true,
    mode: env.RAZORPAY_MODE,
    unlockMode: env.UNLOCK_MODE,
    plans: PLAN_PRICES_INR,
    evidence: evidenceProviders(),
    evidenceSources: evidenceSources26H().map((s) => ({
      id: s.id,
      label: s.label,
      enabled: s.available(),
      reason: s.unavailableReason(),
    })),
    razorpayConfigured: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
  };
}

function razorpayAuth(): string | null {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  return Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
}

export interface RazorpayPaymentLink {
  id: string;
  short_url: string;
  reference_id: string | null;
}

/**
 * Server-side creation of a UNIQUE Razorpay Payment Link for a specific
 * payment intent. This is the trusted automatic-activation launch path: each
 * intent gets its own link carrying the intent's unique reference_id and the
 * payment-link id, so a signed webhook can resolve back to the exact user +
 * plan + amount. Returns null when the API is unavailable (callers then fall
 * back to the static per-plan link for compatibility/manual checkout — those
 * links cannot auto-activate and go to REVIEW instead).
 */
export async function createRazorpayPaymentLinkForIntent(
  userId: string,
  planId: string,
  reference: string,
): Promise<RazorpayPaymentLink | null> {
  const auth = razorpayAuth();
  if (!auth) return null;
  const amount = PLAN_PRICES_INR[planId];
  if (amount === undefined) return null;
  try {
    const email = await getUserEmail(userId);
    const response = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amount * 100,
        currency: 'INR',
        accept_partial: false,
        description: `CodeConClave ${planDisplayLabel(planId)} (one-time)`,
        reference_id: reference,
        callback_url: `${env.API_URL}/api/v1/payments/status`,
        callback_method: 'get',
        customer: { email: email ?? 'customer@example.com' },
        notify: { email: false, sms: false },
        notes: { intent_id: reference, plan: planId },
      }),
      signal: outboundSignal(),
    });
    if (!response.ok) {
      logger.warn('razorpay payment link creation failed', { status: response.status, planId });
      return null;
    }
    const body = (await response.json()) as {
      id?: string;
      short_url?: string;
      reference_id?: string | null;
    };
    if (!body.id || !body.short_url) return null;
    return { id: body.id, short_url: body.short_url, reference_id: body.reference_id ?? null };
  } catch (err) {
    logger.warn('razorpay API unavailable', { err });
    return null;
  }
}

export async function createPaymentSession(
  userId: string,
  planId: string,
  idempotencyKey?: string,
): Promise<PaymentSessionRow> {
  if (!(planId in PLAN_PRICES_INR)) throw AppError.badRequest('invalid_plan', 'plan must be pro, team or api');

  // Idempotency: the same key always resolves to the same session (no dupes).
  if (idempotencyKey && idempotencyKey.trim().length > 0) {
    const byKey = await withTenant<{ rows: PaymentSessionRow[] }>(userId, (q) =>
      q.query<PaymentSessionRow>(
        `SELECT * FROM payment_sessions WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      ),
    );
    if (byKey.rows[0]) return byKey.rows[0];
  }

  const existing = await withTenant<{ rows: PaymentSessionRow[] }>(userId, (q) =>
    q.query<PaymentSessionRow>(
      `SELECT * FROM payment_sessions WHERE user_id = $1 AND plan_id = $2 AND state = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
      [userId, planId],
    ),
  );
  if (existing.rows[0] && existing.rows[0].expires_at.getTime() > Date.now()) return existing.rows[0];

  const id = newId(PREFIX.PAYMENT);
  const amount = PLAN_PRICES_INR[planId]!;
  const mode: PaymentMode = env.RAZORPAY_MODE === 'webhook' ? 'WEBHOOK' : env.RAZORPAY_MODE === 'api' ? 'API' : 'PAYMENT_LINK';
  let reference: string | null = null;

  if (mode === 'API' || mode === 'PAYMENT_LINK') {
    const auth = razorpayAuth();
    if (auth && mode === 'API') {
      // Real Razorpay payment link creation via API.
      try {
        const response = await fetch('https://api.razorpay.com/v1/payment_links', {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: amount * 100,
            currency: 'INR',
            description: `CodeConClave ${planDisplayLabel(planId)} (one-time)`,
            customer: { email: (await getUserEmail(userId)) ?? 'customer@example.com' },
            notify: { email: false, sms: false },
            notes: { session_id: id },
          }),
          signal: outboundSignal(),
        });
        const body = (await response.json()) as { id?: string; short_url?: string; status?: string };
        if (response.ok && body.id) {
          reference = body.short_url ?? `https://rzp.io/rzp/${body.id}`;
        } else {
          logger.warn('razorpay link creation failed', { status: response.status, body });
        }
      } catch (err) {
        logger.warn('razorpay API unavailable', { err });
      }
    }
    if (!reference) reference = paymentLinkForPlan(planId); // per-plan authoritative link, no cross-plan fallback
  }

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO payment_sessions (id, user_id, plan_id, amount_inr, currency, mode, state, reference, expires_at, tenant_id, idempotency_key)
       VALUES ($1,$2,$3,$4,'INR',$5,'PENDING',$6, now() + interval '30 minutes', $7, $8)`,
      [id, userId, planId, amount, mode, reference, userId, idempotencyKey?.trim() || null],
    ),
  );
  await ensureEntitlement(userId, planId, 'PRO_PENDING', id);
  await recordAudit({
    action: 'payment.session_created',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_session',
    resourceId: id,
    detail: { plan: planId, mode, amountInr: amount },
  });
  return getSession(userId, id);
}

export async function getUserEmail(userId: string): Promise<string | null> {
  const row = await withTenant<{ rows: { email: string }[] }>(userId, (q) => q.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]));
  return row.rows[0]?.email ?? null;
}

export async function getSession(userId: string, sessionId: string): Promise<PaymentSessionRow> {
  const rows = await withTenant<{ rows: PaymentSessionRow[] }>(userId, (q) =>
    q.query<PaymentSessionRow>('SELECT * FROM payment_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]),
  );
  if (!rows.rows[0]) throw AppError.notFound('Payment session');
  return rows.rows[0];
}

export async function listSessions(userId: string): Promise<PaymentSessionRow[]> {
  const rows = await withTenant<{ rows: PaymentSessionRow[] }>(userId, (q) =>
    q.query<PaymentSessionRow>('SELECT * FROM payment_sessions WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
  );
  return rows.rows;
}

/**
 * Extract the claimed payment amount (INR) from provider evidence raw payload,
 * tolerating the Razorpay webhook/API shapes (amount in paise). Returns null
 * when no amount is present so a plain "payment link paid" event with no
 * amount field is not falsely rejected.
 */
function evidenceAmountInr(raw: unknown): number | null {
  const root = raw as {
    payload?: { payment?: { entity?: { amount?: number } } };
    amount?: number;
  } | null;
  const paise = root?.payload?.payment?.entity?.amount ?? root?.amount;
  if (typeof paise !== 'number' || Number.isNaN(paise)) return null;
  return Math.round(paise / 100);
}

/** Server-side verification against Razorpay (API mode with credentials). */
async function verifyWithProvider(session: PaymentSessionRow): Promise<boolean> {
  if (env.RAZORPAY_MODE !== 'api') return false;
  const auth = razorpayAuth();
  if (!auth) return false;
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payment_links/${session.provider_order_id ?? session.reference ?? ''}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: outboundSignal(),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { payments?: { items?: Array<{ status?: string }> } };
    const paid = body.payments?.items?.some((p) => p.status === 'captured') ?? false;
    if (paid) {
      await verifySession(session.user_id, session.id, {
        source: 'API',
        provider_payment_id: session.provider_payment_id ?? undefined,
        raw: body,
      });
    }
    return paid;
  } catch {
    return false;
  }
}

/** Handle the paid-link return. Honest: without provider evidence state stays PENDING. */
export async function handleReturn(userId: string, sessionId: string, paidParam: string | null): Promise<PaymentSessionRow> {
  const session = await getSession(userId, sessionId);
  if (session.state !== 'PENDING') return session;
  if (paidParam === 'false' || paidParam === 'cancelled') {
    await withTenant(userId, (q) => q.query(`UPDATE payment_sessions SET state = 'CANCELLED' WHERE id = $1`, [sessionId]));
    return getSession(userId, sessionId);
  }
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO payment_events (id, session_id, user_id, event_type, payload, source)
       VALUES ($1,$2,$3,'return',$4::jsonb,'LINK')`,
      [newId(PREFIX.PAYMENT), sessionId, userId, JSON.stringify({ paidParam })],
    ),
  );
  const verified = await verifyWithProvider(session);
  // Without verifiable provider evidence we stay PENDING — never claim success.
  return getSession(userId, sessionId);
}

/** Webhook / API evidence path: the ONLY way to VERIFIED. */
export async function verifySession(userId: string, sessionId: string, evidence: ProviderEvidence): Promise<PaymentSessionRow> {
  const session = await getSession(userId, sessionId);
  if (session.state === 'VERIFIED') return session;
  if (session.state !== 'PENDING') throw AppError.conflict('session_not_pending', `Session is ${session.state.toLowerCase()}`);

  // Server-side evidence validation — client claims can never reach this path.
  validateProviderEvidence(evidence);

  // Amount authority: if the provider evidence carries a payment amount it
  // MUST equal the server-authoritative amount for this plan. A mismatch is
  // rejected (no VERIFIED, no entitlement) and recorded as an auditable
  // amount_mismatch — the observed amount is never trusted as authority.
  const claimedAmountInr = evidenceAmountInr(evidence.raw);
  if (claimedAmountInr !== null && claimedAmountInr !== session.amount_inr) {
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO payment_events (id, session_id, user_id, event_type, payload, source)
         VALUES ($1,$2,$3,'payment.rejected',$4::jsonb,$5)`,
        [newId(PREFIX.PAYMENT), sessionId, userId, JSON.stringify({ reason: 'amount_mismatch', expectedInr: session.amount_inr, claimedInr: claimedAmountInr, plan: session.plan_id }), evidence.source],
      ),
    );
    await logPaymentAudit(sessionId, userId, 'payment.amount_mismatch', {
      expectedInr: session.amount_inr,
      claimedInr: claimedAmountInr,
      plan: session.plan_id,
    });
    throw AppError.conflict('amount_mismatch', `Payment amount does not match the ${session.plan_id} plan`);
  }

  // DETECTED: independent provider evidence arrived (recorded for audit).
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO payment_events (id, session_id, user_id, event_type, payload, source)
       VALUES ($1,$2,$3,'payment.detected',$4::jsonb,$5)`,
      [newId(PREFIX.PAYMENT), sessionId, userId, JSON.stringify(evidence.raw), evidence.source],
    ),
  );
  await withTenant(userId, (q) => q.query(`UPDATE payment_sessions SET state = 'DETECTED' WHERE id = $1`, [sessionId]));

  // VERIFYING: validation in progress (capture record + entitlement next).
  await withTenant(userId, (q) => q.query(`UPDATE payment_sessions SET state = 'VERIFYING' WHERE id = $1`, [sessionId]));

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO payments (id, session_id, amount_inr, currency, status, provider, provider_ref, paid_at, verification_evidence)
       VALUES ($1,$2,$3,'INR','CAPTURED','razorpay',$4, now(), $5::jsonb)
       ON CONFLICT (provider_ref) DO NOTHING`,
      [newId(PREFIX.PAYMENT), sessionId, session.amount_inr, evidence.provider_payment_id ?? null, JSON.stringify(evidence.raw)],
    ),
  );
  await activateEntitlement(userId, session.plan_id, sessionId);

  // Link the capture record to its single entitlement activation; COMPLETED.
  const entitlement = await withTenant<{ rows: { id: string }[] }>(userId, (q) =>
    q.query<{ id: string }>(
      `SELECT id FROM entitlements WHERE user_id = $1 AND plan_id = $2`,
      [userId, session.plan_id],
    ),
  );
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE payments SET status = 'COMPLETED', entitlement_id = $2 WHERE session_id = $1 AND status = 'CAPTURED'`,
      [sessionId, entitlement.rows[0]?.id ?? null],
    ),
  );

  await withTenant(userId, (q) =>
    q.query(
      `UPDATE payment_sessions
          SET state = 'VERIFIED', verification_evidence = $2::jsonb,
              provider_payment_id = COALESCE($3, provider_payment_id),
              provider_order_id = COALESCE($4, provider_order_id)
        WHERE id = $1`,
      [sessionId, JSON.stringify({ ...evidence, verifiedAt: new Date().toISOString() }), evidence.provider_payment_id ?? null, evidence.provider_order_id ?? null],
    ),
  );
  await recordAudit({
    action: 'payment.verified',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_session',
    resourceId: sessionId,
    detail: { source: evidence.source, plan: session.plan_id },
  });
  await notify(userId, NotificationType.PAYMENT_STATUS, 'Payment verified', {
    body: `Your ${session.plan_id.toUpperCase()} plan payment was verified and activated.`,
    resourceType: 'payment_session',
    resourceId: sessionId,
    metadata: { plan: session.plan_id, source: evidence.source },
    email: true,
  });
  return getSession(userId, sessionId);
}

// ---------------------------------------------------------------- entitlements

export interface EntitlementRow {
  id: string;
  user_id: string;
  plan_id: string;
  state: string;
  verified_at: Date | null;
  expires_at: Date | null;
  payment_session_id: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
}

async function ensureEntitlement(userId: string, planId: string, state: string, sessionId: string): Promise<void> {
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO entitlements (id, user_id, plan_id, state, payment_session_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, plan_id) DO UPDATE SET state = EXCLUDED.state, payment_session_id = EXCLUDED.payment_session_id`,
      [newId(PREFIX.ENTITLEMENT), userId, planId, state, sessionId],
    ),
  );
}

/**
 * STAGE 26H: shared activation hook — used by activation.ts (exactly-once
 * intent pipeline) and by admin claim approval. Grants the entitlement row
 * (PRO_VERIFIED). The users.plan_id mirror is updated ONLY for base plans
 * (pro/team) — add-on entitlements such as API Access ('api') never overwrite
 * the user's base plan, so an API Access purchase can never mask or replace a
 * Solo/Team plan.
 *
 * `client` is optional: when provided (e.g. a withTenant transaction from the
 * claim approval flow) all writes run on that client so the entitlement
 * activation commits/rolls back atomically with the caller's other statements.
 * Existing callers omit it and keep the default pool auto-commit behavior.
 */
export async function activateEntitlement(
  userId: string,
  planId: string,
  sessionId: string | null,
  client: DbQueryable = pool,
): Promise<void> {
  const anchor = await resolveSessionAnchor(client, sessionId);
  await client.query(
    `INSERT INTO entitlements (id, user_id, plan_id, state, verified_at, payment_session_id, reason)
     VALUES ($1,$2,$3,'PRO_VERIFIED', now(), $4, 'verified')
     ON CONFLICT (user_id, plan_id) DO UPDATE
       SET state = 'PRO_VERIFIED', verified_at = now(), payment_session_id = EXCLUDED.payment_session_id, reason = 'verified'`,
    [newId(PREFIX.ENTITLEMENT), userId, planId, anchor],
  );
  if (planId === 'pro' || planId === 'team') {
    await client.query(`UPDATE users SET plan_id = $2 WHERE id = $1`, [userId, planId]);
  }
}

export async function getEntitlements(userId: string): Promise<EntitlementRow[]> {
  const rows = await withTenant<{ rows: EntitlementRow[] }>(userId, (q) =>
    q.query<EntitlementRow>('SELECT * FROM entitlements WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
  );
  return rows.rows;
}

/*
 * payment_session_id is a FK into payment_sessions. Callers that anchor on a
 * session id MUST materialize the session row (activation.ts does this in
 * applyDecision for the webhook/autopilot rail) so the FK is satisfied; the
 * anchor is stored verbatim so refund/chargeback guards can bind entitlements
 * back to the granting payment.
 */
async function resolveSessionAnchor(_client: DbQueryable, sessionId: string | null): Promise<string | null> {
  return sessionId;
}

/** Frontend-facing entitlement JSON (Phase 14 billing UX contract). */
export function toEntitlementJson(e: EntitlementRow) {
  return {
    id: e.id,
    planId: e.plan_id,
    state: e.state,
    activatedAt: e.verified_at,
    expiresAt: e.expires_at,
    reason: e.reason,
    sessionId: e.payment_session_id,
  };
}

export async function entitlementFor(userId: string, planId: string): Promise<EntitlementRow | null> {
  const rows = await withTenant<{ rows: EntitlementRow[] }>(userId, (q) =>
    q.query<EntitlementRow>('SELECT * FROM entitlements WHERE user_id = $1 AND plan_id = $2', [userId, planId]),
  );
  return rows.rows[0] ?? null;
}

/**
 * Revoke an active entitlement. Only PRO_VERIFIED entitlements can be
 * revoked; the user's mirrored plan_id is reset to free when it points at
 * the revoked plan.
 */
export async function revokeEntitlement(userId: string, planId: string, reason: string): Promise<EntitlementRow> {
  const entitlement = await entitlementFor(userId, planId);
  if (!entitlement || entitlement.state !== 'PRO_VERIFIED') {
    throw AppError.conflict('entitlement_not_active', `No active ${planId} entitlement to revoke`);
  }
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE entitlements SET state = 'REVOKED', reason = $3, expires_at = now() WHERE id = $1 AND state = 'PRO_VERIFIED'`,
      [entitlement.id, planId, reason],
    ),
  );
  await withTenant(userId, (q) => q.query(`UPDATE users SET plan_id = 'free' WHERE id = $1 AND plan_id = $2`, [userId, planId]));
  await recordAudit({
    action: 'entitlement.changed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'entitlement',
    resourceId: entitlement.id,
    detail: { plan: planId, state: 'REVOKED', reason },
  });
  return (await entitlementFor(userId, planId))!;
}

const ADMIN_PAYMENT_ACTIONS = ['revoke', 'mark_refunded'] as const;
export type AdminPaymentAction = (typeof ADMIN_PAYMENT_ACTIONS)[number];

interface AdminApprovalCheck {
  ok: boolean;
  reason?: string;
}

function approvalCheck(approval: { status: string; action_type?: string | null; expires_at: Date } | null): AdminApprovalCheck {
  if (!approval) return { ok: false, reason: 'approval_required' };
  if (approval.status !== 'APPROVED') return { ok: false, reason: 'approval_not_approved' };
  if (approval.action_type !== ApprovalActionType.PAYMENT_OP) return { ok: false, reason: 'approval_action_mismatch' };
  if (approval.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'approval_expired' };
  return { ok: true };
}

/** Perform an administrative payment action once verification + approval gate. */
async function performAdminAction(session: PaymentSessionRow, action: AdminPaymentAction): Promise<void> {
  if (!ADMIN_PAYMENT_ACTIONS.includes(action)) {
    throw AppError.badRequest('invalid_action', `action must be one of ${ADMIN_PAYMENT_ACTIONS.join(', ')}`);
  }
  // Hard gate: an admin action can never turn an unverified payment into a
  // verified one — only VERIFIED payments can be administered.
  if (session.state !== 'VERIFIED') {
    throw AppError.conflict('payment_not_verified', 'Payment is not verified; approval cannot bypass payment verification');
  }
  if (action === 'revoke') {
    await revokeEntitlement(session.user_id, session.plan_id, `admin:revoke (session ${session.id})`);
  } else if (action === 'mark_refunded') {
    await withTenant(session.user_id, (q) => q.query(`UPDATE payment_sessions SET state = 'REFUNDED' WHERE id = $1 AND state = 'VERIFIED'`, [session.id]));
    await ensureEntitlement(session.user_id, session.plan_id, 'PRO_REFUNDED', session.id);
  }
}

/**
 * Owner-scoped admin payment action: requires an APPROVED, unexpired
 * payment_op approval owned by the same user. The approval authorizes the
 * action — it can never bypass the payment verification gate.
 */
export async function adminPaymentAction(
  userId: string,
  sessionId: string,
  action: AdminPaymentAction,
  approvalId: string,
): Promise<PaymentSessionRow> {
  const approval = await withTenant<{ rows: { id: string; status: string; action_type?: string | null; expires_at: Date }[] }>(userId, (q) =>
    q.query<{ id: string; status: string; action_type?: string | null; expires_at: Date }>(
      `SELECT id, status, action_type, expires_at FROM approvals WHERE id = $1 AND owner_id = $2`,
      [approvalId, userId],
    ),
  );
  const gate = approvalCheck(approval.rows[0] ?? null);
  if (!gate.ok) throw AppError.forbidden(gate.reason!, `Admin payment actions require an approved payment_op approval`);

  const session = await getSession(userId, sessionId);
  await performAdminAction(session, action);
  await logPaymentAudit(sessionId, userId, `admin.${action}`, { approvalId });
  await recordAudit({
    action: 'payment.admin_action',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_session',
    resourceId: sessionId,
    detail: { action, approvalId },
  });
  return getSession(userId, sessionId);
}

/**
 * System-scoped admin action used by the registered 'payment_admin' tool
 * (defense in depth inside the execution engine): re-validates the approval
 * and the payment verification server-side, so executing an APPROVED
 * payment_op approval can never verify an unverified payment.
 */
export async function systemAdminPaymentAction(
  sessionId: string,
  action: AdminPaymentAction,
  approvalId: string,
): Promise<PaymentSessionRow> {
  const approval = await withSystem<{ rows: { id: string; status: string; action_type?: string | null; expires_at: Date }[] }>(async (q) =>
    q.query<{ id: string; status: string; action_type?: string | null; expires_at: Date }>(
      `SELECT id, status, action_type, expires_at FROM approvals WHERE id = $1`,
      [approvalId],
    ),
  );
  const gate = approvalCheck(approval.rows[0] ?? null);
  if (!gate.ok) throw AppError.forbidden(gate.reason!, `Admin payment actions require an approved payment_op approval`);

  const rows = await withSystem<{ rows: PaymentSessionRow[] }>(async (q) => q.query<PaymentSessionRow>(`SELECT * FROM payment_sessions WHERE id = $1`, [sessionId]));
  const session = rows.rows[0];
  if (!session) throw AppError.notFound('Payment session');
  await performAdminAction(session, action);
  await logPaymentAudit(sessionId, null, `admin.${action}`, { approvalId, viaTool: true });
  await recordAudit({
    action: 'payment.admin_action',
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: session.user_id,
    resourceType: 'payment_session',
    resourceId: sessionId,
    detail: { action, approvalId, viaTool: true },
  });
  const final = await withSystem<{ rows: PaymentSessionRow[] }>(async (q) => q.query<PaymentSessionRow>(`SELECT * FROM payment_sessions WHERE id = $1`, [sessionId]));
  return final.rows[0]!;
}

/** Watchdog: expire stale pending sessions (30-min TTL) honestly. */
export async function sweepPaymentExpiry(): Promise<number> {
  const result = await withSystem<{ rowCount: number | null }>(async (q) =>
    q.query(
      `UPDATE payment_sessions SET state = 'EXPIRED' WHERE state = 'PENDING' AND expires_at <= now() RETURNING id`,
    ),
  );
  return result.rowCount ?? 0;
}

/**
 * Watchdog: automated mailbox receipt verification for PENDING/REVIEW
 * intents. Reuses the existing 26H pipeline (refreshIntentEvidence) which
 * only ever ingests authenticated, exact-reference Razorpay receipt emails
 * (see isAuthenticRazorpayMail). It is a no-op when the Gmail rail is not
 * configured. Bounded (25 intents/cycle), rate-limited (>=30s per intent
 * between attempts), idempotent (pipeline replay guards), and retried on
 * the next sweep with failures isolated per intent. Never fabricates
 * evidence: reference-less static-link receipts are dropped upstream.
 */
const MAILBOX_SWEEP_LIMIT = 25;
const MAILBOX_SWEEP_BACKOFF_MS = 30_000;
const mailboxSweepWatermark: Record<string, number> = {};

export async function sweepPendingIntentEvidence(): Promise<{ checked: number; activated: number }> {
  // Rail not configured -> contained no-op (watchdog skips it entirely and,
  // under a DB outage, records no key — matching the outage sweep contract).
  if (!gmailDetectorAvailable()) {
    throw AppError.conflict('evidence_source_blocked', 'Gmail evidence rail is not configured');
  }
  const rows = await withSystem<{ rows: { id: string; owner_id: string }[] }>(async (q) =>
    q.query<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM payment_intents WHERE status IN ('PENDING','REVIEW') ORDER BY created_at ASC LIMIT $1`,
      [MAILBOX_SWEEP_LIMIT],
    ),
  );
  const now = Date.now();
  let checked = 0;
  let activated = 0;
  for (const row of rows.rows) {
    const lastAttemptAt = mailboxSweepWatermark[row.id] ?? 0;
    if (now - lastAttemptAt < MAILBOX_SWEEP_BACKOFF_MS) continue;
    try {
      const result: IngestResult = await refreshIntentEvidence(row.owner_id, row.id);
      checked += 1;
      if (result.result?.intentStatus === 'ACTIVE') activated += 1;
    } catch {
      // no_evidence / evidence_source_blocked are expected and retried next cycle.
    }
    mailboxSweepWatermark[row.id] = now;
  }
  return { checked, activated };
}

/**
 * TEST-ONLY seam: clear the in-memory mailbox sweep watermark, modeling a
 * watchdog process restart (a real restart boots with an empty watermark).
 * Never called by application code; exists solely so the no-money Rail A
 * validation harness can exercise restart-recovery idempotency.
 */
export function __resetMailboxSweepWatermarkForTest(): void {
  for (const k of Object.keys(mailboxSweepWatermark)) delete mailboxSweepWatermark[k];
}

export async function listPaymentAudit(userId: string, sessionId: string): Promise<unknown[]> {
  await getSession(userId, sessionId);
  const rows = await withTenant<{ rows: unknown[] }>(userId, (q) => q.query('SELECT * FROM payment_audit WHERE session_id = $1 ORDER BY created_at DESC', [sessionId]));
  return rows.rows;
}

/**
 * Phase 14 — downgrade/cancel foundation. A user-initiated cancellation is
 * expressed as a PAYMENT_OP approval proposal (owner-scoped, Approval Center
 * review). Approving it never bypasses payment verification — the existing
 * approval-gated admin path performs the actual revocation.
 */
export async function requestPlanCancellation(
  userId: string,
  sessionId: string,
  reason?: string,
): Promise<{ approval: { id: string; status: string; action_type?: string | null } }> {
  const session = await getSession(userId, sessionId);
  if (session.state !== 'VERIFIED' && session.state !== 'PENDING') {
    throw AppError.conflict('session_not_cancellable', `Session is ${session.state.toLowerCase()}; only PENDING or VERIFIED sessions can be cancelled`);
  }
  const { proposeApproval } = await import('../execution/approvals.js');
  const { approval } = await proposeApproval(userId, {
    actionType: ApprovalActionType.PAYMENT_OP,
    justification: reason?.trim() || `Cancel ${session.plan_id.toUpperCase()} plan`,
    affectedResources: [{ type: 'payment_session', ref: sessionId }],
    proposedAction: { action: 'revoke', sessionId },
    riskLevel: 'HIGH',
  });
  if (!approval) throw AppError.conflict('approval_failed', 'Could not create the cancellation approval');
  await logPaymentAudit(sessionId, userId, 'admin.cancel_requested', { approvalId: approval.id, reason: reason ?? null });
  await recordAudit({
    action: AuditAction.PLAN_CANCELLATION_REQUESTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_session',
    resourceId: sessionId,
    detail: { plan: session.plan_id, approvalId: approval.id },
  });
  return { approval };
}

export async function logPaymentAudit(sessionId: string, actorUserId: string | null, action: string, detail?: Record<string, unknown>): Promise<void> {
  await withSystem(async (q) =>
    q.query(
      `INSERT INTO payment_audit (id, session_id, actor_user_id, action, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [newId(PREFIX.PAYMENT), sessionId, actorUserId, action, detail ? JSON.stringify(detail) : null],
    ),
  );
}

export { logger as _paymentLogger };

/**
 * STAGE 26H — user-facing payment status (P12): per-plan intent status +
 * entitlement state + effective plan. Server-authoritative read for the
 * Settings billing page.
 */
export interface PaymentStatusView {
  effectivePlan: string;
  accountEmail: string | null;
  plans: Array<{
    planId: string;
    intentStatus: string | null;
    confidence: number | null;
    entitlementState: string | null;
    activatedAt: Date | null;
  }>;
}

export async function paymentStatus(userId: string): Promise<PaymentStatusView> {
  return withTenant(userId, async (q) => {
    const user = (await q.query<{ plan_id: string; email: string }>('SELECT plan_id, email FROM users WHERE id = $1', [userId])).rows[0] ?? null;
    const entitlements = (await q.query<{ plan_id: string; state: string; verified_at: Date | null }>(
      `SELECT plan_id, state, verified_at FROM entitlements WHERE user_id = $1`,
      [userId],
    )).rows;
    const plans = await Promise.all(
      Object.keys(PLAN_PRICES_INR).map(async (planId) => {
        const intent = (await q.query<PaymentIntentRowLike>(
          `SELECT * FROM payment_intents WHERE owner_id = $1 AND plan_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [userId, planId],
        )).rows[0] ?? null;
        const ent = entitlements.find((e) => e.plan_id === planId);
        return {
          planId,
          intentStatus: intent?.status ?? null,
          confidence: intent ? Number(intent.confidence) : null,
          entitlementState: ent?.state ?? null,
          activatedAt: ent?.verified_at ?? null,
        };
      }),
    );
    return {
      effectivePlan: user?.plan_id ?? 'free',
      accountEmail: env.PAYMENT_ACCOUNT_EMAIL ?? null,
      plans,
    };
  });
}

interface PaymentIntentRowLike {
  status: string;
  confidence: number;
}