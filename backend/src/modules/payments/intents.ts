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
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { NotificationType } from '@codeconclave/shared';
import { PLAN_PRICES_INR, paymentLinkForPlan, createRazorpayPaymentLinkForIntent } from './service.js';

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
  provider_payment_link_id: string | null;
  provider_reference_id: string | null;
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
  // Payment Link-Pool reservation columns (POLICY B). Null/absent when the
  // intent was created through the legacy rails (Rail A survives unchanged).
  pool_link_index: number | null;
  pool_reference_id: string | null;
  reservation_status: 'RESERVED' | 'FULFILLED' | 'EXPIRED' | 'RELEASED' | null;
  reservation_expires_at: Date | null;
  reservation_locked_at: Date | null;
  reservation_fulfilled_at: Date | null;
  pool_session_id: string | null;
  pool_client_ip: string | null;
  pool_heartbeat_last: Date | null;
  /**
   * Explicit purchase identity (server-authoritative). Products are NEVER
   * inferred from amount or link id — Solo(₹999), Team(₹4,999) and API
   * Access(₹9,999) are distinct products. The intent's own plan +
   * purchase_type decide the product: solo / team / api_access.
   */
  purchase_type: 'solo' | 'team' | 'api_access' | null;
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

/**
 * Explicit product -> purchase identity mapping. The plan key selects the
 * entitled capability; purchase_type is the authoritative product label used
 * by the callback binding. Products are distinct (Solo ₹999, Team ₹4,999,
 * API Access ₹9,999), so purchase identity always comes from this intent
 * field, never the amount or the link id.
 */
export const PURCHASE_TYPE_BY_PLAN: Record<string, 'solo' | 'team' | 'api_access'> = {
  pro: 'solo',
  team: 'team',
  api: 'api_access',
};

export function purchaseTypeForPlan(planId: string): 'solo' | 'team' | 'api_access' | null {
  return PURCHASE_TYPE_BY_PLAN[planId] ?? null;
}

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
  if (!(planId in PLAN_PRICES_INR)) throw AppError.badRequest('invalid_plan', 'plan must be pro, team or api');

  const active = await withTenant(userId, async (q) =>
    (await q.query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE owner_id = $1 AND plan_id = $2 AND status IN ('PENDING','REVIEW','ACTIVE','GRACE') ORDER BY created_at DESC LIMIT 1`,
      [userId, planId],
    )).rows[0] ?? null,
  );
  if (active) return active;

  const id = newId(PREFIX.PAYMENT_INTENT);
  const amount = PLAN_PRICES_INR[planId]!;
  let reference: string;
  let row: PaymentIntentRow | null = null;
  // Collision-safe: the column is UNIQUE; retry a handful of times.
  for (let attempt = 0; ; attempt += 1) {
    reference = makeReference(planId);
    // Server-authoritative unique Payment Link per intent (automatic-activation
    // path). When the Razorpay API is unavailable this returns null and we fall
    // back to the static per-plan link (compat/manual checkout; such intents
    // cannot auto-activate from a webhook and go to REVIEW instead).
    let paymentLink = paymentLinkForPlan(planId);
    let providerPaymentLinkId: string | null = null;
    let providerReferenceId: string | null = null;
    try {
      const created = await createRazorpayPaymentLinkForIntent(userId, planId, reference);
      if (created) {
        paymentLink = created.short_url;
        providerPaymentLinkId = created.id;
        providerReferenceId = created.reference_id ?? reference;
      }
    } catch {
      // Fall back to the static per-plan link on any API/link failure.
    }
    try {
      row = await withTenant(userId, async (q) => {
        await q.query(
          `INSERT INTO payment_intents (id, owner_id, plan_id, purchase_type, amount_inr, currency, reference, payment_link, mode, provider_payment_link_id, provider_reference_id, status, expires_at, tenant_id)
           VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,'PAYMENT_LINK',$8,$9,'PENDING', now() + make_interval(hours => $10), $11)`,
          [id, userId, planId, purchaseTypeForPlan(planId), amount, reference, paymentLink, providerPaymentLinkId, providerReferenceId, intentTtlHours(), userId],
        );
        return (await q.query<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [id])).rows[0] ?? null;
      });
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

  return row!;
}

export async function getIntent(userId: string, intentId: string): Promise<PaymentIntentRow> {
  const row = await withTenant(userId, async (q) =>
    (await q.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE id = $1 AND owner_id = $2',
      [intentId, userId],
    )).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('Payment intent');
  return row;
}

export async function listIntents(userId: string): Promise<PaymentIntentRow[]> {
  return withTenant(userId, async (q) =>
    (await q.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE owner_id = $1 ORDER BY created_at DESC',
      [userId],
    )).rows,
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
  const out = await withSystem(async (q) =>
    q.query(
      `UPDATE payment_intents
          SET status = 'EXPIRED', updated_at = now()
        WHERE status IN ('PENDING','REVIEW') AND expires_at <= now()
        RETURNING id, owner_id, plan_id`,
    ),
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

  const grace = await withSystem(async (q) =>
    q.query(
      `UPDATE payment_intents
          SET status = 'GRACE', grace_until = now() + make_interval(hours => $1), updated_at = now()
        WHERE status = 'ACTIVE' AND expires_at <= now() AND (grace_until IS NULL OR grace_until <= now())
        RETURNING id, owner_id, plan_id`,
      [env.PAYMENT_GRACE_HOURS],
    ),
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

  const revoked = await withSystem(async (q) =>
    q.query(
      `UPDATE payment_intents
          SET status = 'EXPIRED', updated_at = now()
        WHERE status = 'GRACE' AND grace_until <= now()
        RETURNING id, owner_id, plan_id`,
    ),
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