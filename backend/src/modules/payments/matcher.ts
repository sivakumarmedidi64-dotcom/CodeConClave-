/**
 * CodeConClave — STAGE 26H: confidence matcher.
 *
 * Scores evidence signals against the payment intent and produces a
 * decision: ACTIVE (>= active threshold), REVIEW (>= grace threshold), or
 * PENDING. Every decision records the thresholds that produced it (audited),
 * and the matcher itself never mutates state — activation.ts applies it.
 */
import type { PaymentIntentRow, IntentDecision } from './intents.js';
import { intentThresholds } from './intents.js';
import type { EvidenceSignals } from './evidence.js';

export interface MatcherSignals {
  reference: boolean;
  amount: boolean;
  payer: boolean;
  time: boolean;
  paymentId: boolean;
}

export interface MatcherResult {
  confidence: number;
  signals: MatcherSignals;
  decision: IntentDecision;
  thresholds: { active: number; grace: number };
}

/**
 * Weighted scoring of normalized evidence signals:
 *  - reference matches the intent's unique reference    +0.45 (anchor signal)
 *  - amount matches the intent amount (INR)             +0.25
 *  - payer email matches the user's account email       +0.10
 *  - paid_at falls inside the intent's validity window  +0.10
 *  - a provider payment id is present                   +0.10
 * Max confidence 1.00. Thresholds come from env (audited per decision).
 */
export function scoreEvidence(
  intent: PaymentIntentRow,
  signals: EvidenceSignals,
  userEmail: string | null,
  now: Date = new Date(),
): MatcherResult {
  const thresholds = intentThresholds();

  const reference = typeof signals.reference === 'string' && signals.reference.trim().length > 0
    ? signals.reference.trim() === intent.reference
    : false;
  const amount = typeof signals.amountInr === 'number' && signals.amountInr === intent.amount_inr;
  const payer =
    typeof signals.payerEmail === 'string' &&
    signals.payerEmail.trim().length > 0 &&
    userEmail !== null &&
    signals.payerEmail.trim().toLowerCase() === userEmail.toLowerCase();
  const paidAt = signals.paidAt instanceof Date ? signals.paidAt : typeof signals.paidAt === 'string' ? new Date(signals.paidAt) : null;
  const time = paidAt !== null && !Number.isNaN(paidAt.getTime()) && paidAt.getTime() <= now.getTime() && paidAt.getTime() >= intent.created_at.getTime() - 5 * 60 * 1000;
  const paymentId = typeof signals.paymentId === 'string' && signals.paymentId.trim().length > 0;

  let confidence = 0;
  if (reference) confidence += 0.45;
  if (amount) confidence += 0.25;
  if (payer) confidence += 0.1;
  if (time) confidence += 0.1;
  if (paymentId) confidence += 0.1;
  confidence = Math.min(1, confidence);
  const rounded = round3(confidence);

  let decision: IntentDecision = 'PENDING';
  if (rounded >= thresholds.active) decision = 'ACTIVE';
  else if (rounded >= thresholds.grace) decision = 'REVIEW';

  return {
    confidence: rounded,
    signals: { reference, amount, payer, time, paymentId },
    decision,
    thresholds,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}