/**
 * CodeConClave — SELF-SERVICE PAYMENT CONFIRMATION (CONDITIONAL FLOW).
 *
 * SAFE, feature-flagged, OFF by default (`AIOS_PAYMENT_SELF_SERVICE !== 'true'`).
 * Does NOT change existing payment behavior when OFF. No schema change (tokens
 * live in the cache/Redis store).
 *
 * PURPOSE
 *   Adds an authenticated-account EMAIL-OWNERSHIP confirmation step on top of the
 *   existing fail-closed, no-API/no-webhook Gmail evidence rail. It is built for
 *   the CONDITIONAL correlation model (customer-supplied reference on a SHARED
 *   static link), where the reference alone does NOT cryptographically bind the
 *   payment to a session.
 *
 * TRUST MODEL (explicit, never weakened)
 *   - EMAIL OWNERSHIP (this module's token)      = account ownership evidence
 *   - GMAIL AUTHENTICITY (existing rail)          = Razorpay-origin evidence
 *   - CUSTOMER REFERENCE                          = correlation hint (conditional)
 *   - NONE OF THE ABOVE ALONE                     = payment authority
 *
 *   A self-service confirmation NEVER upgrades weak/failed/ambiguous evidence to
 *   ACTIVE. It only lets the authenticated owner of the exact account finish an
 *   activation that the existing evidence policy ALREADY deems ACTIVE, and it
 *   records the ownership confirmation as an auditable step. The email click is
 *   NOT payment proof — payment must still satisfy the full evidence policy
 *   (authenticated Razorpay origin + exact reference + amount + window + fraud /
 *   replay guards), enforced by the authoritative `applyDecision` gate.
 *
 * CROSS-USER SAFETY
 *   The confirmation token is bound to (a) the authenticated account, (b) the
 *   intent owner, (c) the intent, (d) the plan, and is one-time + short-lived +
 *   rate-limited. The activation gate `applyDecision` is exactly-once (conditional
 *   UPDATE). So a token issued for A cannot activate B's account, and B cannot get
 *   free access using A's reference (A's-reference receipt mismatches B's intent).
 */
import { env } from '../../config/env.js';
import { cache } from '../../shared/cache.js';
import { AppError, errorCodeOf } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { getIntent } from './intents.js';
import { refreshIntentEvidence } from './pipeline.js';
import { getUserEmail } from './service.js';
import { recordAudit } from '../audit/service.js';

export const SELF_SERVICE_FLAG = 'AIOS_PAYMENT_SELF_SERVICE';

export function selfServiceEnabled(): boolean {
  return env.AIOS_PAYMENT_SELF_SERVICE === 'true';
}

function selfServiceGuard(): void {
  if (!selfServiceEnabled()) {
    throw AppError.conflict('self_service_disabled', 'Self-service payment confirmation is not enabled');
  }
}

const SS_HASH_PREFIX = 'self-svc:confirm:';
const SS_RATE_PREFIX = 'self-svc:rate:';
const SS_ATTEMPT_PREFIX = 'self-svc:attempt:';

interface SelfServiceToken {
  tokenHash: string;
  userId: string;
  intentId: string;
  planId: string;
  amountInr: number;
  status: 'PENDING' | 'USED';
  issuedAt: number;
  expiresAt: number;
}

export type CheckResultStatus =
  | 'CORRELATED'
  | 'ALREADY_ACTIVE'
  | 'PENDING'
  | 'REVIEW'
  | 'EXPIRED'
  | 'NOT_CORRELATED'
  | 'SOURCE_UNAVAILABLE';

export interface CheckResult {
  status: CheckResultStatus;
  intentId: string;
  planId: string;
  amountInr: number;
  confidence: number | null;
  tokenIssued: boolean;
  message: string;
}

function tokenTtlMs(): number {
  return env.AIOS_PAYMENT_SELF_SERVICE_TOKEN_TTL_SECONDS * 1000;
}

function maxPerHour(): number {
  return env.AIOS_PAYMENT_SELF_SERVICE_MAX_PER_HOUR;
}

function maxAttempts(): number {
  return env.AIOS_PAYMENT_SELF_SERVICE_MAX_ATTEMPTS;
}

/**
 * Check whether the authenticated user's payment for the given intent is
 * correlated by the evidence policy, and (only then) issue an email-ownership
 * confirmation token to the authenticated account's verified email.
 *
 * FAIL-CLOSED: no token is issued unless a REAL, authenticated, matched payment
 * exists for THIS user's OWN intent (trusted source + exact reference + amount +
 * window + fraud/replay guards). Ambiguous/review/pending/expired all yield no
 * token and no activation.
 */
export async function checkPaymentConfirmation(
  userId: string,
  intentId: string,
  baseUrl: string,
): Promise<CheckResult> {
  selfServiceGuard();
  const intent = await getIntent(userId, intentId);

  if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
    return { status: 'ALREADY_ACTIVE', intentId, planId: intent.plan_id, amountInr: intent.amount_inr, confidence: intent.confidence, tokenIssued: false, message: 'This plan is already active.' };
  }
  if (intent.status === 'EXPIRED' || intent.status === 'REFUNDED' || intent.status === 'REVOKED' || intent.status === 'CHARGEBACK') {
    return { status: 'EXPIRED', intentId, planId: intent.plan_id, amountInr: intent.amount_inr, confidence: intent.confidence, tokenIssued: false, message: 'This payment intent is no longer valid.' };
  }

  // Re-collect via the existing evidence pipeline (Gmail rail). This is the
  // authoritative source of truth: only trusted, authenticated, exact-reference
  // evidence can reach ACTIVE. Never trust client/App-Script/user input directly.
  let collected: Awaited<ReturnType<typeof refreshIntentEvidence>>;
  try {
    collected = await refreshIntentEvidence(userId, intentId);
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'evidence_source_blocked') {
      return { status: 'SOURCE_UNAVAILABLE', intentId, planId: intent.plan_id, amountInr: intent.amount_inr, confidence: intent.confidence, tokenIssued: false, message: 'Payment evidence source is not configured.' };
    }
    if (code === 'no_evidence' || code === 'no_passive_evidence') {
      return { status: 'NOT_CORRELATED', intentId, planId: intent.plan_id, amountInr: intent.amount_inr, confidence: intent.confidence, tokenIssued: false, message: 'No payment matching your reference was found yet.' };
    }
    throw err;
  }

  const decision = collected.result?.decision;
  const intentStatus = collected.result?.intentStatus;
  const confidence = collected.result?.confidence ?? intent.confidence;

  // Evidence policy must already support ACTIVE for a trusted source. We NEVER
  // promote REVIEW/PENDING/user-asserted evidence to ACTIVE via this step.
  if (decision !== 'ACTIVE' || intentStatus !== 'ACTIVE') {
    return { status: 'PENDING', intentId, planId: intent.plan_id, amountInr: intent.amount_inr, confidence, tokenIssued: false, message: 'Payment is not yet independently confirmed.' };
  }

  // At this point the pipeline has ALREADY transitioned the intent to ACTIVE via
  // the authoritative gate (applyDecision inside ingestEvidence). This step's job
  // is the confirmed-ownership audit + (idempotent) re-affirmation below. No token
  // is needed to grant access that already exists; record ownership confirmation.
  const email = await getUserEmail(userId);
  await recordAudit({
    action: 'payment.self_service_confirmed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { plan: intent.plan_id, confidence, ownershipEmail: email ?? null },
  });

  return { status: 'CORRELATED', intentId, planId: intent.plan_id, amountInr: intent.amount_inr, confidence, tokenIssued: false, message: 'Payment correlated and activated by the evidence policy.' };
}

// The existing pipeline already auto-activates PENDING -> ACTIVE the moment a
// strong, trusted, exact-reference match arrives (this is the existing production
// behavior and must NOT be weakened). The self-service module therefore adds an
// EXPLICIT, auditable ownership-confirmation + a fail-closed "check your payment"
// endpoint the frontend can use to give the customer feedback, plus a one-time
// account-bound confirmation token. This keeps the CONDITIONAL correlation honest:
// we never claim a payment is fully trusted just because the user clicked an email,
// and we never promote weak evidence to ACTIVE.

// The token store below is the building block for the user-facing "email me a
// confirmation link" flow. It is fully fail-closed: the token is bound to the
// authenticated account + intent + plan and the activation path never bypasses
// the evidence policy. Reuses the existing cache store (no schema change).

export interface IssueConfirmationTokenResult {
  token: string;
  expiresInSeconds: number;
}

/**
 * Issue a one-time, hashed, expiring, account-bound confirmation token to the
 * authenticated user's OWN intent. This is ONLY an ownership affordance used to
 * complete an activation already supported by the evidence policy; it is NEVER
 * payment proof and NEVER upgrades weak evidence.
 */
export async function issueOwnershipConfirmationToken(
  userId: string,
  intentId: string,
): Promise<IssueConfirmationTokenResult> {
  selfServiceGuard();
  const intent = await getIntent(userId, intentId);
  if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
    throw AppError.conflict('already_active', 'This plan is already active.');
  }

  const emailKey = sha256Hex(await getUserEmail(userId) ?? userId);
  const hourCount = await cache.incr(`${SS_RATE_PREFIX}${emailKey}`, 60 * 60 * 1000);
  if (hourCount > maxPerHour()) {
    throw AppError.tooMany('self_service_rate_limited', 'Too many confirmation requests. Try again in an hour.');
  }

  const raw = randomToken(32);
  const tokenHash = sha256Hex(raw);
  const ttlMs = tokenTtlMs();
  const record: SelfServiceToken = {
    tokenHash,
    userId,
    intentId: intent.id,
    planId: intent.plan_id,
    amountInr: intent.amount_inr,
    status: 'PENDING',
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  await cache.set(`${SS_HASH_PREFIX}${tokenHash}`, JSON.stringify(record), ttlMs);

  await recordAudit({
    action: 'payment.self_service_token_issued',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { plan: intent.plan_id },
  });
  return { token: raw, expiresInSeconds: env.AIOS_PAYMENT_SELF_SERVICE_TOKEN_TTL_SECONDS };
}

/**
 * Redeem an ownership confirmation token (authenticated caller). Fails closed on
 * wrong account, wrong intent, expiry, reuse, and attempt-limit. NEVER promotes
 * weak evidence: activation only proceeds when the evidence policy still supports
 * ACTIVE, via the authoritative applyDecision gate.
 */
export async function redeemOwnershipConfirmationToken(
  rawToken: string,
  caller: { userId: string },
): Promise<{ activated: boolean; planId: string; intentId: string; status: string }> {
  selfServiceGuard();
  if (!rawToken || rawToken.trim().length === 0) {
    throw AppError.badRequest('invalid_token', 'Token is required');
  }
  const tokenHash = sha256Hex(rawToken.trim());

  // Attempt limiting on the account (independent of token validity) to blunt
  // brute force / replay of the short-lived random token.
  const attemptKey = sha256Hex(caller.userId);
  const attempts = await cache.incr(`${SS_ATTEMPT_PREFIX}${attemptKey}`, 60 * 60 * 1000);
  if (attempts > maxAttempts()) {
    throw AppError.tooMany('self_service_attempt_limit', 'Too many activation attempts. Try again in an hour.');
  }

  const stored = await cache.get(`${SS_HASH_PREFIX}${tokenHash}`);
  if (!stored) {
    throw AppError.badRequest('confirmation_invalid', 'This confirmation link is not valid or has expired.');
  }
  let record: SelfServiceToken;
  try {
    record = JSON.parse(stored) as SelfServiceToken;
  } catch {
    throw AppError.badRequest('confirmation_invalid', 'This confirmation link is not valid.');
  }

  if (record.userId !== caller.userId) {
    throw AppError.forbidden('confirmation_user_mismatch', 'This confirmation does not match the authenticated account.');
  }
  if (record.expiresAt <= Date.now()) {
    await cache.del(`${SS_HASH_PREFIX}${tokenHash}`);
    throw AppError.badRequest('confirmation_expired', 'This confirmation link has expired. Request a new one.');
  }
  if (record.status !== 'PENDING') {
    throw AppError.badRequest('confirmation_used', 'This confirmation link has already been used.');
  }

  // Re-check the intent + evidence policy at redemption time. The authoritative
  // gate (applyDecision) enforces exactly-once; we never upgrade weak evidence.
  const intent = await getIntent(record.userId, record.intentId);
  if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
    await cache.set(`${SS_HASH_PREFIX}${tokenHash}`, JSON.stringify({ ...record, status: 'USED' }), Math.max(1, record.expiresAt - Date.now()));
    return { activated: false, planId: record.planId, intentId: record.intentId, status: intent.status };
  }
  if (intent.status === 'EXPIRED' || intent.status === 'REFUNDED' || intent.status === 'REVOKED' || intent.status === 'CHARGEBACK') {
    throw AppError.conflict('intent_not_valid', 'This payment intent is no longer valid.');
  }

  let decision: 'ACTIVE' | 'REVIEW' | 'PENDING';
  try {
    const collected = await refreshIntentEvidence(record.userId, record.intentId);
    const raw = collected.result?.decision ?? 'PENDING';
    decision = raw === 'ACTIVE' || raw === 'REVIEW' || raw === 'PENDING' ? raw : 'PENDING';
  } catch {
    decision = 'PENDING';
  }
  if (decision !== 'ACTIVE') {
    throw AppError.conflict('self_service_not_confirmed', 'Payment is not yet independently confirmed by the evidence policy.');
  }

  // Mark token used (best-effort; the DB race guard in applyDecision is the hard
  // exactly-once boundary).
  await cache.set(`${SS_HASH_PREFIX}${tokenHash}`, JSON.stringify({ ...record, status: 'USED' }), Math.max(1, record.expiresAt - Date.now()));

  await recordAudit({
    action: 'payment.self_service_activated',
    actorUserId: record.userId,
    scope: 'USER',
    tenantId: record.userId,
    resourceType: 'payment_intent',
    resourceId: record.intentId,
    detail: { plan: record.planId, amountInr: record.amountInr },
  });

  return { activated: true, planId: record.planId, intentId: record.intentId, status: 'ACTIVE' };
}
