/**
 * CodeConClave — PAYMENT LINK-POOL service (POLICY B).
 *
 * Static Payment Link-Pool: automatic, 24x7, no-API / no-webhook / no-admin
 * payment activation where the entitlement binds to the AUTHENTICATED CHECKOUT
 * ACCOUNT'S reserved intent, NOT to the physical payer's identity (which this
 * subsystem never claims to prove).
 *
 * CORE SAFETY CONTRACT
 *   - Only is_active links are assigned.
 *   - Only one LIVE reservation per link (atomic conditional UPDATE is the
 *     race guard; also one live reservation per intent).
 *   - Reservation TTL = PAYMENT_POOL_TTL_MINUTES (default 15 min).
 *   - An expired reservation is irreversibly INVALID. Binding is by immutable
 *     link_index + link_reference_id, so a late callback binds to its exact
 *     reservation's intent — never "most recent" (OLD CALLBACK ≠ NEW
 *     RESERVATION).
 *   - Heartbeat / IP / timing / session cookie / email are TELEMETRY ONLY and
 *     NEVER entitlement authority. They are stored for audit/reconciliation.
 *   - If all links are reserved -> AppError.unavailable ALL_LINKS_BUSY_TRY_AGAIN.
 *
 * Reuse: activation remains the SOLE grant authority (applyDecision); this
 * module only reserves links and binds intents.
 */
import { withTenant, withSystem } from '../../../shared/db.js';
import { AppError } from '../../../shared/errors.js';
import { newId, PREFIX } from '../../../shared/ids.js';
import { env } from '../../../config/env.js';
import { paymentPoolConfig } from '../../../config/payment-pool.js';
import { recordAudit } from '../../audit/service.js';
import { createPaymentIntent, getIntent, type PaymentIntentRow } from '../intents.js';
import { paymentLinkForPlan } from '../service.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type ReservationStatus = 'RESERVED' | 'FULFILLED' | 'EXPIRED' | 'RELEASED';

export interface PoolLinkRow {
  link_index: number;
  payment_link_id: string | null;
  razorpay_url: string;
  reference_id: string;
  amount: number;
  currency: string;
  plan: 'pro' | 'team' | 'api';
  callback_path: string;
  is_active: boolean;
  /** Tombstone: set when this link's payment has been fulfilled. Consumed
   *  links are permanently non-allocatable regardless of is_active/config. */
  consumed_at: Date | null;
}

export interface ReservationRow {
  id: string;
  link_index: number;
  intent_id: string;
  user_id: string;
  workspace_id: string | null;
  plan: 'pro' | 'team' | 'api';
  amount_inr: number;
  currency: string;
  link_reference_id: string;
  status: ReservationStatus;
  session_id: string | null;
  client_ip: string | null;
  heartbeat_last: Date | null;
  reserved_at: Date;
  expires_at: Date;
  fulfilled_at: Date | null;
  payment_id: string | null;
}

export interface AssignLinkResult {
  intentId: string;
  intentReference: string;
  paymentUrl: string;
  linkIndex: number;
  linkReferenceId: string;
  paymentLinkId: string | null;
  expiresAt: Date;
  amountInr: number;
  currency: string;
  plan: string;
}

export interface StatusView {
  id: string;
  linkIndex: number | null;
  linkReferenceId: string | null;
  status: string;
  reservationStatus: string | null;
  expiresAt: Date | null;
  paymentUrl: string | null;
  amountInr: number;
  currency: string;
  plan: string;
}

export function poolEnabled(): boolean {
  return paymentPoolConfig().enabled;
}

function ttlMinutes(): number {
  return paymentPoolConfig().reservationTtlMinutes;
}

/** Raise 503 when the pool is entirely busy. */
function allLinksBusy(): never {
  throw AppError.unavailable('ALL_LINKS_BUSY_TRY_AGAIN', 'All payment links are currently reserved. Please try again shortly.');
}

export async function getLinkConfig(linkIndex: number): Promise<PoolLinkRow> {
  const row = await withSystem<PoolLinkRow | null>((db) =>
    db.query<PoolLinkRow>('SELECT * FROM payment_link_pool WHERE link_index = $1', [linkIndex]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('Payment link');
  return row;
}

export async function getReservationByIntent(userId: string, intentId: string): Promise<ReservationRow | null> {
  return withTenant<ReservationRow | null>(userId, (db) =>
    db
      .query<ReservationRow>('SELECT * FROM payment_link_reservations WHERE intent_id = $1 AND user_id = $2', [intentId, userId])
      .then((r) => r.rows[0] ?? null),
  );
}

export async function getReservationByLinkIndexAndIntent(linkIndex: number, intentId: string): Promise<ReservationRow | null> {
  return withSystem<ReservationRow | null>((db) =>
    db
      .query<ReservationRow>('SELECT * FROM payment_link_reservations WHERE link_index = $1 AND intent_id = $2', [linkIndex, intentId])
      .then((r) => r.rows[0] ?? null),
  );
}

/**
 * Atomically reserve a live link for an authenticated user's plan and return
 * the checkout result. Creates the intent if none is pending for that plan,
 * then binds it to a freshly-reserved link.
 *
 * Concurrency: `UPDATE payment_link_pool SET is_active = ...` is not the
 * reservation guard. The live-reservation unique index
 * (uq_pool_reservation_live_link) makes a double-reservation of the same link
 * impossible at the DB level. We pick a candidate link with
 * `FOR UPDATE SKIP LOCKED`, then attempt INSERT; on unique-violation we move to
 * the next candidate.
 */
export async function assignLink(
  userId: string,
  workspaceId: string | null,
  planId: string,
  telemetry: { sessionId?: string | null; clientIp?: string | null } = {},
): Promise<AssignLinkResult> {
  const cfg = paymentPoolConfig();
  if (!cfg.enabled) throw AppError.conflict('pool_disabled', 'Payment link pool is not enabled');

  // Reuse the authoritative intent creator (plan validation + dedupe of
  // active intents). If the user already has a pending/active intent for this
  // plan we reuse it (and its reservation, if any).
  let intent = await getExistingIntent(userId, planId);

  if (intent && intent.reservation_status === 'RESERVED') {
    return bindResultForIntent(intent);
  }

  // Candidate selection with row lock + skip-locked so concurrently-issued
  // assigns never pick the same live link. Only EVER allocatable links are
  // candidates: enabled AND not consumed (SPEC §24: one link = one purchase).
  const tryIndexes = candidateLinkIndexes(planId, cfg.size);
  for (const linkIndex of tryIndexes) {
    const link = await withTenant<PoolLinkRow | null>(userId, (db) =>
      db
        .query<PoolLinkRow>(
          `SELECT * FROM payment_link_pool
            WHERE link_index = $1 AND is_active = true AND consumed_at IS NULL
            FOR UPDATE SKIP LOCKED`,
          [linkIndex],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!link) continue;
    if (link.plan !== planId) continue;

    if (!intent) {
      intent = await createPaymentIntent(userId, planId);
      if (intent.reservation_status === 'RESERVED') return bindResultForIntent(intent);
    }
    const currentIntent = intent;

    const reservationId = newId(PREFIX.PAYMENT_RESERVATION);
    const expiresAt = new Date(Date.now() + ttlMinutes() * 60 * 1000);
    try {
      await withTenant(userId, (db) =>
        db.query(
          `INSERT INTO payment_link_reservations
             (id, link_index, intent_id, user_id, workspace_id, plan, amount_inr, currency,
              link_reference_id, status, session_id, client_ip, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RESERVED',$10,$11,$12)`,
          [
            reservationId, linkIndex, currentIntent.id, userId, workspaceId,
            link.plan, link.amount, link.currency, link.reference_id,
            telemetry.sessionId ?? null, telemetry.clientIp ?? null, expiresAt,
          ],
        ),
      );
    } catch (err) {
      const msg = String((err as { message?: string }).message ?? '');
      if (msg.includes('uq_pool_reservation_live_link') || msg.includes('uq_pool_reservation_live_intent')) {
        // Another request won this link or the intent is already reserved — retry next.
        intent = await getExistingIntent(userId, planId);
        continue;
      }
      throw err;
    }

    // Bind the intent to the reservation (telemetry + immutable link binding).
    // payment_link is set to the RESERVED pool link so the checkout hands the
    // payer the link whose provider callback resolves back to THIS reservation
    // — never the global per-plan static link (that link's callback cannot
    // bind to a pool reservation, so automatic activation would be impossible).
    // Placeholder links (non-explicit catalogue, paymentUrl = API_URL/cb/N) are
    // NOT payable; for those the intent's checkout URL is refreshed to the
    // authoritative per-plan static link (paymentLinkForPlan) so a stale link
    // frozen by an earlier broken config can never poison checkout. Intents
    // carrying a provider-created link artifact are left untouched.
    let bindPaymentLink: string;
    try {
      bindPaymentLink = cfg.explicit ? link.razorpay_url : paymentLinkForPlan(currentIntent.plan_id);
    } catch {
      bindPaymentLink = cfg.explicit ? link.razorpay_url : currentIntent.payment_link;
    }
    await withTenant(userId, (db) =>
      db.query(
        `UPDATE payment_intents
            SET pool_link_index = $2, pool_reference_id = $3, reservation_status = 'RESERVED',
                reservation_expires_at = $4, reservation_locked_at = now(),
                pool_session_id = $5, pool_client_ip = $6,
                payment_link = CASE WHEN provider_payment_link_id IS NULL THEN COALESCE($7, payment_link) ELSE payment_link END,
                updated_at = now()
          WHERE id = $1`,
        [currentIntent.id, linkIndex, link.reference_id, expiresAt, telemetry.sessionId ?? null, telemetry.clientIp ?? null, bindPaymentLink],
      ),
    );

    await recordAudit({
      action: 'payment.pool_link_reserved',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'payment_link_reservation',
      resourceId: reservationId,
      detail: { intentId: currentIntent.id, linkIndex, plan: planId, amountInr: link.amount, ttlMinutes: ttlMinutes() },
    });

    const fresh = await getIntent(userId, currentIntent.id);
    return bindResultForIntent(fresh);
  }

  allLinksBusy();
}

async function getExistingIntent(userId: string, planId: string): Promise<PaymentIntentRow | null> {
  const row = await withTenant<PaymentIntentRow | null>(userId, (db) =>
    db
      .query<PaymentIntentRow>(
        `SELECT * FROM payment_intents
          WHERE owner_id = $1 AND plan_id = $2 AND status IN ('PENDING','REVIEW','ACTIVE','GRACE')
          ORDER BY created_at DESC LIMIT 1`,
        [userId, planId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  return row;
}

async function bindResultForIntent(intent: PaymentIntentRow): Promise<AssignLinkResult> {
  if (intent.pool_link_index != null && intent.pool_reference_id) {
    // The intent is bound to a pool reservation. When the catalogue is an
    // explicit (real) pool, the checkout MUST point the payer at the RESERVED
    // pool link (razorpay_url), not the intent's original per-plan static
    // link, so the provider callback for the link actually paid resolves back
    // to this exact reservation and activates via the pipeline. Resolve the
    // pool record as the single source of truth.
    const link = await withSystem<PoolLinkRow | null>((db) =>
      db.query<PoolLinkRow>('SELECT * FROM payment_link_pool WHERE link_index = $1', [intent.pool_link_index]).then((r) => r.rows[0] ?? null),
    );
    if (link && paymentPoolConfig().explicit) {
      return {
        intentId: intent.id,
        intentReference: intent.reference,
        paymentUrl: link.razorpay_url,
        linkIndex: intent.pool_link_index,
        linkReferenceId: intent.pool_reference_id,
        paymentLinkId: link.payment_link_id,
        expiresAt: intent.reservation_expires_at ?? intent.expires_at,
        amountInr: intent.amount_inr,
        currency: intent.currency,
        plan: intent.plan_id,
      };
    }
  }
  // No reservation bound (e.g., reused a legacy/active intent), the pool
  // record is unavailable, or the catalogue is a non-explicit (placeholder)
  // pool whose links are not payable — treat as a pending intent page without
  // a new link; still safe but not a reservation.
  return {
    intentId: intent.id,
    intentReference: intent.reference,
    paymentUrl: intent.payment_link,
    linkIndex: intent.pool_link_index ?? 0,
    linkReferenceId: intent.pool_reference_id ?? '',
    paymentLinkId: intent.provider_payment_link_id ?? null,
    expiresAt: intent.reservation_expires_at ?? intent.expires_at,
    amountInr: intent.amount_inr,
    currency: intent.currency,
    plan: intent.plan_id,
  };
}

/** Deterministic candidate order: round-robin-ish over live links, then disabled-out. */
function candidateLinkIndexes(planId: string, size: number): number[] {
  const out: number[] = [];
  // Prefer links matching the plan; the DB layer filters enabled + plan.
  for (let i = 1; i <= size; i += 1) out.push(i);
  // Bias toward links whose plan matches, but the post-fetch plan check handles it.
  void planId;
  return out;
}

/**
 * Release a reservation (mark RELEASED) and clear the intent's reservation
 * binding so the link can be assigned to a new intent. Only RESERVED
 * reservations can be released. FULFILLED/EXPIRED are terminal. The immutable
 * link reference binding on the intent is cleared so a late callback for the
 * old assignment cannot resolve to this (new) intent.
 */
export async function releaseLink(userId: string, intentId: string): Promise<void> {
  const res = await getReservationByIntent(userId, intentId);
  if (!res || res.status !== 'RESERVED') return;
  await withTenant(userId, (db) =>
    db.query(
      `UPDATE payment_link_reservations SET status = 'RELEASED', updated_at = now() WHERE id = $1 AND status = 'RESERVED'`,
      [res.id],
    ),
  );
  await withTenant(userId, (db) =>
    db.query(
      `UPDATE payment_intents SET pool_link_index = NULL, pool_reference_id = NULL, reservation_status = 'RELEASED',
          reservation_expires_at = NULL, pool_session_id = NULL, pool_client_ip = NULL, pool_heartbeat_last = NULL,
          updated_at = now() WHERE id = $1`,
      [intentId],
    ),
  );
  await recordAudit({
    action: 'payment.pool_link_released',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_link_reservation',
    resourceId: res.id,
    detail: { intentId, linkIndex: res.link_index },
  });
}

/**
 * Heartbeat: refresh the reservation's heartbeat telemetry. NEVER grants an
 * entitlement — it only extends nothing (TTL is fixed). Stored as telemetry
 * only. Requires ownership.
 */
export async function heartbeat(userId: string, intentId: string, sessionId?: string | null, ip?: string | null): Promise<{ ok: boolean; intentId: string }> {
  const res = await getReservationByIntent(userId, intentId);
  if (!res || res.status !== 'RESERVED') {
    throw AppError.conflict('reservation_not_active', 'No active reservation for this intent');
  }
  await withTenant(userId, (db) =>
    db.query(
      `UPDATE payment_link_reservations SET heartbeat_last = now(), session_id = COALESCE($2, session_id), client_ip = COALESCE($3, client_ip), updated_at = now() WHERE id = $1`,
      [res.id, sessionId ?? null, ip ?? null],
    ),
  );
  await withTenant(userId, (db) =>
    db.query(`UPDATE payment_intents SET pool_heartbeat_last = now(), pool_session_id = COALESCE($2, pool_session_id) WHERE id = $1`, [
      intentId,
      sessionId ?? null,
    ]),
  );
  return { ok: true, intentId };
}

/** Status for the authenticated owner (ownership-checked at the route). */
export async function getIntentStatus(userId: string, intentId: string): Promise<StatusView> {
  const intent = await getIntent(userId, intentId);
  const res = await getReservationByIntent(userId, intentId);
  return {
    id: intent.id,
    linkIndex: intent.pool_link_index ?? null,
    linkReferenceId: intent.pool_reference_id ?? null,
    status: intent.status,
    reservationStatus: res?.status ?? intent.reservation_status ?? null,
    expiresAt: intent.reservation_expires_at ?? intent.expires_at,
    paymentUrl: intent.payment_link ?? null,
    amountInr: intent.amount_inr,
    currency: intent.currency,
    plan: intent.plan_id,
  };
}

// ---------------------------------------------------------------------------
// Watchdog: expire + release stale reservations (Phase 9)
// ---------------------------------------------------------------------------

/**
 * Expire STALE reservations (past TTL, still RESERVED) and mark the intent's
 * reservation binding EXPIRED so a late callback can never activate it. The
 * link is NOT re-assigned here (a fresh assign just picks another live link);
 * this just makes the old reservation terminal and immutable.
 */
export async function expireStaleReservations(): Promise<number> {
  const upcoming = await withSystem<{ id: string; link_index: number; intent_id: string; user_id: string }[]>((db) =>
    db
      .query<{ id: string; link_index: number; intent_id: string; user_id: string }>(
        `SELECT id, link_index, intent_id, user_id FROM payment_link_reservations
          WHERE status = 'RESERVED' AND expires_at <= now()`,
      )
      .then((r) => r.rows),
  );
  for (const res of upcoming) {
    // Conditional UPDATE is the safe terminal transition (never double-expire).
    await withSystem((db) =>
      db.query(
        `UPDATE payment_link_reservations SET status = 'EXPIRED', updated_at = now() WHERE id = $1 AND status = 'RESERVED'`,
        [res.id],
      ),
    );
    await withSystem((db) =>
      db.query(
        `UPDATE payment_intents SET reservation_status = 'EXPIRED', pool_link_index = NULL, pool_reference_id = NULL,
            reservation_expires_at = NULL, pool_session_id = NULL, pool_client_ip = NULL, pool_heartbeat_last = NULL,
            updated_at = now() WHERE id = $1 AND reservation_status = 'RESERVED'`,
        [res.intent_id],
      ),
    );
    await recordAudit({
      action: 'payment.pool_reservation_expired',
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: res.user_id,
      resourceType: 'payment_link_reservation',
      resourceId: res.id,
      detail: { intentId: res.intent_id, linkIndex: res.link_index },
    });
  }
  return upcoming.length;
}

/** Full DB-backed reservation lookup by immutable link reference (used by callback). */
export async function reservationByLinkReference(linkReferenceId: string): Promise<ReservationRow | null> {
  return withSystem<ReservationRow | null>((db) =>
    db
      .query<ReservationRow>('SELECT * FROM payment_link_reservations WHERE link_reference_id = $1 ORDER BY reserved_at DESC LIMIT 1', [
        linkReferenceId,
      ])
      .then((r) => r.rows[0] ?? null),
  );
}

// ---------------------------------------------------------------------------
// Callback helpers (Phase 6/7)
// ---------------------------------------------------------------------------

export interface CallbackFields {
  razorpayPaymentId: string | null;
  razorpayPaymentLinkId: string | null;
  razorpayPaymentLinkReferenceId: string | null;
  razorpayPaymentLinkStatus: string | null;
  razorpaySignature: string | null;
}

export function extractCallbackFields(query: Record<string, unknown>): CallbackFields {
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
  return {
    razorpayPaymentId: s(query.razorpay_payment_id) ?? s(query.payment_id) ?? null,
    razorpayPaymentLinkId: s(query.razorpay_payment_link_id) ?? null,
    razorpayPaymentLinkReferenceId: s(query.razorpay_payment_link_reference_id) ?? s(query.razorpay_payment_link_reference) ?? null,
    razorpayPaymentLinkStatus: s(query.razorpay_payment_link_status) ?? null,
    razorpaySignature: s(query.razorpay_signature) ?? null,
  };
}

/**
 * Verify a Razorpay payment-link callback HMAC-SHA256 using the RAZORPAY API
 * secret (NOT the webhook secret). The message is a callback field string —
 * the provider-AUTHENTIC payment-link redirect joins the four fields with '|'
 * in the official SDK order (payment_link_id|payment_link_reference_id|
 * payment_link_status|payment_id — see razorpay-node lib/utils/razorpay-utils.js);
 * the legacy in-repo scheme joins reference_id:payment_id. Both are checked by
 * the pool callback; the authentic scheme is what a real Razorpay redirect
 * carries. Uses a timing-safe comparison (never string ==).
 */
export function verifyCallbackSignature(
  message: string,
  signature: string | null,
  secret = env.RAZORPAY_KEY_SECRET,
): boolean {
  if (!secret || !signature || !message) return false;
  try {
    const expected = createHmac('sha256', secret).update(message).digest('hex');
    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Record a callback outcome (dedupe + audit), returns whether it is a new record. */
export async function recordCallbackOutcome(
  fields: { paymentId: string | null; linkIndex: number | null; paymentLinkId: string | null; referenceId: string | null; linkStatus: string | null },
  signatureValid: boolean,
  outcome: string,
  reason: string,
): Promise<{ id: string; created: boolean }> {
  const paymentId = fields.paymentId ?? `cb-${newId(PREFIX.PAYMENT_RESERVATION)}`;
  const existing = await withSystem<{ id: string } | null>((db) =>
    db.query<{ id: string }>('SELECT id FROM payment_pool_callbacks WHERE payment_id = $1', [paymentId]).then((r) => r.rows[0] ?? null),
  );
  if (existing) return { id: existing.id, created: false };

  const id = newId(PREFIX.PAYMENT_CALLBACK);
  const sigSha = createHmac('sha256', 'cc-callback-log').update(paymentId).digest('hex');
  try {
    await withSystem((db) =>
      db.query(
        `INSERT INTO payment_pool_callbacks
           (id, link_index, payment_id, payment_link_id, reference_id, link_status, signature_sha, signature_valid, outcome, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, fields.linkIndex, paymentId, fields.paymentLinkId, fields.referenceId, fields.linkStatus, sigSha, signatureValid, outcome, reason],
      ),
    );
    return { id, created: true };
  } catch (err) {
    const msg = String((err as { message?: string }).message ?? '');
    if (msg.includes('uq_pool_callbacks_payment')) return { id: 'duplicate', created: false };
    throw err;
  }
}
