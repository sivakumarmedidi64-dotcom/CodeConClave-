/**
 * CodeConClave — Gmail claim rail: zero-admin automatic payment activation.
 *
 * Flow:
 *   1. Apps Script detects Razorpay payment confirmation in Gmail
 *   2. Apps Script sends HMAC-signed payload to POST /api/v1/payments/gmail-claim/request
 *   3. Backend verifies HMAC, validates amount, deduplicates, creates one-time claim token
 *   4. Backend emails claim link to the payer
 *   5. Payer clicks claim link → POST /api/v1/payments/gmail-claim/activate
 *   6. Backend verifies token (hash, expiry, single-use), activates entitlement
 *
 * Trust model:
 *   - Apps Script is trusted intermediary (HMAC proves authenticity)
 *   - Never trust payer email alone (must match intent's reference)
 *   - Never trust amount alone (must match server-authoritative price)
 *   - Payment ID is evidence, not authority (dedup key, not activation key)
 *   - One-time claim token: SHA-256 hashed, short-lived, single-use
 *   - Manual/OCR/user assertions remain REVIEW-only
 */
import { withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { sha256Hex, randomToken } from '../../shared/crypto.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { wrapEmailHtml } from '../email/brand.js';
import { NotificationType } from '@codeconclave/shared';
import { PLAN_PRICES_INR, activateEntitlement } from './service.js';
import { enqueueOutbox } from '../outbox/service.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface GmailClaimPayload {
  paymentId: string | null;
  amount: number | null;
  plan: string | null;
  payerEmail: string | null;
  paidAt: string | null;
  reference: string | null;
}

export interface GmailClaimRequest {
  payload: GmailClaimPayload;
  timestamp: number;
  signature: string;
}

export interface GmailClaimRow {
  id: string;
  intent_id: string;
  owner_id: string;
  plan_id: string;
  amount_inr: number;
  payer_email: string;
  payment_id: string | null;
  reference: string;
  token_hash: string;
  status: string;
  activated_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

export function gmailClaimEnabled(): boolean {
  return env.GMAIL_CLAIM_ENABLED === 'true' && Boolean(env.GMAIL_CLAIM_HMAC_SECRET);
}

/**
 * Verify HMAC-SHA256 signature from Apps Script.
 * The signature is computed over `timestamp:JSON.stringify(payload)`.
 * Uses timing-safe comparison to prevent timing attacks.
 * Pure: the secret is passed in (testable without env mutation).
 */
export function verifyGmailClaimSignature(
  payload: GmailClaimPayload,
  timestamp: number,
  signature: string,
  secret = env.GMAIL_CLAIM_HMAC_SECRET,
): boolean {
  if (!secret || !signature) return false;

  const message = `${timestamp}:${JSON.stringify(payload)}`;
  const expected = createHmac('sha256', secret).update(message).digest('hex');

  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Check if timestamp is within tolerance window (default 5 minutes).
 * Pure: tolerance is passed in (testable without env mutation).
 */
export function isTimestampValid(
  timestamp: number,
  toleranceSeconds = env.GMAIL_CLAIM_TIMESTAMP_TOLERANCE_SECONDS,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const nowSec = Math.floor(nowMs / 1000);
  const diff = Math.abs(nowSec - timestamp);
  return diff <= toleranceSeconds;
}

/**
 * Deduplicate by payment ID.
 */
async function isDuplicatePayment(paymentId: string | null): Promise<boolean> {
  if (!paymentId || paymentId.trim().length === 0) return false;
  const existing = await withSystem(async (q) =>
    (
      await q.query<{ id: string }>(`SELECT id FROM payment_claims WHERE payment_id = $1`, [paymentId.trim()])
    ).rows[0],
  );
  return !!existing;
}

/**
 * Find intent by reference. Server-authoritative: the reference is the
 * exact server-issued unique identifier.
 */
async function findIntentByReference(reference: string): Promise<{
  id: string;
  owner_id: string;
  plan_id: string;
  amount_inr: number;
  reference: string;
  status: string;
} | null> {
  return withSystem(async (q) => {
    const rows = await q.query(
      `SELECT id, owner_id, plan_id, amount_inr, reference, status
         FROM payment_intents
        WHERE reference = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [reference],
    );
    return rows.rows[0] ?? null;
  });
}

/**
 * Create a one-time claim token and return the raw token + URL.
 * Token is SHA-256 hashed before storage (never stored in plaintext).
 */
async function createClaimToken(
  intentId: string,
  ownerId: string,
  planId: string,
  amountInr: number,
  payerEmail: string,
  paymentId: string | null,
  reference: string,
): Promise<{ tokenId: string; claimId: string; claimUrl: string }> {
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const id = newId(PREFIX.PAYMENT_CLAIM);
  const ttlHours = env.GMAIL_CLAIM_TOKEN_TTL_HOURS;

  await withSystem(async (q) => {
    await q.query(
      `INSERT INTO payment_claims (id, intent_id, owner_id, plan_id, amount_inr, payer_email, payment_id, reference, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', now() + make_interval(hours => $10))`,
      [id, intentId, ownerId, planId, amountInr, payerEmail, paymentId, reference, tokenHash, ttlHours],
    );
  });

  const claimUrl = `${env.APP_URL}/claim?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`;

  return { tokenId: token, claimId: id, claimUrl };
}

/**
 * Send claim email to the payer via the outbox (transactional email delivery).
 */
async function sendClaimEmail(
  payerEmail: string,
  planId: string,
  amountInr: number,
  claimUrl: string,
): Promise<void> {
  const subject = `Complete your CodeConClave ${planId.toUpperCase()} activation`;
  const html = wrapEmailHtml(
    `Complete your ${planId.toUpperCase()} activation`,
    [
      `<p>We received your payment of <strong>₹${amountInr.toLocaleString('en-IN')}</strong> for the <strong>${planId.toUpperCase()}</strong> plan.</p>`,
      `<p>Click the link below to activate your subscription:</p>`,
      `<p><a href="${claimUrl}" style="display:inline-block;padding:12px 24px;background:#6366f1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Activate ${planId.toUpperCase()} Plan</a></p>`,
      `<p>This link expires in ${env.GMAIL_CLAIM_TOKEN_TTL_HOURS} hours and can only be used once.</p>`,
      `<p>If you did not make this payment, please ignore this email.</p>`,
    ].join('\n'),
  );

  await enqueueOutbox('payment.claim_email', {
    channel: 'email',
    to: payerEmail,
    subject,
    html,
  }, { dedupeKey: `claim_email:${payerEmail}:${planId}` });
}

/**
 * Process a Gmail claim request from Apps Script.
 * Steps:
 *   1. Verify HMAC signature
 *   2. Check timestamp tolerance
 *   3. Deduplicate by payment ID
 *   4. Validate amount against server-authoritative prices
 *   5. Find intent by reference
 *   6. Create one-time claim token
 *   7. Email claim link to payer
 */
export async function requestGmailClaim(
  request: GmailClaimRequest,
): Promise<{ claimId: string; status: string }> {
  if (!gmailClaimEnabled()) {
    throw AppError.conflict('gmail_claim_disabled', 'Gmail claim rail is not enabled');
  }

  // Defensive shape guard (the route validates too; direct callers must too):
  // never crash on a malformed payload — fail closed with a clean bad request.
  if (!request || typeof request !== 'object' || !request.payload || typeof request.payload !== 'object') {
    throw AppError.badRequest('invalid_payload', 'payload is required and must be an object');
  }

  const { payload, timestamp, signature } = request;

  // 1. Verify HMAC signature
  if (!verifyGmailClaimSignature(payload, timestamp, signature)) {
    await recordAudit({
      action: 'payment.gmail_claim_signature_invalid',
      actorUserId: null,
      scope: 'SYSTEM',
      resourceType: 'payment_claim',
      detail: { reason: 'invalid_signature', paymentId: payload.paymentId ?? null },
    });
    throw AppError.unauthorized('invalid_signature', 'Invalid signature');
  }

  // 2. Check timestamp tolerance
  if (!isTimestampValid(timestamp)) {
    await recordAudit({
      action: 'payment.gmail_claim_timestamp_invalid',
      actorUserId: null,
      scope: 'SYSTEM',
      resourceType: 'payment_claim',
      detail: { reason: 'timestamp_out_of_range', timestamp },
    });
    throw AppError.badRequest('timestamp_invalid', 'Timestamp is outside the allowed window');
  }

  // 3. Deduplicate by payment ID
  if (await isDuplicatePayment(payload.paymentId)) {
    return { claimId: 'duplicate', status: 'already_processed' };
  }

  // 4. Validate plan
  const planId = (payload.plan ?? '').toLowerCase().trim();
  if (!planId || !(planId in PLAN_PRICES_INR)) {
    throw AppError.badRequest('invalid_plan', 'plan must be pro or team');
  }

  // 5. Validate amount against server-authoritative prices
  const expectedAmount = PLAN_PRICES_INR[planId]!;
  if (typeof payload.amount === 'number' && payload.amount !== expectedAmount) {
    await recordAudit({
      action: 'payment.gmail_claim_amount_mismatch',
      actorUserId: null,
      scope: 'SYSTEM',
      resourceType: 'payment_claim',
      detail: { plan: planId, expected: expectedAmount, claimed: payload.amount },
    });
    throw AppError.badRequest('amount_mismatch', `Payment amount ₹${payload.amount} does not match ${planId} plan price ₹${expectedAmount}`);
  }

  // 6. Find intent by reference
  const reference = (payload.reference ?? '').trim();
  if (!reference) {
    throw AppError.badRequest('reference_required', 'Reference is required');
  }

  const intent = await findIntentByReference(reference);
  if (!intent) {
    await recordAudit({
      action: 'payment.gmail_claim_no_intent',
      actorUserId: null,
      scope: 'SYSTEM',
      resourceType: 'payment_claim',
      detail: { reference, paymentId: payload.paymentId ?? null },
    });
    throw AppError.notFound('No payment intent found for this reference');
  }

  // The resolved intent's plan MUST match the claimed plan: the claim token —
  // and therefore the activated entitlement — always binds to the intent's
  // plan. A mismatched claim could otherwise target the wrong plan when the
  // amount check is skipped (no amount in payload). Fail closed.
  if (intent.plan_id !== planId) {
    await recordAudit({
      action: 'payment.gmail_claim_plan_mismatch',
      actorUserId: null,
      scope: 'SYSTEM',
      resourceType: 'payment_claim',
      detail: { reference, claimedPlan: planId, intentPlan: intent.plan_id, intentId: intent.id },
    });
    throw AppError.badRequest('plan_mismatch', `Reference ${reference} belongs to the ${intent.plan_id} plan, not ${planId}`);
  }

  // Intent must not already be ACTIVE
  if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
    return { claimId: 'already_active', status: intent.status };
  }

  // 7. Create one-time claim token
  const payerEmail = (payload.payerEmail ?? '').trim();
  if (!payerEmail || !payerEmail.includes('@')) {
    throw AppError.badRequest('invalid_payer_email', 'Valid payer email is required');
  }

  const { claimId, claimUrl } = await createClaimToken(
    intent.id,
    intent.owner_id,
    intent.plan_id,
    intent.amount_inr,
    payerEmail,
    payload.paymentId?.trim() ?? null,
    reference,
  );

  // 8. Email claim link to payer
  await sendClaimEmail(payerEmail, intent.plan_id, intent.amount_inr, claimUrl);

  // 9. Audit
  await recordAudit({
    action: 'payment.gmail_claim_created',
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: intent.owner_id,
    resourceType: 'payment_claim',
    resourceId: claimId,
    detail: {
      plan: intent.plan_id,
      payerEmail,
      paymentId: payload.paymentId ?? null,
      reference,
      intentId: intent.id,
    },
  });

  logger.info('gmail claim created', { claimId, plan: intent.plan_id, payerEmail });

  return { claimId, status: 'pending' };
}

/**
 * Activate a Gmail claim by one-time token.
 * Steps:
 *   1. Hash the raw token and find the claim by hash + id
 *   2. Check expiry
 *   3. Check single-use (status must be PENDING)
 *   4. Conditional UPDATE as race guard (exactly-once)
 *   5. Activate entitlement via the existing shared activation hook
 */
export async function activateGmailClaim(
  rawToken: string,
  claimId: string,
): Promise<{ activated: boolean; planId: string; ownerId: string }> {
  if (!gmailClaimEnabled()) {
    throw AppError.conflict('gmail_claim_disabled', 'Gmail claim rail is not enabled');
  }

  if (!rawToken || rawToken.trim().length === 0) {
    throw AppError.badRequest('invalid_token', 'Token is required');
  }
  if (!claimId || claimId.trim().length === 0) {
    throw AppError.badRequest('invalid_claim_id', 'Claim ID is required');
  }

  // 1. Hash the token and find the claim
  const tokenHash = sha256Hex(rawToken.trim());
  const claim = await withSystem(async (q) => {
    const rows = await q.query<GmailClaimRow>(
      `SELECT * FROM payment_claims WHERE token_hash = $1 AND id = $2`,
      [tokenHash, claimId.trim()],
    );
    return rows.rows[0] ?? null;
  });

  if (!claim) {
    throw AppError.notFound('Invalid or expired claim link');
  }

  // 2. Check expiry
  if (claim.expires_at.getTime() <= Date.now()) {
    await recordAudit({
      action: 'payment.gmail_claim_expired',
      actorUserId: claim.owner_id,
      scope: 'USER',
      tenantId: claim.owner_id,
      resourceType: 'payment_claim',
      resourceId: claim.id,
      detail: { plan: claim.plan_id },
    });
    throw AppError.badRequest('claim_expired', 'This claim link has expired');
  }

  // 3+4. Conditional UPDATE as race guard (exactly-once)
  const result = await withSystem(async (q) =>
    q.query(
      `UPDATE payment_claims
          SET status = 'ACTIVATED', activated_at = now()
        WHERE id = $1 AND status = 'PENDING' AND expires_at > now()
        RETURNING *`,
      [claim.id],
    ),
  );

  if ((result.rowCount ?? 0) === 0) {
    // Either already used or expired between the SELECT and UPDATE.
    const refreshed = await withSystem(async (q) =>
      (await q.query<GmailClaimRow>('SELECT status FROM payment_claims WHERE id = $1', [claim.id])).rows[0],
    );
    const reason = refreshed?.status === 'ACTIVATED' ? 'already_activated' : 'expired_or_used';
    throw AppError.badRequest('claim_already_used', `This claim link has already been used (${reason})`);
  }

  // 5. Activate entitlement via the existing shared activation hook
  await activateEntitlement(claim.owner_id, claim.plan_id, claim.intent_id);

  // 6. Audit
  await recordAudit({
    action: 'payment.gmail_claim_activated',
    actorUserId: claim.owner_id,
    scope: 'USER',
    tenantId: claim.owner_id,
    resourceType: 'payment_claim',
    resourceId: claim.id,
    detail: { plan: claim.plan_id, payerEmail: claim.payer_email, intentId: claim.intent_id },
  });

  // 7. Notify the user
  await notify(claim.owner_id, NotificationType.PAYMENT_STATUS, `${claim.plan_id.toUpperCase()} plan activated`, {
    body: `Your ${claim.plan_id.toUpperCase()} plan was activated via payment confirmation.`,
    resourceType: 'payment_claim',
    resourceId: claim.id,
    metadata: { plan: claim.plan_id, payerEmail: claim.payer_email },
    email: true,
  });

  logger.info('gmail claim activated', { claimId: claim.id, plan: claim.plan_id, ownerId: claim.owner_id });

  return { activated: true, planId: claim.plan_id, ownerId: claim.owner_id };
}
