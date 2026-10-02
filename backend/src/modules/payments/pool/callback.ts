/**
 * CodeConClave — PAYMENT LINK-POOL callback handler (POLICY B) + Phase 6
 * late-callback protection.
 *
 * Flow:
 *   GET /cb/:linkIndex
 *     extract fields (payment_id, payment_link_id, reference_id, status, sig)
 *     -> verify HMAC (timingSafeEqual) with RAZORPAY_KEY_SECRET
 *     -> payment_id present
 *     -> payment_id not already fulfilled (dedupe ledger)
 *     -> linkIndex maps to enabled pool record
 *     -> payment_link_id matches pool record
 *     -> reference_id matches pool record
 *     -> status acceptable
 *     -> exact reservation exists (by immutable link reference)
 *     -> reservation still valid (not expired/released/fulfilled)
 *     -> reservation belongs to exact link
 *     -> intent exists, owned by reservation's user
 *     -> intent.plan matches pool.plan
 *     -> intent amount matches pool amount
 *     -> currency matches pool currency
 *     -> ownership still valid (user/workspace)
 *     -> fraud gates pass
 *     -> payment_id not processed before
 *   only then: route through the trusted pipeline (razorpay_callback) which
 *   invokes the authoritative applyDecision -> entitlement. activation.ts is
 *   the SOLE grant authority; this module never grants directly.
 *
 * LATE CALLBACK PROTECTION (Phase 6, invariant OLD CALLBACK != NEW RESERVATION)
 *   Binding is by immutable link_index + link_reference_id. A callback always
 *   resolves to the reservation that was live at payment time via
 *   link_reference_id; an expired/released/fulfilled reservation is fail-closed
 *   and NEVER activates the current (newer) reservation or intent. No "most
 *   recent intent wins" logic exists.
 */
import { withSystem, withTenant } from '../../../shared/db.js';
import { recordAudit } from '../../audit/service.js';
import { ingestEvidence } from '../pipeline.js';
import { getIntent, purchaseTypeForPlan, type PaymentIntentRow } from '../intents.js';
import { checkFraud } from '../fraud.js';
import { signalSha256 } from '../evidence.js';
import {
  getLinkConfig,
  recordCallbackOutcome,
  verifyCallbackSignature,
  extractCallbackFields,
  type CallbackFields,
  type PoolLinkRow,
  type ReservationRow,
} from './service.js';

export type CallbackOutcome =
  | 'accepted'
  | 'duplicate'
  | 'invalid_signature'
  | 'bad_link_index'
  | 'link_disabled'
  | 'link_id_mismatch'
  | 'reference_mismatch'
  | 'bad_status'
  | 'no_reservation'
  | 'reservation_expired'
  | 'reservation_released'
  | 'reservation_fulfilled'
  | 'intent_not_found'
  | 'intent_plan_mismatch'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'ownership_revoked'
  | 'fraud_blocked'
  | 'orphaned'
  | 'ambiguous';

export interface CallbackResult {
  outcome: CallbackOutcome;
  intentId: string | null;
  reservationId: string | null;
  linkIndex: number | null;
  reason: string;
  activated: boolean;
}

const ACCEPTABLE_LINK_STATUSES = new Set(['paid']);

const BLOCKING_FRAUD_FLAGS = new Set(['duplicate_payment_id', 'screenshot_replay', 'reference_reuse', 'amount_mismatch', 'plan_mismatch']);

export async function handlePoolCallback(linkIndexRaw: string, query: Record<string, unknown>): Promise<CallbackResult> {
  const linkIndex = Number(linkIndexRaw);
  const fields = extractCallbackFields(query);

  // ---- 1. signature valid ----
  if (!verifyPoolSignature(fields)) {
    await recordCallbackOutcome({ paymentId: fields.razorpayPaymentId, linkIndex: Number.isInteger(linkIndex) ? linkIndex : null, paymentLinkId: fields.razorpayPaymentLinkId, referenceId: fields.razorpayPaymentLinkReferenceId, linkStatus: fields.razorpayPaymentLinkStatus }, false, 'invalid_signature', 'HMAC verification failed');
    return fail('invalid_signature', linkIndex, fields, 'HMAC verification failed');
  }
  if (!Number.isInteger(linkIndex) || linkIndex < 1) {
    await recordCallbackOutcome({ paymentId: fields.razorpayPaymentId, linkIndex: null, paymentLinkId: fields.razorpayPaymentLinkId, referenceId: fields.razorpayPaymentLinkReferenceId, linkStatus: fields.razorpayPaymentLinkStatus }, true, 'bad_link_index', 'invalid link index');
    return fail('bad_link_index', null, fields, 'Invalid link index');
  }

  // ---- 2. payment_id present ----
  if (!fields.razorpayPaymentId) {
    await recordCallbackOutcome({ paymentId: null, linkIndex, paymentLinkId: fields.razorpayPaymentLinkId, referenceId: fields.razorpayPaymentLinkReferenceId, linkStatus: fields.razorpayPaymentLinkStatus }, true, 'bad_link_index', 'payment_id missing');
    return fail('bad_link_index', linkIndex, fields, 'payment_id is required');
  }

  // ---- 3. dedupe by payment_id (ledger) ----
  const ledger = await withSystem<{ id: string; outcome: string } | null>(async (q) =>
    q
      .query<{ id: string; outcome: string }>('SELECT id, outcome FROM payment_pool_callbacks WHERE payment_id = $1', [
        fields.razorpayPaymentId,
      ])
      .then((r) => r.rows[0] ?? null),
  );
  if (ledger) {
    // Already processed; idempotent no-op. A non-activating ledger outcome is
    // still terminal — we never retry a previously-seen payment_id.
    return { outcome: 'duplicate', intentId: null, reservationId: null, linkIndex, reason: `payment already processed (${ledger.outcome})`, activated: false };
  }

  // ---- 4. linkIndex maps to enabled pool record ----
  let link: PoolLinkRow;
  try {
    link = await getLinkConfig(linkIndex);
  } catch {
    await markOutcome(fields, linkIndex, 'bad_link_index', 'no such link in pool');
    return fail('bad_link_index', linkIndex, fields, 'unknown link index');
  }
  if (!link.is_active) {
    await markOutcome(fields, linkIndex, 'link_disabled', 'link is disabled');
    return fail('link_disabled', linkIndex, fields, 'link is disabled');
  }

  // ---- 5. payment_link_id matches pool record ----
  if (fields.razorpayPaymentLinkId && link.payment_link_id && fields.razorpayPaymentLinkId !== link.payment_link_id) {
    await markOutcome(fields, linkIndex, 'link_id_mismatch', 'payment_link_id does not match pool link');
    return fail('link_id_mismatch', linkIndex, fields, 'payment_link_id mismatch');
  }

  // ---- 6. reference_id matches pool record ----
  if (fields.razorpayPaymentLinkReferenceId && fields.razorpayPaymentLinkReferenceId !== link.reference_id) {
    await markOutcome(fields, linkIndex, 'reference_mismatch', 'reference does not match pool link');
    return fail('reference_mismatch', linkIndex, fields, 'reference mismatch');
  }

  // ---- 7. status acceptable ----
  if (fields.razorpayPaymentLinkStatus && !ACCEPTABLE_LINK_STATUSES.has(fields.razorpayPaymentLinkStatus)) {
    await markOutcome(fields, linkIndex, 'bad_status', `status ${fields.razorpayPaymentLinkStatus}`);
    return fail('bad_status', linkIndex, fields, 'payment link status not acceptable');
  }

  // ---- 8-10. exact reservation exists, still valid, belongs to exact link ----
  const reservations = await queryReservationsByLinkReference(link.reference_id);
  const res = reservations[0] ?? null;
  if (!res) {
    await markOutcome(fields, linkIndex, 'orphaned', 'no reservation for this link reference');
    return fail('orphaned', linkIndex, fields, 'no matching reservation (orphaned)');
  }
  if (res.link_index !== linkIndex) {
    await markOutcome(fields, linkIndex, 'reference_mismatch', 'reservation link mismatch');
    return fail('reference_mismatch', linkIndex, fields, 'reservation belongs to a different link');
  }
  if (res.status === 'EXPIRED' || (res.expires_at && res.expires_at.getTime() <= Date.now())) {
    await markOutcome(fields, linkIndex, 'reservation_expired', `reservation expired at ${res.expires_at?.toISOString()}`);
    return fail('reservation_expired', linkIndex, fields, 'reservation expired (late callback rejected)');
  }
  if (res.status === 'RELEASED') {
    await markOutcome(fields, linkIndex, 'reservation_released', 'reservation released');
    return fail('reservation_released', linkIndex, fields, 'reservation released (late callback rejected)');
  }
  if (res.status === 'FULFILLED') {
    await markOutcome(fields, linkIndex, 'reservation_fulfilled', 'reservation already fulfilled');
    return fail('reservation_fulfilled', linkIndex, fields, 'reservation already fulfilled');
  }
  if (res.status !== 'RESERVED') {
    await markOutcome(fields, linkIndex, 'ambiguous', `reservation status ${res.status}`);
    return fail('ambiguous', linkIndex, fields, 'ambiguous reservation state');
  }

  // ---- 11-13. intent exists / plan / amount / currency ----
  let intentId = res.intent_id;
  let intent: PaymentIntentRow;
  try {
    intent = await getIntent(res.user_id, res.intent_id);
  } catch {
    await markOutcome(fields, linkIndex, 'intent_not_found', 'intent not found for reservation');
    return fail('intent_not_found', linkIndex, fields, 'intent not found');
  }
  const samePlan = link.plan === intent.plan_id;
  if (!samePlan) {
    await markOutcome(fields, linkIndex, 'intent_plan_mismatch', `intent plan ${intent.plan_id} != pool plan ${link.plan}`);
    return fail('intent_plan_mismatch', linkIndex, fields, 'plan mismatch');
  }
  // Product identity: the intent's explicit purchase_type must match its own
  // plan. Never infer a product from the amount/link — Team (₹4,999) and API
  // Access (₹9,999) are separate products. API Access is fail-closed — a
  // missing/wrong purchase_type never activates. For legacy pro/team intents a
  // present-but-wrong value is also rejected; a null purchase_type (pre-column
  // rows) is tolerated.
  const expectedPurchaseType = purchaseTypeForPlan(intent.plan_id);
  const actualPurchaseType = intent.purchase_type ?? null;
  if (intent.plan_id === 'api') {
    if (actualPurchaseType !== 'api_access') {
      await markOutcome(fields, linkIndex, 'intent_plan_mismatch', `purchase_type ${actualPurchaseType ?? 'missing'} != api_access`);
      return fail('intent_plan_mismatch', linkIndex, fields, 'purchase type mismatch (API Access requires api_access intent)');
    }
  } else if (actualPurchaseType !== null && actualPurchaseType !== expectedPurchaseType) {
    await markOutcome(fields, linkIndex, 'intent_plan_mismatch', `purchase_type ${actualPurchaseType} != ${expectedPurchaseType}`);
    return fail('intent_plan_mismatch', linkIndex, fields, 'purchase type mismatch');
  }
  if (link.amount !== intent.amount_inr) {
    await markOutcome(fields, linkIndex, 'amount_mismatch', `amount ${link.amount} != intent ${intent.amount_inr}`);
    return fail('amount_mismatch', linkIndex, fields, 'amount mismatch');
  }
  if ((link.currency ?? 'INR') !== (intent.currency ?? 'INR')) {
    await markOutcome(fields, linkIndex, 'currency_mismatch', 'currency mismatch');
    return fail('currency_mismatch', linkIndex, fields, 'currency mismatch');
  }

  // ---- 14. ownership still valid ----
  if (res.user_id !== intent.owner_id) {
    await markOutcome(fields, linkIndex, 'ownership_revoked', 'reservation user != intent owner');
    return fail('ownership_revoked', linkIndex, fields, 'ownership mismatch');
  }

  // ---- 15. fraud gates pass (reuse existing checkFraud) ----
  const signals = {
    reference: link.reference_id,
    amountInr: link.amount,
    paidAt: new Date().toISOString(),
    paymentId: fields.razorpayPaymentId,
  };
  const sha = signalSha256(signals as Parameters<typeof signalSha256>[0]);
  const fraud = await checkFraud(res.user_id, intent, signals as Parameters<typeof checkFraud>[2], sha, 0);
  if (fraud.blocked || fraud.flags.some((f) => BLOCKING_FRAUD_FLAGS.has(f))) {
    await markOutcome(fields, linkIndex, 'fraud_blocked', `fraud flags ${fraud.flags.join(',')}`);
    await recordAudit({ action: 'payment.pool_callback_fraud', actorUserId: null, scope: 'SYSTEM', tenantId: res.user_id, resourceType: 'payment_intent', resourceId: intentId, detail: { flags: fraud.flags, paymentId: fields.razorpayPaymentId } });
    return fail('fraud_blocked', linkIndex, fields, `fraud gate blocked: ${fraud.flags.join(',')}`);
  }

  // ---- 16. payment_id not processed before (redundant guard) ----
  const priorEvidence = await withSystem<{ id: string } | null>(async (q) =>
    q
      .query<{ id: string }>(`SELECT id FROM payment_evidence WHERE provider_payment_id = $1`, [fields.razorpayPaymentId])
      .then((r) => r.rows[0] ?? null),
  );
  if (priorEvidence) {
    await markOutcome(fields, linkIndex, 'duplicate', 'payment_id already fulfilled');
    return fail('duplicate', linkIndex, fields, 'payment already processed');
  }

  // ---- route through the trusted pipeline (razorpay_callback) -> applyDecision ----
  try {
    const result = await ingestEvidence(res.user_id, intentId, 'razorpay_callback', {
      paymentId: fields.razorpayPaymentId,
      paymentLinkId: fields.razorpayPaymentLinkId,
      referenceId: link.reference_id,
      linkStatus: fields.razorpayPaymentLinkStatus,
      amountInr: link.amount,
    });
    const activated = result.result?.decision === 'ACTIVE' && result.result?.intentStatus === 'ACTIVE';
    await finalizeReservation(res.user_id, res.id, intentId, fields.razorpayPaymentId, linkIndex);
    await markOutcome(fields, linkIndex, 'accepted', `pipeline decision ${result.result?.decision ?? 'none'}`);
    await recordAudit({
      action: activated ? 'payment.pool_callback_activated' : 'payment.pool_callback_review',
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: res.user_id,
      resourceType: 'payment_intent',
      resourceId: intentId,
      detail: { decision: result.result?.decision, confidence: result.result?.confidence, paymentId: fields.razorpayPaymentId, linkIndex },
    });
    return {
      outcome: activated ? 'accepted' : 'ambiguous',
      intentId,
      reservationId: res.id,
      linkIndex,
      reason: activated ? 'activated' : `pipeline did not activate (${result.result?.decision ?? 'none'})`,
      activated,
    };
  } catch (err) {
    const outcome: CallbackOutcome = 'ambiguous';
    await markOutcome(fields, linkIndex, outcome, `pipeline error ${String((err as { message?: string }).message ?? '')}`);
    return fail(outcome, linkIndex, fields, 'pipeline rejected activation');
  }
}

function verifyPoolSignature(fields: CallbackFields): boolean {
  // Provider-AUTHENTIC payment-link redirect signature: Razorpay computes an
  // HMAC-SHA256 over the four callback fields concatenated with '|' in this
  // EXACT order — payment_link_id, payment_link_reference_id, payment_link_status,
  // payment_id — using the RAZORPAY_KEY_SECRET (matching the official
  // razorpay-node SDK: lib/utils/razorpay-utils.js). The paying browser is
  // redirected back with those fields + razorpay_signature. This is the ONLY
  // scheme a real Razorpay payment-link callback carries. Without it a real
  // callback would fail verification here and be permanently ledged
  // invalid_signature (never activating), so it is checked FIRST.
  const authentic = [
    fields.razorpayPaymentLinkId,
    fields.razorpayPaymentLinkReferenceId,
    fields.razorpayPaymentLinkStatus,
    fields.razorpayPaymentId,
  ]
    .map((f) => f ?? '')
    .join('|');
  if (verifyCallbackSignature(authentic, fields.razorpaySignature)) return true;

  // Legacy in-repo signed message (reference_id:payment_id). Accepted for
  // backward compatibility with self-signed/internal rails (gmail-claim-style
  // resolvers and existing tests). Both schemes still require RAZORPAY_KEY_SECRET,
  // so accepting both never weakens authenticity — forgery requires the secret
  // either way.
  const legacy = `${fields.razorpayPaymentLinkReferenceId ?? ''}:${fields.razorpayPaymentId ?? ''}`;
  return verifyCallbackSignature(legacy, fields.razorpaySignature);
}

async function queryReservationsByLinkReference(referenceId: string): Promise<ReservationRow[]> {
  return withSystem<ReservationRow[]>(async (q) =>
    (
      await q.query<ReservationRow>(
        `SELECT * FROM payment_link_reservations WHERE link_reference_id = $1 ORDER BY reserved_at DESC LIMIT 1`,
        [referenceId],
      )
    ).rows,
  );
}

/** Mark the reservation FULFILLED + bind payment_id (idempotent, guarded). */
async function finalizeReservation(
  userId: string,
  reservationId: string,
  intentId: string,
  paymentId: string,
  linkIndex: number,
): Promise<void> {
  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE payment_link_reservations
          SET status = 'FULFILLED', fulfilled_at = now(), payment_id = COALESCE($3, payment_id),
              expires_at = GREATEST(expires_at, now()), updated_at = now()
        WHERE id = $1 AND status = 'RESERVED'`,
      [reservationId, paymentId, paymentId],
    );
    await q.query(
      `UPDATE payment_intents SET reservation_status = 'FULFILLED', reservation_fulfilled_at = now(), reservation_expires_at = NULL, updated_at = now() WHERE id = $1 AND owner_id = $2`,
      [intentId, userId],
    );
  });
  await consumePoolLink(linkIndex);
}

/** SPEC §24: a fulfilled payment link is permanently non-allocatable. Sets the
 *  consumed tombstone and clears is_active so no future assign can hand the
 *  link out (the seeder also preserves consumed rows). Idempotent + fail-open
 *  for the fulfillment flow: an error here must never block activation, so the
 *  tombstone is best-effort within the same request. */
async function consumePoolLink(linkIndex: number): Promise<void> {
  try {
    await withSystem((q) =>
      q.query(
        `UPDATE payment_link_pool
            SET consumed_at = COALESCE(consumed_at, now()), is_active = false
          WHERE link_index = $1`,
        [linkIndex],
      ),
    );
  } catch (err) {
    // Never fail the checkout/fulfillment because the tombstone write failed;
    // the reservation/intent state is already committed above. Log + continue.
    console.error(`[payment-pool] failed to consume link ${linkIndex} after fulfillment:`, err instanceof Error ? err.message : String(err));
  }
}

async function markOutcome(fields: CallbackFields, linkIndex: number, outcome: CallbackOutcome, reason: string): Promise<void> {
  await recordCallbackOutcome(
    { paymentId: fields.razorpayPaymentId, linkIndex, paymentLinkId: fields.razorpayPaymentLinkId, referenceId: fields.razorpayPaymentLinkReferenceId, linkStatus: fields.razorpayPaymentLinkStatus },
    true,
    outcome,
    reason,
  );
}

function fail(outcome: CallbackOutcome, linkIndex: number | null, _fields: CallbackFields, reason: string): CallbackResult {
  return { outcome, intentId: null, reservationId: null, linkIndex, reason, activated: false };
}
