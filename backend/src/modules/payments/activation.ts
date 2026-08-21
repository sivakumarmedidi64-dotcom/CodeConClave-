/**
 * CodeConClave — STAGE 26H: confidence-based activation.
 *
 * The ONLY code path that can turn an intent ACTIVE (and activate an
 * entitlement). Applies the matcher's decision with an exactly-once guard:
 * the status transition is conditional (PENDING/REVIEW -> ACTIVE), so a
 * concurrent double-apply loses the race and never double-activates.
 *
 * Screenshots/OCR are evidence inputs — confidence is computed server-side
 * from normalized signals and the thresholds used are stored on the intent
 * (auditable). Fraud-blocked evidence forces REVIEW, never ACTIVE.
 */
import { pool, queryOne } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { NotificationType } from '@codeconclave/shared';
import type { PaymentIntentRow, IntentDecision } from './intents.js';
import type { FraudCheck } from './fraud.js';
import type { MatcherResult } from './matcher.js';
import { activateEntitlement, revokeEntitlement } from './service.js';

export interface AppliedDecision {
  intent: PaymentIntentRow;
  transitioned: boolean;
  reason: string;
}

/**
 * Apply a matcher decision to an intent.
 * - fraud blocked      -> REVIEW (fraud_flags recorded), never ACTIVE
 * - decision ACTIVE    -> ACTIVE + entitlement activation (exactly-once)
 * - decision REVIEW    -> REVIEW (needs human/provider confirmation)
 * - decision PENDING   -> stays PENDING (confidence recorded)
 */
export async function applyDecision(
  userId: string,
  intent: PaymentIntentRow,
  match: MatcherResult,
  fraud: FraudCheck,
): Promise<AppliedDecision> {
  if (intent.status === 'ACTIVE') {
    return { intent, transitioned: false, reason: 'already_active' };
  }
  if (intent.status !== 'PENDING' && intent.status !== 'REVIEW') {
    throw AppError.conflict('intent_not_matchable', `Intent is ${intent.status.toLowerCase()}; only PENDING/REVIEW intents accept evidence`);
  }

  const fraudFlags = [...(intent.fraud_flags ?? []), ...fraud.flags];
  const thresholds = match.thresholds;

  await pool.query(
    `UPDATE payment_intents
        SET confidence = $2, decision = $3, thresholds_used = $4::jsonb, fraud_flags = $5::jsonb, updated_at = now()
      WHERE id = $1`,
    [intent.id, match.confidence, match.decision, JSON.stringify(thresholds), JSON.stringify(fraudFlags)],
  );

  if (fraud.blocked || match.decision === 'REVIEW') {
    const blocked = fraud.blocked;
    const next: 'REVIEW' = 'REVIEW';
    const updated = await pool.query(
      `UPDATE payment_intents
          SET status = $2, updated_at = now()
        WHERE id = $1 AND status IN ('PENDING','REVIEW')
        RETURNING *`,
      [intent.id, next],
    );
    await recordAudit({
      action: blocked ? 'payment.fraud_flagged' : 'payment.review_required',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'payment_intent',
      resourceId: intent.id,
      detail: {
        confidence: match.confidence,
        decision: match.decision,
        flags: fraudFlags,
        thresholds,
      },
    });
    await notify(userId, NotificationType.PAYMENT_REVIEW_REQUIRED, blocked ? 'Payment flagged for review' : 'Payment needs review', {
      body: blocked
        ? 'Your payment evidence was flagged by the fraud guard and needs manual review. No plan change was made.'
        : 'Your payment matches but needs review before activation.',
      resourceType: 'payment_intent',
      resourceId: intent.id,
      metadata: { confidence: match.confidence, flags: fraudFlags },
      email: blocked,
    });
    const row = await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]);
    return { intent: row!, transitioned: (updated.rowCount ?? 0) > 0, reason: blocked ? 'fraud_blocked' : 'review_required' };
  }

  if (match.decision === 'PENDING') {
    await recordAudit({
      action: 'payment.matched',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'payment_intent',
      resourceId: intent.id,
      detail: { confidence: match.confidence, decision: 'PENDING', thresholds },
    });
    const row = await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]);
    return { intent: row!, transitioned: false, reason: 'insufficient_confidence' };
  }

  // ACTIVE — exactly-once transition; the conditional UPDATE is the race guard.
  const updated = await pool.query(
    `UPDATE payment_intents
        SET status = 'ACTIVE', activated_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('PENDING','REVIEW')
      RETURNING *`,
    [intent.id],
  );
  if (updated.rowCount === 0) {
    // Lost the race: another activation already won. Never double-activate.
    const row = await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]);
    return { intent: row!, transitioned: false, reason: 'race_lost_already_active' };
  }

  await activateEntitlement(userId, intent.plan_id, intent.id);
  await recordAudit({
    action: 'payment.activated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { confidence: match.confidence, decision: 'ACTIVE', thresholds, flags: fraudFlags },
  });
  await notify(userId, NotificationType.PAYMENT_STATUS, `${intent.plan_id.toUpperCase()} plan activated`, {
    body: `Welcome to ${intent.plan_id.toUpperCase()}! Your payment was confirmed with ${match.confidence} confidence.`,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    metadata: { plan: intent.plan_id, confidence: match.confidence, reference: intent.reference },
    email: true,
  });
  const row = await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]);
  return { intent: row!, transitioned: true, reason: 'activated' };
}

/** Expire a plan after its grace period (watchdog path). */
export async function revokeExpiredEntitlement(userId: string, planId: string, reason: string): Promise<void> {
  const entitlement = await queryOne<{ id: string; state: string }>(
    'SELECT id, state FROM entitlements WHERE user_id = $1 AND plan_id = $2',
    [userId, planId],
  );
  if (!entitlement || entitlement.state !== 'PRO_VERIFIED') return;
  await revokeEntitlement(userId, planId, reason);
  await recordAudit({
    action: 'payment.expired',
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: userId,
    resourceType: 'entitlement',
    resourceId: entitlement.id,
    detail: { plan: planId, reason },
  });
}

/** Refund an ACTIVE (or GRACE) intent: entitlement -> PRO_REFUNDED, plan -> free. */
export async function refundIntent(userId: string, intentId: string, reason: string): Promise<PaymentIntentRow> {
  const intent = await getMatchableForAction(userId, intentId, ['ACTIVE', 'GRACE']);
  await pool.query(
    `UPDATE payment_intents SET status = 'REFUNDED', updated_at = now() WHERE id = $1 AND status IN ('ACTIVE','GRACE')`,
    [intent.id],
  );
  await pool.query(
    `INSERT INTO entitlements (id, user_id, plan_id, state, reason)
     VALUES ($1,$2,$3,'PRO_REFUNDED',$4)
     ON CONFLICT (user_id, plan_id) DO UPDATE SET state = 'PRO_REFUNDED', reason = EXCLUDED.reason`,
    [newId(PREFIX.ENTITLEMENT), userId, intent.plan_id, `refunded: ${reason}`],
  );
  await pool.query(`UPDATE users SET plan_id = 'free' WHERE id = $1 AND plan_id = $2`, [userId, intent.plan_id]);
  await recordAudit({
    action: 'payment.refunded',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { plan: intent.plan_id, reason },
  });
  await notify(userId, NotificationType.PAYMENT_STATUS, 'Payment refunded', {
    body: `Your ${intent.plan_id.toUpperCase()} payment was refunded. Your plan was set back to free.`,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    metadata: { plan: intent.plan_id, reason },
    email: true,
  });
  return (await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]))!;
}

/** Revoke an ACTIVE (or GRACE) intent: entitlement -> REVOKED, plan -> free. */
export async function revokeIntent(userId: string, intentId: string, reason: string): Promise<PaymentIntentRow> {
  const intent = await getMatchableForAction(userId, intentId, ['ACTIVE', 'GRACE']);
  await pool.query(
    `UPDATE payment_intents SET status = 'REVOKED', updated_at = now() WHERE id = $1 AND status IN ('ACTIVE','GRACE')`,
    [intent.id],
  );
  await revokeEntitlement(userId, intent.plan_id, `revoked: ${reason}`);
  await recordAudit({
    action: 'payment.revoked',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { plan: intent.plan_id, reason },
  });
  await notify(userId, NotificationType.PAYMENT_STATUS, 'Plan access revoked', {
    body: `Your ${intent.plan_id.toUpperCase()} access was revoked.`,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    metadata: { plan: intent.plan_id, reason },
    email: true,
  });
  return (await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]))!;
}

/**
 * Chargeback: only valid when independent evidence (a provider payment id)
 * exists for this intent — evidence, never a client claim.
 */
export async function chargebackIntent(userId: string, intentId: string, reason: string): Promise<PaymentIntentRow> {
  const intent = await getMatchableForAction(userId, intentId, ['ACTIVE', 'GRACE', 'REVIEW', 'PENDING']);
  const evidence = await queryOne<{ id: string }>(
    `SELECT id FROM payment_evidence WHERE intent_id = $1 AND provider_payment_id IS NOT NULL`,
    [intent.id],
  );
  if (!evidence) {
    throw AppError.conflict('chargeback_no_evidence', 'Chargeback requires provider evidence with a payment id on this intent');
  }
  await pool.query(
    `UPDATE payment_intents SET status = 'CHARGEBACK', updated_at = now() WHERE id = $1 AND status IN ('ACTIVE','GRACE','REVIEW','PENDING')`,
    [intent.id],
  );
  if (intent.status === 'ACTIVE' || intent.status === 'GRACE') {
    await revokeEntitlement(userId, intent.plan_id, `chargeback: ${reason}`);
  }
  await recordAudit({
    action: 'payment.chargeback',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { plan: intent.plan_id, reason, evidenceId: evidence.id },
  });
  await notify(userId, NotificationType.PAYMENT_STATUS, 'Chargeback recorded', {
    body: `A chargeback was recorded for your ${intent.plan_id.toUpperCase()} payment.`,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    metadata: { plan: intent.plan_id, reason },
    email: true,
  });
  return (await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [intent.id]))!;
}

async function getMatchableForAction(
  userId: string,
  intentId: string,
  allowed: string[],
): Promise<PaymentIntentRow> {
  const intent = await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1 AND owner_id = $2', [
    intentId,
    userId,
  ]);
  if (!intent) throw AppError.notFound('Payment intent');
  if (!allowed.includes(intent.status)) {
    throw AppError.conflict('intent_not_actionable', `Intent is ${intent.status.toLowerCase()}; action not allowed`);
  }
  return intent;
}