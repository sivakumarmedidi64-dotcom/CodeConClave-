/**
 * CodeConClave — STAGE 26H: payment intents.
 *
 * An intent is the server-authoritative record of "this user intends to pay
 * for this plan". It carries a globally unique `reference` that the user is
 * instructed to include in their Razorpay payment (Gmail evidence rail), a
 * payment link, and a status that ONLY the matcher/activation pipeline can
 * move (PENDING -> REVIEW -> ACTIVE -> GRACE -> EXPIRED/REFUNDED/REVOKED/
 * CHARGEBACK). Entitlements activate exclusively through activation.ts.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { NotificationType } from '@codeconclave/shared';
import { PLAN_PRICES_INR } from './service.js';

export type IntentStatus =
  | 'PENDING'
  | 'REVIEW'
  | 'ACTIVE'
  | 'GRACE'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'REVOKED'
  | 'CHARGEBACK';

export type IntentDecision = 'ACTIVE' | 'REVIEW' | 'PENDING';

export interface PaymentIntentRow {
  id: string;
  owner_id: string;
  plan_id: string;
  amount_inr: number;
  currency: string;
  reference: string;
  payment_link: string;
  mode: string;
  status: IntentStatus;
  confidence: number;
  decision: IntentDecision | null;
  thresholds_used: Record<string, number> | null;
  fraud_flags: string[] | null;
  expires_at: Date;
  grace_until: Date | null;
  activated_at: Date | null;
  evidence_summary: Record<string, unknown> | null;
  tenant_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export const INTENT_STATUSES: IntentStatus[] = [
  'PENDING',
  'REVIEW',
  'ACTIVE',
  'GRACE',
  'EXPIRED',
  'REFUNDED',
  'REVOKED',
  'CHARGEBACK',
];

export function intentThresholds(): { active: number; grace: number } {
  return {
    active: env.PAYMENT_CONFIDENCE_ACTIVE,
    grace: env.PAYMENT_CONFIDENCE_GRACE,
  };
}

export function intentTtlHours(): number {
  return env.PAYMENT_INTENT_TTL_HOURS;
}

function makeReference(planId: string): string {
  // Unique reference the user must copy into their Razorpay payment.
  // Allowed chars keep it safe inside payment description/Upi text fields.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 6; i += 1) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `CC${planId.toUpperCase()}-${token}`;
}

export async function createPaymentIntent(userId: string, planId: string): Promise<PaymentIntentRow> {
  if (!(planId in PLAN_PRICES_INR)) throw AppError.badRequest('invalid_plan', 'plan must be pro or team');

  const active = await queryOne<PaymentIntentRow>(
    `SELECT * FROM payment_intents WHERE owner_id = $1 AND plan_id = $2 AND status IN ('PENDING','REVIEW','ACTIVE','GRACE') ORDER BY created_at DESC LIMIT 1`,
    [userId, planId],
  );
  if (active) return active;

  const id = newId(PREFIX.PAYMENT_INTENT);
  const amount = PLAN_PRICES_INR[planId]!;
  let reference: string;
  // Collision-safe: the column is UNIQUE; retry a handful of times.
  for (let attempt = 0; ; attempt += 1) {
    reference = makeReference(planId);
    try {
      await pool.query(
        `INSERT INTO payment_intents (id, owner_id, plan_id, amount_inr, currency, reference, payment_link, mode, status, expires_at, tenant_id)
         VALUES ($1,$2,$3,$4,'INR',$5,$6,'PAYMENT_LINK','PENDING', now() + make_interval(hours => $7), $8)`,
        [id, userId, planId, amount, reference, env.RAZORPAY_PRO_PAYMENT_LINK, intentTtlHours(), userId],
      );
      break;
    } catch (err) {
      if (attempt >= 4 || !String((err as { message?: string }).message ?? '').includes('uq_payment_intents_reference')) {
        throw err;
      }
    }
  }

  await recordAudit({
    action: 'payment.intent_created',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: id,
    detail: { plan: planId, amountInr: amount, reference, expiresInHours: intentTtlHours() },
  });

  return (await queryOne<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [id]))!;
}

export async function getIntent(userId: string, intentId: string): Promise<PaymentIntentRow> {
  const row = await queryOne<PaymentIntentRow>(
    'SELECT * FROM payment_intents WHERE id = $1 AND owner_id = $2',
    [intentId, userId],
  );
  if (!row) throw AppError.notFound('Payment intent');
  return row;
}

export async function listIntents(userId: string): Promise<PaymentIntentRow[]> {
  return queryMany<PaymentIntentRow>(
    'SELECT * FROM payment_intents WHERE owner_id = $1 ORDER BY created_at DESC',
    [userId],
  );
}

/** Payment instructions for the user (reference, account email, link, status). */
export async function intentInstructions(userId: string, intentId: string): Promise<{
  reference: string;
  accountEmail: string | null;
  amountInr: number;
  planId: string;
  paymentLink: string;
  status: IntentStatus;
  expiresAt: Date;
}> {
  const intent = await getIntent(userId, intentId);
  return {
    reference: intent.reference,
    accountEmail: env.PAYMENT_ACCOUNT_EMAIL ?? null,
    amountInr: intent.amount_inr,
    planId: intent.plan_id,
    paymentLink: intent.payment_link,
    status: intent.status,
    expiresAt: intent.expires_at,
  };
}

/**
 * Watchdog sweep (called from workers): expiry + grace lifecycle.
 *  PENDING/REVIEW past expires_at           -> EXPIRED (no entitlement touched)
 *  ACTIVE past expires_at                   -> GRACE (entitlement keeps working)
 *  GRACE past grace_until                   -> EXPIRED + entitlement revoked
 * Returns the number of intents transitioned.
 */
export async function sweepIntentExpiry(): Promise<number> {
  const out = await pool.query(
    `UPDATE payment_intents
        SET status = 'EXPIRED', updated_at = now()
      WHERE status IN ('PENDING','REVIEW') AND expires_at <= now()
      RETURNING id, owner_id, plan_id`,
  );
  const expired = out.rows as Array<{ id: string; owner_id: string; plan_id: string }>;
  for (const row of expired) {
    await recordAudit({
      action: 'payment.expired',
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: row.owner_id,
      resourceType: 'payment_intent',
      resourceId: row.id,
      detail: { reason: 'intent_expired' },
    });
  }

  const grace = await pool.query(
    `UPDATE payment_intents
        SET status = 'GRACE', grace_until = now() + make_interval(hours => $1), updated_at = now()
      WHERE status = 'ACTIVE' AND expires_at <= now() AND (grace_until IS NULL OR grace_until <= now())
      RETURNING id, owner_id, plan_id`,
    [env.PAYMENT_GRACE_HOURS],
  );
  const enteringGrace = grace.rows as Array<{ id: string; owner_id: string; plan_id: string }>;
  for (const row of enteringGrace) {
    await recordAudit({
      action: 'payment.state_change',
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: row.owner_id,
      resourceType: 'payment_intent',
      resourceId: row.id,
      detail: { from: 'ACTIVE', to: 'GRACE', graceHours: env.PAYMENT_GRACE_HOURS },
    });
    await notify(row.owner_id, NotificationType.PAYMENT_STATUS, 'Plan grace period started', {
      body: `Your ${row.plan_id.toUpperCase()} plan entered a ${env.PAYMENT_GRACE_HOURS}-hour grace period. Renew before it ends to keep full access.`,
      resourceType: 'payment_intent',
      resourceId: row.id,
      email: true,
    });
  }

  const revoked = await pool.query(
    `UPDATE payment_intents
        SET status = 'EXPIRED', updated_at = now()
      WHERE status = 'GRACE' AND grace_until <= now()
      RETURNING id, owner_id, plan_id`,
  );
  const afterGrace = revoked.rows as Array<{ id: string; owner_id: string; plan_id: string }>;
  for (const row of afterGrace) {
    const { revokeExpiredEntitlement } = await import('./activation.js');
    await revokeExpiredEntitlement(row.owner_id, row.plan_id, `intent expired after grace (${row.id})`);
    await recordAudit({
      action: 'payment.expired',
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: row.owner_id,
      resourceType: 'payment_intent',
      resourceId: row.id,
      detail: { reason: 'grace_exhausted' },
    });
  }

  return expired.length + enteringGrace.length + afterGrace.length;
}