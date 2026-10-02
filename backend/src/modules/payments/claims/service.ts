/**
 * CodeConClave — MANUAL payment claims (UNLOCK_MODE=MANUAL).
 *
 * Flow: the authenticated user pays a Razorpay payment link (Solo ₹999 / Team
 * ₹4,999 / API Access ₹9,999) and submits the REAL Razorpay Payment ID
 * (`pay_...`) against the AUTHENTICATED payment intent they created at
 * checkout. The founder approves/rejects the claim on the Admin > Payments
 * page. Approval NEVER trusts client input: plan, purchase identity and amount
 * are re-derived server-side, and the entitlement is granted through the
 * existing `activateEntitlement` authority inside the SAME transaction that
 * flips the claim + intent to ACTIVE — every statement commits or rolls back
 * together, and the conditional UPDATE is the exactly-once race guard.
 *
 * Always runs in MANUAL mode without Razorpay credentials (no webhook, no API,
 * no custom domain). This table is distinct from the legacy Gmail rail
 * (payment_claims, pcl_) which stores provider references — we store the real
 * payment id, mandate a real format, and gate on the authenticated intent.
 */
import { withTenant, withSystem } from '../../../shared/db.js';
import { AppError } from '../../../shared/errors.js';
import { newId, PREFIX } from '../../../shared/ids.js';
import { recordAudit } from '../../audit/service.js';
import { notify } from '../../notifications/service.js';
import { NotificationType } from '@codeconclave/shared';
import { PLAN_PRICES_INR, activateEntitlement } from '../service.js';
import { purchaseTypeForPlan, getIntent, type PaymentIntentRow } from '../intents.js';

export interface PaymentClaimRow {
  id: string;
  user_id: string;
  email: string;
  intent_id: string;
  plan_id: string;
  purchase_type: string;
  amount_inr: number;
  currency: string;
  razorpay_payment_id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  source: string;
  rejection_reason: string | null;
  review_locked_at: Date | null;
  notification_sent_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentClaimView {
  id: string;
  planId: string;
  purchaseType: string;
  amountInr: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  razorpayPaymentId: string;
  source: string;
  rejectionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  intentId: string;
  reference: string | null;
}

function toView(row: PaymentClaimRow, reference: string | null): PaymentClaimView {
  return {
    id: row.id,
    planId: row.plan_id,
    purchaseType: row.purchase_type,
    amountInr: row.amount_inr,
    currency: row.currency,
    status: row.status,
    razorpayPaymentId: row.razorpay_payment_id,
    source: row.source,
    rejectionReason: row.rejection_reason,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    intentId: row.intent_id,
    reference,
  };
}

/**
 * Normalize a Razorpay Payment ID to its canonical store form.
 * Must look like a real `pay_...` id; comma/whitespace junk, URLs and prose are
 * rejected here (the DB also enforces a non-empty UNIQUE). Lowercasing is NOT
 * applied — provider ids are case-sensitive — but surrounding whitespace is
 * trimmed and internal whitespace collapsed.
 */
export function normalizePaymentId(raw: unknown): string {
  const value = String(raw ?? '').trim().replace(/\s+/g, '').slice(0, 64);
  if (!/^pay_[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw AppError.badRequest(
      'invalid_payment_id',
      'Enter the real Razorpay Payment ID shown after payment (format: pay_...).',
    );
  }
  return value;
}

function isPendingUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === constraint;
}

export async function submitPaymentClaim(
  userId: string,
  intentId: string,
  rawPaymentId: unknown,
): Promise<PaymentClaimView> {
  const intent = await getIntent(userId, intentId);
  if (intent.status === 'ACTIVE') {
    throw AppError.conflict('plan_already_active', `${intent.plan_id.toUpperCase()} is already active for you.`);
  }
  if (intent.status !== 'PENDING' && intent.status !== 'REVIEW') {
    throw AppError.conflict(
      'intent_not_claimable',
      `This payment intent is ${intent.status.toLowerCase()} and cannot be claimed. Create a fresh checkout.`,
    );
  }

  const paymentId = normalizePaymentId(rawPaymentId);
  const user = await withTenant(userId, async (q) =>
    (await q.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0],
  );
  if (!user?.email) throw AppError.conflict('user_no_email', 'Your account has no email address; contact support.');

  const id = newId(PREFIX.PAYMENT_CLAIM_REVIEW);
  const amountInr = PLAN_PRICES_INR[intent.plan_id]!;

  try {
    await withTenant(userId, async (c) => {
      await c.query(
        `INSERT INTO payment_claim_reviews
           (id, user_id, email, intent_id, plan_id, purchase_type, amount_inr, currency,
            razorpay_payment_id, status, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,'PENDING','manual')`,
        [id, userId, user.email, intent.id, intent.plan_id, purchaseTypeForPlan(intent.plan_id), amountInr, paymentId],
      );
    });
  } catch (err) {
    if (isPendingUniqueViolation(err, 'payment_claim_reviews_razorpay_payment_id_key')) {
      throw AppError.conflict(
        'payment_id_already_claimed',
        'That Payment ID has already been claimed. Duplicate or replayed payment ids are rejected.',
      );
    }
    if (
      isPendingUniqueViolation(err, 'uq_payment_claim_reviews_user_pending') ||
      isPendingUniqueViolation(err, 'uq_payment_claim_reviews_intent_pending')
    ) {
      throw AppError.conflict(
        'claim_pending_exists',
        'You already have a pending claim on this checkout. Wait for review or create a fresh checkout.',
      );
    }
    throw err;
  }

  await recordAudit({
    action: 'payment.claim.submitted',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_claim_review',
    resourceId: id,
    detail: { plan: intent.plan_id, amountInr, reference: intent.reference, paymentId },
  });

  const row = await withTenant(userId, async (q) =>
    (await q.query<PaymentClaimRow>(`SELECT * FROM payment_claim_reviews WHERE id = $1`, [id])).rows[0],
  );
  if (!row) throw AppError.conflict('claim_write_failed', 'Could not record your claim. Try again.');
  return toView(row, intent.reference);
}

export async function listUserClaims(userId: string): Promise<PaymentClaimView[]> {
  return withTenant(userId, async (q) => {
    const rows = (
      await q.query<PaymentClaimRow>(
        `SELECT * FROM payment_claim_reviews WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      )
    ).rows;
    const out: PaymentClaimView[] = [];
    for (const row of rows) {
      const intent = (await q.query<{ reference: string }>(`SELECT reference FROM payment_intents WHERE id = $1`, [row.intent_id])).rows[0];
      out.push(toView(row, intent?.reference ?? null));
    }
    return out;
  });
}

export async function getUserClaim(userId: string, claimId: string): Promise<PaymentClaimView> {
  const row = await withTenant(userId, async (q) => {
    const r = (
      await q.query<PaymentClaimRow>(`SELECT * FROM payment_claim_reviews WHERE id = $1 AND user_id = $2`, [claimId, userId])
    ).rows[0];
    if (!r) throw AppError.notFound('Payment claim');
    const intent = (await q.query<{ reference: string }>(`SELECT reference FROM payment_intents WHERE id = $1`, [r.intent_id])).rows[0];
    return { row: r, reference: intent?.reference ?? null };
  });
  return toView(row.row, row.reference);
}

export interface ClaimInboxRow extends PaymentClaimRow {
  user_email: string;
}

export async function listClaimInbox(opts: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ claims: Array<PaymentClaimView & { email: string }>; total: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const status = opts.status && ['PENDING', 'APPROVED', 'REJECTED'].includes(opts.status) ? opts.status : null;

  const where = status ? `WHERE cr.status = $1` : ``;
  const params: unknown[] = [];
  if (status) params.push(status);
  params.push(limit, offset);

  return withSystem(async (q) => {
    const rows = (
      await q.query<ClaimInboxRow>(
        `SELECT cr.*,
                (SELECT u.email FROM users u WHERE u.id = cr.user_id) AS user_email
           FROM payment_claim_reviews cr
           ${where}
          ORDER BY (cr.status = 'PENDING') DESC, cr.created_at ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    const total =
      (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_claim_reviews ${where}`, status ? [status] : []))
        .rows[0]?.n ?? 0;

    const claims = rows.map((row) => ({
      ...toView(row, null),
      email: row.user_email ?? row.email,
    }));
    return { claims, total };
  });
}

/**
 * Approve a PENDING claim. Runs the entitlement grant + claim flip + intent
 * activation in ONE transaction; any failure rolls everything back. The
 * exactly-once gate is the conditional UPDATE on the claim row (a concurrent
 * admin who already decided loses and the transaction aborts).
 */
export async function approveClaim(adminId: string, claimId: string): Promise<PaymentClaimView> {
  let claim: PaymentClaimRow | null = null;
  await withTenant(null, async (c) => {
    const select = await c.query<PaymentClaimRow>(
      `SELECT * FROM payment_claim_reviews WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    claim = select.rows[0] ?? null;
    if (!claim) throw AppError.notFound('Payment claim');
    if (claim.status !== 'PENDING') {
      throw AppError.conflict('claim_not_pending', `Claim is already ${claim.status.toLowerCase()}.`);
    }

    // Server-authoritative re-validation (client input is never trusted).
    const intentRows = await c.query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1 AND owner_id = $2`,
      [claim.intent_id, claim.user_id],
    );
    const intent = intentRows.rows[0];
    if (!intent) {
      throw AppError.conflict('claim_intent_missing', 'The claimed checkout intent no longer exists for this user.');
    }
    if (intent.plan_id !== claim.plan_id || claim.purchase_type !== purchaseTypeForPlan(claim.plan_id)) {
      throw AppError.conflict('claim_plan_mismatch', 'Claim product does not match its checkout intent.');
    }
    if (claim.amount_inr !== PLAN_PRICES_INR[claim.plan_id]) {
      throw AppError.conflict('claim_amount_mismatch', 'Claim amount does not match the authorized plan price.');
    }

    // Delegate to the EXISTING entitlement authority inside this transaction.
    await activateEntitlement(claim.user_id, claim.plan_id, claim.id, c);

    if (intent.status === 'PENDING' || intent.status === 'REVIEW') {
      await c.query(
        `UPDATE payment_intents SET status = 'ACTIVE', activated_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('PENDING','REVIEW')`,
        [intent.id],
      );
    }

    const flip = await c.query(
      `UPDATE payment_claim_reviews
          SET status = 'APPROVED', decided_by = $2, decided_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [claim.id, adminId],
    );
    if (flip.rowCount !== 1) {
      throw AppError.conflict('claim_race', 'The claim was already decided by another admin.');
    }
  });

  // Re-read so the returned view reflects the decided state, not the pre-flip row.
  const decided =
    (await withSystem(async (q) =>
      (await q.query<PaymentClaimRow>('SELECT * FROM payment_claim_reviews WHERE id = $1', [claimId])).rows[0],
    )) ?? claim!;
  await recordAudit({
    action: 'payment.claim.approved',
    actorUserId: adminId,
    scope: 'SYSTEM',
    tenantId: decided.user_id,
    resourceType: 'payment_claim_review',
    resourceId: decided.id,
    detail: { plan: decided.plan_id, amountInr: decided.amount_inr, paymentId: decided.razorpay_payment_id },
  });
  await notify(decided.user_id, NotificationType.PAYMENT_STATUS, `${decided.plan_id.toUpperCase()} plan activated`, {
    body: `Your ₹${decided.amount_inr} ${decided.plan_id.toUpperCase()} payment (${decided.razorpay_payment_id}) was confirmed. Access is active.`,
    resourceType: 'payment_claim_review',
    resourceId: decided.id,
    metadata: { plan: decided.plan_id, paymentId: decided.razorpay_payment_id },
    email: true,
  });
  return toView(decided, null);
}

/** Reject a PENDING claim. Never touches the entitlement or the intent. */
export async function rejectClaim(
  adminId: string,
  claimId: string,
  rawReason: unknown,
): Promise<PaymentClaimView> {
  const reason = String(rawReason ?? '').trim().slice(0, 500);
  if (!reason) throw AppError.badRequest('rejection_reason_required', 'A rejection reason is required.');

  let claim: PaymentClaimRow | null = null;
  await withTenant(null, async (c) => {
    const select = await c.query<PaymentClaimRow>(
      `SELECT * FROM payment_claim_reviews WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    claim = select.rows[0] ?? null;
    if (!claim) throw AppError.notFound('Payment claim');
    if (claim.status !== 'PENDING') {
      throw AppError.conflict('claim_not_pending', `Claim is already ${claim.status.toLowerCase()}.`);
    }
    const flip = await c.query(
      `UPDATE payment_claim_reviews
          SET status = 'REJECTED', rejection_reason = $3, decided_by = $2, decided_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [claim.id, adminId, reason],
    );
    if (flip.rowCount !== 1) {
      throw AppError.conflict('claim_race', 'The claim was already decided by another admin.');
    }
  });

  // Re-read so the returned view reflects the decided state, not the pre-flip row.
  const decided =
    (await withSystem(async (q) =>
      (await q.query<PaymentClaimRow>('SELECT * FROM payment_claim_reviews WHERE id = $1', [claimId])).rows[0],
    )) ?? claim!;
  await recordAudit({
    action: 'payment.claim.rejected',
    actorUserId: adminId,
    scope: 'SYSTEM',
    tenantId: decided.user_id,
    resourceType: 'payment_claim_review',
    resourceId: decided.id,
    detail: { plan: decided.plan_id, reason, paymentId: decided.razorpay_payment_id },
  });
  await notify(decided.user_id, NotificationType.PAYMENT_STATUS, 'Payment claim not verified', {
    body: `Your claim for ${decided.plan_id.toUpperCase()} was not verified: ${reason}. If you did pay, submit the correct Payment ID from your bank/Razorpay confirmation.`,
    resourceType: 'payment_claim_review',
    resourceId: decided.id,
    metadata: { plan: decided.plan_id, reason },
    email: true,
  });
  return toView(decided, null);
}