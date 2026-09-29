/**
 * CodeConClave — STAGE 26H: fraud / spoof guard.
 *
 * Server-side checks over normalized evidence signals. Evidence is matched
 * against global uniqueness (provider payment id, sha256), intent state,
 * amount tolerance, sender identity and velocity. Blocking flags force the
 * intent into REVIEW regardless of confidence — a spoofed or replayed
 * screenshot never activates a plan.
 */
import { withTenant } from '../../shared/db.js';
import { env } from '../../config/env.js';
import type { PaymentIntentRow } from './intents.js';
import type { EvidenceSignals } from './evidence.js';

export interface FraudCheck {
  flags: string[];
  blocked: boolean;
}

const BLOCKING_FLAGS = new Set([
  'duplicate_payment_id',
  'screenshot_replay',
  'reference_reuse',
  'amount_mismatch',
  'plan_mismatch',
  'sender_anomaly',
]);

export async function checkFraud(
  userId: string,
  intent: PaymentIntentRow,
  signals: EvidenceSignals,
  sha256: string,
  evidenceCount: number,
): Promise<FraudCheck> {
  return withTenant(userId, async (q) => {
    const flags: string[] = [];
    const blocked = false;

    if (typeof signals.paymentId === 'string' && signals.paymentId.trim().length > 0) {
      const dup = await q
        .query<{ id: string; intent_id: string | null; owner_id: string }>(
          `SELECT id, intent_id, owner_id FROM payment_evidence
            WHERE provider_payment_id = $1 AND (intent_id IS DISTINCT FROM $2 OR owner_id <> $3)`,
          [signals.paymentId, intent.id, userId],
        )
        .then((r) => r.rows[0] ?? null);
      if (dup) flags.push('duplicate_payment_id');
    }

    if (typeof signals.reference === 'string' && signals.reference.trim().length > 0) {
      const reused = await q
        .query<{ id: string }>(
          `SELECT id FROM payment_intents WHERE reference = $1 AND id <> $2`,
          [signals.reference, intent.id],
        )
        .then((r) => r.rows[0] ?? null);
      if (reused) flags.push('reference_reuse');
    }

    if (typeof signals.amountInr === 'number') {
      const tolerance = env.PAYMENT_AMOUNT_TOLERANCE_INR;
      if (Math.abs(signals.amountInr - intent.amount_inr) > tolerance) {
        flags.push('amount_mismatch');
      }
    }

    // Plan authority: a referenced plan encoded in the evidence must match the
    // intent's plan. A TEAM-intent + PRO evidence, or PRO-intent + TEAM evidence,
    // is rejected (no silent downgrade/upgrade).
    if (typeof signals.reference === 'string' && signals.reference.trim().length > 0) {
      const refPlan = signals.reference.trim().match(/^CC(PRO|TEAM)-/)?.[1]?.toLowerCase();
      if (refPlan && refPlan !== intent.plan_id) {
        flags.push('plan_mismatch');
      }
    }

    if (typeof signals.payerEmail === 'string' && signals.payerEmail.trim().length > 0) {
      const user = await q
        .query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId])
        .then((r) => r.rows[0] ?? null);
      const payer = signals.payerEmail.trim().toLowerCase();
      const own = user?.email?.trim().toLowerCase() ?? null;
      if (own && payer !== own) flags.push('sender_anomaly');
    }

    if (evidenceCount > 0) {
      const replay = await q
        .query<{ id: string; intent_id: string | null }>(
          `SELECT id, intent_id FROM payment_evidence WHERE sha256 = $1 AND intent_id IS DISTINCT FROM $2`,
          [sha256, intent.id],
        )
        .then((r) => r.rows[0] ?? null);
      if (replay) flags.push('screenshot_replay');
    }

    const windowStart = new Date(Date.now() - env.PAYMENT_VELOCITY_WINDOW_MINUTES * 60 * 1000).toISOString();
    const recent = await q
      .query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_evidence WHERE owner_id = $1 AND created_at >= $2`,
        [userId, windowStart],
      )
      .then((r) => r.rows[0] ?? null);
    const n = recent?.n ?? 0;
    if (n >= env.PAYMENT_VELOCITY_MAX) flags.push('velocity');

    return { flags, blocked: flags.some((f) => BLOCKING_FLAGS.has(f)) };
  });
}

export function isBlockingFlag(flag: string): boolean {
  return BLOCKING_FLAGS.has(flag);
}