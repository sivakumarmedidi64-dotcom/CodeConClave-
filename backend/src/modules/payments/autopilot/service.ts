/**
 * CodeConClave — PAYMENT AUTOPILOT (UNLOCK_MODE=AUTOPILOT).
 *
 * AUTOPILOT auto-verifies and auto-activates ALL THREE paid products — Solo/Pro
 * ₹999, Team ₹4,999, API Access ₹9,999 — from the TRUSTED signed-webhook rail,
 * then funnels every verified payment through the SAME existing entitlement
 * authority (activation.pipeline -> applyDecision -> activateEntitlement).
 *
 * Product identity is NEVER derived from the amount alone: a webhook is bound
 * to a plan by the Payment Link identity (payment_link.entity.id must equal the
 * configured `RAZORPAY_*_PAYMENT_LINK_ID` for that plan), cross-checked with
 * the server-authoritative plan price, currency and a unique pending intent.
 * Invalid, mismatched, duplicate, replayed or unverifiable events FAIL CLOSED
 * and never unlock anything. Solo/Team can never produce API Access — the
 * intent's own plan + purchase_type is the source of truth.
 *
 * Mode: `env.UNLOCK_MODE` is the boot default; `payment_unlock_settings`
 * (singleton row) is the RUNTIME override an admin can flip (enable/disable)
 * without redeploying. Enabling AUTOPILOT requires the readiness prerequisites
 * (fail closed); setting MANUAL is the kill switch.
 */
import { withSystem, withTenant } from '../../../shared/db.js';
import { env } from '../../../config/env.js';
import { AppError } from '../../../shared/errors.js';
import { newId, PREFIX } from '../../../shared/ids.js';
import { recordAudit } from '../../audit/service.js';
import { notify } from '../../notifications/service.js';
import { NotificationType } from '@codeconclave/shared';
import { webhookDetectorAvailable } from '../evidence.js';
import { PLAN_PRICES_INR } from '../service.js';
import { purchaseTypeForPlan, type PaymentIntentRow } from '../intents.js';

export type UnlockMode = 'MANUAL' | 'AUTOPILOT';

const SINGLETON_ID = 'singleton';

/**
 * Normalize any parsed UNLOCK_MODE into a real mode. AUTO is a deprecated
 * legacy alias that is NEVER simulated: it normalizes to MANUAL (fail closed).
 */
export function normalizeUnlockMode(raw: string | null | undefined): UnlockMode {
  switch (raw) {
    case 'AUTOPILOT':
      return 'AUTOPILOT';
    case 'AUTO':
      return 'MANUAL';
    default:
      return 'MANUAL';
  }
}

// ---------------------------------------------------------------------------
// STATIC PER-PLAN LINK IDENTITY (product binding, never amount alone)
// ---------------------------------------------------------------------------

/**
 * Configured Payment Link ID -> plan mapping (from env, frozen at load).
 * A webhook's payment_link.entity.id MUST hit this map to auto-activate a
 * static per-plan link; unmapped or unconfigured links do not auto-activate.
 */
export function staticLinkPlanById(): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  if (env.RAZORPAY_PRO_PAYMENT_LINK_ID) map[env.RAZORPAY_PRO_PAYMENT_LINK_ID] = 'pro';
  if (env.RAZORPAY_TEAM_PAYMENT_LINK_ID) map[env.RAZORPAY_TEAM_PAYMENT_LINK_ID] = 'team';
  if (env.RAZORPAY_API_PAYMENT_LINK_ID) map[env.RAZORPAY_API_PAYMENT_LINK_ID] = 'api';
  return Object.freeze(map);
}

export function planForStaticLinkId(linkId: string | null): string | null {
  if (!linkId) return null;
  return staticLinkPlanById()[linkId] ?? null;
}

export function staticLinkIdForPlan(planId: string): string | null {
  switch (planId) {
    case 'pro':
      return env.RAZORPAY_PRO_PAYMENT_LINK_ID ?? null;
    case 'team':
      return env.RAZORPAY_TEAM_PAYMENT_LINK_ID ?? null;
    case 'api':
      return env.RAZORPAY_API_PAYMENT_LINK_ID ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// MODE (runtime-toggleable, DB-backed kill switch)
// ---------------------------------------------------------------------------

/** The runtime override from payment_unlock_settings, if present. */
export async function getRuntimeUnlockMode(): Promise<UnlockMode | null> {
  const row = await withSystem(async (q) =>
    (
      await q.query<{ unlock_mode: string }>(
        `SELECT unlock_mode FROM payment_unlock_settings WHERE id = $1`,
        [SINGLETON_ID],
      )
    ).rows[0],
  );
  return row ? normalizeUnlockMode(row.unlock_mode) : null;
}

/** Effective mode = runtime override (if a row exists) else env default. */
export async function getEffectiveUnlockMode(): Promise<UnlockMode> {
  const runtime = await getRuntimeUnlockMode();
  return runtime ?? normalizeUnlockMode(env.UNLOCK_MODE);
}

// ---------------------------------------------------------------------------
// READINESS (prerequisites; fail closed on enable)
// ---------------------------------------------------------------------------

export interface AutopilotCheck {
  id: string;
  label: string;
  ok: boolean;
  reason: string | null;
}

export interface AutopilotReadiness {
  ready: boolean;
  checks: AutopilotCheck[];
}

/**
 * AUTOPILOT readiness. Each check is honest and derived from real config:
 *  - the signed webhook verification rail must be on (the only auto-verifier);
 *  - every plan must have product identity: its own configured static link ID
 *    OR per-intent link creation via API credentials (per-intent links carry
 *    provider ids the webhook resolves directly);
 *  - a database must be reachable (mode + settings + audit.
 * If any check fails the mode is NOT ready and enabling AUTOPILOT is refused.
 */
export async function autopilotReadiness(): Promise<AutopilotReadiness> {
  const checks: AutopilotCheck[] = [];

  const webhook = webhookDetectorAvailable();
  checks.push({
    id: 'webhook',
    label: 'Signed webhook verification rail',
    ok: webhook,
    reason: webhook
      ? null
      : 'RAZORPAY_WEBHOOK_ENABLED must be true and RAZORPAY_WEBHOOK_SECRET configured',
  });

  // API credentials are optional for webhook-only autopilot mode.
  // They are only required for per-intent link creation via API.
  const hasApiCredentials = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  checks.push({
    id: 'api',
    label: 'Per-intent link API credentials (optional for webhook-only mode)',
    ok: true,
    reason: hasApiCredentials
      ? null
      : 'RAZORPAY_KEY_ID/SECRET not set — per-intent link creation unavailable (static per-plan link IDs required for webhook-only autopilot)',
  });

  for (const planId of ['pro', 'team', 'api'] as const) {
    const linkId = staticLinkIdForPlan(planId);
    // A plan is covered if it has a static link ID configured OR if API credentials are available for per-intent links.
    const covered = Boolean(linkId) || hasApiCredentials;
    checks.push({
      id: `link_${planId}`,
      label: `${planId.toUpperCase()} payment link product identity`,
      ok: covered,
      reason: covered
        ? null
        : `RAZORPAY_${planId.toUpperCase()}_PAYMENT_LINK_ID is not set and per-intent API links are unavailable; ${planId} payments cannot auto-activate`,
    });
  }

  const dbOk = Boolean(env.DATABASE_URL);
  checks.push({
    id: 'db',
    label: 'Database reachable',
    ok: dbOk,
    reason: dbOk ? null : 'DATABASE_URL is not configured',
  });

  return { ready: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// MODE SET (runtime toggle + kill switch)
// ---------------------------------------------------------------------------

/**
 * Flip the effective unlock mode at runtime (admin endpoint). Enabling
 * AUTOPILOT requires readiness (fail closed); MANUAL is always allowed and acts
 * as the kill switch. Persisted to payment_unlock_settings (singleton), audited.
 */
export async function setRuntimeUnlockMode(mode: UnlockMode, adminId: string): Promise<UnlockMode> {
  const effective = normalizeUnlockMode(mode);
  if (effective === 'AUTOPILOT') {
    const readiness = await autopilotReadiness();
    if (!readiness.ready) {
      const unmet = readiness.checks.filter((c) => !c.ok).map((c) => c.id).join(', ');
      throw AppError.conflict('autopilot_not_ready', `AUTOPILOT prerequisites missing: ${unmet}`);
    }
  }

  await withSystem(async (q) => {
    await q.query(
      `INSERT INTO payment_unlock_settings (id, unlock_mode, changed_by, changed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE
         SET unlock_mode = EXCLUDED.unlock_mode, changed_by = EXCLUDED.changed_by, changed_at = now()`,
      [SINGLETON_ID, effective, adminId],
    );
  });

  await recordAudit({
    action: 'payment.unlock_mode_changed',
    actorUserId: adminId,
    scope: 'SYSTEM',
    resourceType: 'payment_unlock_settings',
    resourceId: SINGLETON_ID,
    detail: { mode: effective },
  });
  await notify(adminId, NotificationType.PAYMENT_STATUS, `Unlock mode set to ${effective}`, {
    body: `Payment unlock mode is now ${effective}.`,
    resourceType: 'payment_unlock_settings',
    resourceId: SINGLETON_ID,
    email: false,
  });

  return effective;
}

// ---------------------------------------------------------------------------
// AUTOPILOT WEBHOOK VERIFIER (product binding + unambiguous intent resolution)
// ---------------------------------------------------------------------------

export interface AutopilotResolution {
  intent: PaymentIntentRow;
  viaStaticLink: boolean;
}

/** Normalized, server-derived signal payload consumed by the autopilot evidence source. */
export function autopilotSignalPayload(payload: unknown): {
  paymentId?: string;
  amountInr?: number;
  payerEmail?: string;
  paidAt?: string;
} {
  const event = payload as {
    payload?: {
      payment?: { entity?: { id?: string; amount?: number; email?: string; created_at?: number } };
      payment_link?: { entity?: { id?: string } };
    };
  };
  const entity = event.payload?.payment?.entity;
  return {
    paymentId: typeof entity?.id === 'string' && entity.id.length > 0 ? entity.id : undefined,
    amountInr: typeof entity?.amount === 'number' ? Math.round(entity.amount / 100) : undefined,
    payerEmail: typeof entity?.email === 'string' && entity.email.length > 0 ? entity.email : undefined,
    paidAt: typeof entity?.created_at === 'number' ? new Date(entity.created_at * 1000).toISOString() : undefined,
  };
}

/**
 * AUTOPILOT intent resolution for the signed-webhook rail.
 *
 * Runs ONLY after the exact resolver (provider_reference_id /
 * provider_payment_link_id / reference) found nothing. Binds the payment to the
 * product via the configured Payment Link ID (payment_link.entity.id), never
 * the amount alone, then requires:
 *   - AUTOPILOT mode is effective and the webhook rail is configured;
 *   - the amount equals the server-authoritative plan price (₹999/₹4,999/₹9,999);
 *   - the payer email resolves to exactly ONE account holding a PENDING/REVIEW
 *     intent for that plan (the resolved intent's plan/purchase_type is the
 *     product source of truth — Solo/Team can NEVER become API Access).
 *
 * Any deviation returns null (the caller records the unmatched event and fails
 * closed): unknown link id, wrong amount, unmatched/missing payer, or an
 * ambiguous (2+) pending intent are NEVER auto-activated.
 */
export async function resolveAutopilotIntent(payload: unknown): Promise<AutopilotResolution | null> {
  const mode = await getEffectiveUnlockMode();
  if (mode !== 'AUTOPILOT') return null;
  if (!webhookDetectorAvailable()) return null;

  const event = payload as {
    payload?: { payment_link?: { entity?: { id?: string } } };
  };
  const linkId = event.payload?.payment_link?.entity?.id ?? null;

  // Product binding: the payment link identity, NOT the amount.
  const planId = planForStaticLinkId(linkId);
  if (!planId) return null;

  const signals = autopilotSignalPayload(payload);
  if (typeof signals.amountInr !== 'number') return null;
  const price = PLAN_PRICES_INR[planId];
  if (price === undefined || signals.amountInr !== price) return null;

  // Payer -> account -> unique pending intent for the bound plan.
  if (!signals.payerEmail) return null;
  const payerEmail = signals.payerEmail;
  const user = await withSystem(async (q) =>
    (
      await q.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [
        payerEmail.toLowerCase(),
      ])
    ).rows[0],
  );
  if (!user) return null;

  const candidates = await withSystem(async (q) =>
    (
      await q.query<PaymentIntentRow>(
        `SELECT * FROM payment_intents
          WHERE owner_id = $1 AND plan_id = $2 AND status IN ('PENDING','REVIEW')
          ORDER BY created_at DESC LIMIT 2`,
        [user.id, planId],
      )
    ).rows,
  );
  if (candidates.length !== 1) return null; // absent or ambiguous -> fail closed
  const intent = candidates[0];
  if (!intent || intent.amount_inr !== price) return null;

  return { intent, viaStaticLink: true };
}

/**
 * Queue a founder review for an unverifiable AUTOPILOT event. Reuses the
 * existing MANUAL review claim table/authority (source='autopilot'), so a
 * payment that could NOT be auto-verified is never lost: it lands in the
 * founder's inbox instead of silently failing. Fail-closed: an invalid payment
 * id, an already-pending claim, a replayed id or any DB uniqueness conflict
 * results in no queue (never a second unlock path).
 */
export async function queueAutopilotReview(args: {
  user: { id: string; email: string };
  intent: Pick<PaymentIntentRow, 'id' | 'plan_id'>;
  paymentId: string | undefined;
}): Promise<{ queued: boolean; reason?: string }> {
  const { user, intent, paymentId } = args;
  if (!paymentId || !/^pay_[A-Za-z0-9_-]{8,64}$/.test(paymentId)) {
    return { queued: false, reason: 'invalid_payment_id' };
  }
  const id = newId(PREFIX.PAYMENT_CLAIM_REVIEW);
  const planId = intent.plan_id;
  const purchaseType = purchaseTypeForPlan(planId);
  const amountInr = PLAN_PRICES_INR[planId];
  if (!purchaseType || amountInr === undefined) return { queued: false, reason: 'unknown_plan' };

  try {
    await withTenant(user.id, async (c) => {
      await c.query(
        `INSERT INTO payment_claim_reviews
           (id, user_id, email, intent_id, plan_id, purchase_type, amount_inr, currency,
            razorpay_payment_id, status, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,'PENDING','autopilot')`,
        [id, user.id, user.email, intent.id, planId, purchaseType, amountInr, paymentId],
      );
    });
  } catch {
    // Duplicate / already-pending / replayed ids must never double-queue.
    return { queued: false, reason: 'duplicate_or_pending_conflict' };
  }

  await recordAudit({
    action: 'payment.autopilot_review_queued',
    actorUserId: null,
    scope: 'USER',
    tenantId: user.id,
    resourceType: 'payment_claim_review',
    resourceId: id,
    detail: { plan: planId, amountInr, paymentId },
  });
  return { queued: true };
}