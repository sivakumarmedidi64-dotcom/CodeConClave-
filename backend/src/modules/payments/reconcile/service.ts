/**
 * CodeConClave — RAZORPAY API RECONCILIATION FALLBACK (webhook recovery rail).
 *
 * LEGITIMATE SECOND VERIFICATION RAIL. Never bypasses Razorpay and never
 * fabricates payments: the fallback queries Razorpay's trusted backend API
 * (server-only credentials) and, only after a payment is PROVEN — status
 * captured, server-authoritative amount/currency, Payment Link product
 * binding, payer binding to the pending intent, not yet consumed, not
 * refunded/reversed — funnels the verification through the EXISTING autopilot
 * intervention window:
 *
 *   requestAutoApproval -> (2s window, founder-STOP possible) -> sweepAutoApprovals
 *   -> pipeline.ingestEvidence -> applyDecision -> activateEntitlement
 *
 * There is NO second activation system and NO direct PRO_VERIFIED write: the
 * API rail shares the exact authority and uniqueness guards as the webhook
 * rail. payment_id UNIQUE (auto_approvals / evidence), the guarded PENDING->ACTIVE
 * transition and entitlement uniqueness make webhook-first / API-first /
 * simultaneous orderings all resolve to exactly ONE activation.
 *
 * Fail closed: authorized-only, failed, refunded/reversed, wrong amount, wrong
 * currency, wrong/unknown payment-link context, non-owner payers and ambiguous
 * (2+) unconsumed matching payments NEVER activate anything. A bounded backoff
 * schedule (30s / 2m / 5m / 15m / 30m) then REVIEW + founder queue after the
 * final attempt. The fixed Payment Link webhook path is unaffected when the API
 * credentials are absent: the rail is optional infrastructure.
 *
 * Security: credentials are never logged/returned; audits carry redacted
 * payment ids + intent/plan/amount/result/reason only.
 */
import { withSystem } from '../../../shared/db.js';
import { recordAudit } from '../../audit/service.js';
import { PLAN_PRICES_INR } from '../service.js';
import { staticLinkIdForPlan, getEffectiveUnlockMode, queueAutopilotReview } from '../autopilot/service.js';
import { requestAutoApproval, type ApprovalSignalPayload } from '../autoapproval/service.js';
import { razorpayApiConfigured, fetchLinkPayments, probeRazorpayCredentials, RazorpayApiError, type RazorpayPayment } from '../razorpay/api.js';

/** Bounded backoff between reconciliation attempts (ms). */
export const RECONCILE_SCHEDULE_MS = [30_000, 120_000, 300_000, 900_000, 1_800_000] as const;

const RECONCILE_AUTH_ERROR_COOLDOWN_MS = 30 * 60_000;
const RECONCILE_GRACE_MS = 30_000;
const RECONCILE_SWEEP_LIMIT = 10;

export type ReconcileOutcomeStatus =
  | 'unconfigured'
  | 'already_processed'
  | 'not_pending'
  | 'no_link_id'
  | 'no_captured_payment'
  | 'wrong_binding'
  | 'ambiguous'
  | 'scheduled'
  | 'already_pending'
  | 'already_approved'
  | 'already_stopped'
  | 'auth_error'
  | 'error';

export interface ReconcileOutcome {
  status: ReconcileOutcomeStatus;
  intentId: string;
  /** Real provider payment id for DB/internal use (logs stay redacted). */
  paymentId?: string;
  reason?: string;
  attempt?: number;
}

interface ReconcileIntentRow {
  id: string;
  owner_id: string;
  plan_id: string;
  amount_inr: number;
  status: string;
  created_at: string;
}

/** Redact a provider payment id for logs/audits: pay_ab…cd. Keeps last 4 chars. */
export function redactPaymentId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.length <= 8) return 'pay_####';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function safeAuditDetail(intent: { id: string; plan_id: string; amount_inr?: number }, extra: Record<string, unknown>): Record<string, unknown> {
  return { intent: intent.id, plan: intent.plan_id, amountInr: intent.amount_inr, ...extra };
}

function isProviderTerminalStatus(status: string): boolean {
  return status === 'ACTIVE' || status === 'GRACE';
}

function isProviderRetiredStatus(status: string): boolean {
  return status === 'EXPIRED' || status === 'CANCELLED' || status === 'FAILED' || status === 'REFUNDED' || status === 'REVOKED';
}

async function loadReconcileRow(intentId: string): Promise<{ attempt: number } | null> {
  return withSystem<{ attempt: number } | null>((db) =>
    db.query<{ attempt: number }>(`SELECT attempt FROM payment_reconciliation WHERE intent_id = $1`, [intentId]).then((r) => r.rows[0] ?? null),
  );
}

async function recordReconcileRow(args: {
  intentId: string;
  attempt: number;
  state: 'SCHEDULED' | 'VERIFIED' | 'EXHAUSTED' | 'AMBIGUOUS';
  nextAttemptAt: Date | null;
  verifiedPaymentId?: string | null;
  lastError?: string | null;
}): Promise<void> {
  await withSystem((db) =>
    db.query(
      `INSERT INTO payment_reconciliation
         (intent_id, attempt, state, verified_payment_id, last_attempt_at, next_attempt_at, last_error, updated_at)
       VALUES ($1,$2,$3,$4, now(), $5, $6, now())
       ON CONFLICT (intent_id) DO UPDATE SET
         attempt = EXCLUDED.attempt,
         state = EXCLUDED.state,
         verified_payment_id = COALESCE(EXCLUDED.verified_payment_id, payment_reconciliation.verified_payment_id),
         last_attempt_at = now(),
         next_attempt_at = EXCLUDED.next_attempt_at,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [args.intentId, args.attempt, args.state, args.verifiedPaymentId ?? null, args.nextAttemptAt, args.lastError ?? null],
    ),
  );
}

/** Mark the intent REVIEW + queue a founder review (fail-closed, best-effort). */
async function forceReview(
  intent: { id: string; owner_id: string; plan_id: string },
  auditAction: string,
  reason: string,
  paymentId: string | undefined,
  actorUserId: string | null,
): Promise<void> {
  await withSystem((db) =>
    db.query(
      `UPDATE payment_intents SET status = 'REVIEW', updated_at = now()
        WHERE id = $1 AND status IN ('PENDING','REVIEW')`,
      [intent.id],
    ),
  );
  const owner = await withSystem<{ email: string } | null>((db) =>
    db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [intent.owner_id]).then((r) => r.rows[0] ?? null),
  );
  if (owner?.email && paymentId && /^pay_[A-Za-z0-9_-]{8,64}$/.test(paymentId)) {
    await queueAutopilotReview({
      user: { id: intent.owner_id, email: owner.email },
      intent: { id: intent.id, plan_id: intent.plan_id },
      paymentId,
    });
  }
  await recordAudit({
    action: auditAction,
    actorUserId,
    scope: 'SYSTEM',
    tenantId: intent.owner_id,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: safeAuditDetail(intent, { reason, paymentId: redactPaymentId(paymentId) }),
  });
}

/** Non-terminal outcome: advance the bounded backoff or exhaust to REVIEW. */
async function retryOrExhaust(
  intent: ReconcileIntentRow,
  attempt: number,
  status: 'no_captured_payment' | 'wrong_binding' | 'error',
  reason: string,
  actorUserId: string | null,
): Promise<ReconcileOutcome> {
  const next = RECONCILE_SCHEDULE_MS[attempt - 1];
  if (next === undefined) {
    await recordReconcileRow({
      intentId: intent.id,
      attempt,
      state: 'EXHAUSTED',
      nextAttemptAt: null,
      lastError: reason,
    });
    await forceReview(intent, 'payment.reconcile_exhausted', 'reconciliation attempts exhausted', undefined, actorUserId);
    return { status: 'error', intentId: intent.id, reason: `reconciliation exhausted: ${reason}`, attempt };
  }
  await recordReconcileRow({
    intentId: intent.id,
    attempt,
    state: 'SCHEDULED',
    nextAttemptAt: new Date(Date.now() + next),
    lastError: reason,
  });
  return { status, intentId: intent.id, reason, attempt };
}

/**
 * Core verifier shared by the bounded job AND the founder "Verify payment with
 * Razorpay" action. Idempotent + fail-closed; see module doc for the exact
 * gate list. Never activates from `authorized` alone.
 */
export async function reconcileIntent(intentId: string, opts: { actorUserId?: string } = {}): Promise<ReconcileOutcome> {
  if (!razorpayApiConfigured()) {
    return { status: 'unconfigured', intentId };
  }

  const intent = await withSystem<ReconcileIntentRow | null>((db) =>
    db
      .query<ReconcileIntentRow>(
        `SELECT id, owner_id, plan_id, amount_inr, status, created_at FROM payment_intents WHERE id = $1`,
        [intentId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!intent) return { status: 'error', intentId, reason: 'intent_not_found' };

  if (isProviderTerminalStatus(intent.status)) {
    // Webhook (or a prior reconcile) already activated this intent: the fallback
    // recognizes the real payment as ALREADY PROCESSED — never a second grant.
    return { status: 'already_processed', intentId };
  }
  if (isProviderRetiredStatus(intent.status)) {
    return { status: 'not_pending', intentId };
  }

  const actorUserId = opts.actorUserId ?? null;
  const price = PLAN_PRICES_INR[intent.plan_id];
  const linkId = staticLinkIdForPlan(intent.plan_id);
  if (!price || !linkId) {
    await recordReconcileRow({ intentId: intent.id, attempt: await loadReconcileRow(intent.id).then((r) => r?.attempt ?? 1), state: 'EXHAUSTED', nextAttemptAt: null });
    return { status: 'no_link_id', intentId, reason: 'plan has no configured static payment-link id' };
  }

  const existing = await loadReconcileRow(intent.id);
  const attempt = (existing?.attempt ?? 0) + 1;

  let candidates: RazorpayPayment[];
  try {
    candidates = await fetchLinkPayments(linkId);
  } catch (err) {
    const apiErr = err instanceof RazorpayApiError ? err : null;
    if (apiErr?.code === 'auth_error') {
      await recordReconcileRow({
        intentId: intent.id,
        attempt,
        state: 'SCHEDULED',
        nextAttemptAt: new Date(Date.now() + RECONCILE_AUTH_ERROR_COOLDOWN_MS),
        lastError: 'razorpay_auth_error',
      });
      await recordAudit({
        action: 'payment.reconcile_auth_error',
        actorUserId,
        scope: 'SYSTEM',
        tenantId: intent.owner_id,
        resourceType: 'payment_intent',
        resourceId: intent.id,
        detail: safeAuditDetail(intent, { reason: 'Razorpay API credentials rejected' }),
      });
      return { status: 'auth_error', intentId: intent.id, reason: 'Razorpay API authentication failed', attempt };
    }
    return await retryOrExhaust(intent, attempt, 'error', apiErr ? `razorpay_api_${apiErr.code}` : 'reconcile_error', actorUserId);
  }

  // Capturable-only: captured + exact paise amount + INR + not reversed.
  const matches = candidates.filter((p) => {
    if (p.status !== 'captured' || !p.captured) return false;
    if (p.amount !== price * 100) return false;
    if (p.currency !== 'INR') return false;
    return p.refund_status !== 'full';
  });

  // Duplicate protection: ids already scheduled/ingested by any rail are
  // processed (webhook-first / API-first / simultaneous converge to ONE).
  if (matches.length > 0) {
    const ids = matches.map((m) => m.id);
    const [approvals, evidence] = await withSystem<[Array<{ payment_id: string }>, Array<{ provider_payment_id: string }>]>((db) =>
      Promise.all([
        db.query<{ payment_id: string }>(`SELECT payment_id FROM payment_auto_approvals WHERE payment_id = ANY($1)`, [ids]).then((r) => r.rows),
        db
          .query<{ provider_payment_id: string }>(
            `SELECT provider_payment_id FROM payment_evidence WHERE provider_payment_id = ANY($1) AND provider_payment_id IS NOT NULL`,
            [ids],
          )
          .then((r) => r.rows),
      ]),
    );
    const consumed = new Set<string>();
    for (const r of approvals) consumed.add(r.payment_id);
    for (const r of evidence) consumed.add(r.provider_payment_id);
    const unconsumed = matches.filter((m) => !consumed.has(m.id));
    if (unconsumed.length === 0) {
      // Everything matching is already on the webhook/approval rails.
      return { status: 'already_approved', intentId, reason: 'already_consumed' };
    }
    return await bindAndActivate(intent, attempt, unconsumed, actorUserId);
  }

  // Nothing captured/matching right now -> bounded retry toward REVIEW.
  return await retryOrExhaust(intent, attempt, 'no_captured_payment', 'no captured matching payment on Razorpay', actorUserId);
}

async function bindAndActivate(
  intent: ReconcileIntentRow,
  attempt: number,
  candidates: RazorpayPayment[],
  actorUserId: string | null,
): Promise<ReconcileOutcome> {
  // Payer binding: the candidate must resolve to THIS intent's owner account —
  // the browser/query/customer-provided payment id is never authoritative.
  const bound: RazorpayPayment[] = [];
  for (const m of candidates) {
    if (!m.email) continue;
    const user = await withSystem<{ id: string } | null>((db) =>
      db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [m.email]).then((r) => r.rows[0] ?? null),
    );
    if (user?.id === intent.owner_id) bound.push(m);
  }
  if (bound.length === 0) {
    return await retryOrExhaust(intent, attempt, 'wrong_binding', 'no captured payment resolves to the intent owner', actorUserId);
  }
  if (bound.length > 1) {
    await recordReconcileRow({ intentId: intent.id, attempt, state: 'AMBIGUOUS', nextAttemptAt: null });
    await forceReview(intent, 'payment.reconcile_ambiguous', `multiple unconsumed captured payments (${bound.length})`, bound[bound.length - 1]!.id, actorUserId);
    return { status: 'ambiguous', intentId: intent.id, reason: `multiple unconsumed captured payments (${bound.length})`, attempt };
  }

  const payment = bound[0];
  if (!payment) {
    return await retryOrExhaust(intent, attempt, 'wrong_binding', 'no captured payment resolves to the intent owner', actorUserId);
  }
  const signal: ApprovalSignalPayload = {
    paymentId: payment.id,
    amountInr: priceFor(intent.plan_id, intent.amount_inr),
    payerEmail: payment.email ?? undefined,
    paidAt: payment.created_at > 0 ? new Date(payment.created_at * 1000).toISOString() : undefined,
  };
  const approval = await requestAutoApproval({
    intent: { id: intent.id, owner_id: intent.owner_id, plan_id: intent.plan_id, amount_inr: intent.amount_inr },
    signal,
  });

  switch (approval.planned) {
    case 'PENDING':
      await recordReconcileRow({ intentId: intent.id, attempt, state: 'VERIFIED', nextAttemptAt: null, verifiedPaymentId: payment.id });
      await recordAudit({
        action: 'payment.reconcile_verified',
        actorUserId,
        scope: 'SYSTEM',
        tenantId: intent.owner_id,
        resourceType: 'payment_intent',
        resourceId: intent.id,
        detail: safeAuditDetail(intent, { paymentId: redactPaymentId(payment.id), scheduled: true }),
      });
      return { status: 'scheduled', intentId: intent.id, paymentId: payment.id, attempt };
    case 'ALREADY_PENDING':
      return { status: 'already_pending', intentId: intent.id, paymentId: payment.id, attempt };
    case 'ALREADY_APPROVED':
      return { status: 'already_approved', intentId: intent.id, paymentId: payment.id, attempt };
    case 'ALREADY_STOPPED':
      return { status: 'already_stopped', intentId: intent.id, paymentId: payment.id, attempt };
    case 'REVIEW_QUEUED':
      return { status: 'error', intentId: intent.id, paymentId: payment.id, reason: approval.reason, attempt };
  }
}

function priceFor(planId: string, amountInr: number): number {
  return PLAN_PRICES_INR[planId] ?? amountInr;
}

/** Founder/admin "Verify payment with Razorpay" action. Reuses the SAME authority. */
export async function verifyPaymentWithRazorpay(intentId: string, actorUserId: string): Promise<ReconcileOutcome> {
  const outcome = await reconcileIntent(intentId, { actorUserId });
  const owner = await withSystem<{ owner_id: string } | null>((db) =>
    db.query<{ owner_id: string }>(`SELECT owner_id FROM payment_intents WHERE id = $1`, [intentId]).then((r) => r.rows[0] ?? null),
  );
  await recordAudit({
    action: 'payment.reconcile_founder_verify',
    actorUserId,
    scope: 'SYSTEM',
    tenantId: owner?.owner_id ?? null,
    resourceType: 'payment_intent',
    resourceId: intentId,
    detail: { intent: intentId, result: outcome.status, reason: outcome.reason ?? null, paymentId: redactPaymentId(outcome.paymentId) },
  });
  return outcome;
}

/** Safe, read-only reconcile snapshot for the control center (no secrets). */
export async function listReconcileRows(opts: { limit?: number } = {}): Promise<
  Array<{
    intentId: string;
    intentStatus: string | null;
    plan: string | null;
    attempt: number;
    state: string;
    verifiedPaymentId: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    lastError: string | null;
  }>
> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = await withSystem<
    Array<{
      intent_id: string;
      intent_status: string | null;
      plan_id: string | null;
      attempt: number;
      state: string;
      verified_payment_id: string | null;
      last_attempt_at: Date | null;
      next_attempt_at: Date | null;
      last_error: string | null;
    }>
  >((db) =>
    db
      .query<{
        intent_id: string;
        intent_status: string | null;
        plan_id: string | null;
        attempt: number;
        state: string;
        verified_payment_id: string | null;
        last_attempt_at: Date | null;
        next_attempt_at: Date | null;
        last_error: string | null;
      }>(
        `SELECT r.intent_id, i.status AS intent_status, i.plan_id, r.attempt, r.state,
                r.verified_payment_id, r.last_attempt_at, r.next_attempt_at, r.last_error
           FROM payment_reconciliation r
           LEFT JOIN payment_intents i ON i.id = r.intent_id
          ORDER BY r.updated_at DESC LIMIT $1`,
        [limit],
      )
      .then((r) => r.rows),
  );
  return rows.map((r) => ({
    intentId: r.intent_id,
    intentStatus: r.intent_status,
    plan: r.plan_id,
    attempt: r.attempt,
    state: r.state,
    verifiedPaymentId: redactPaymentId(r.verified_payment_id),
    lastAttemptAt: r.last_attempt_at ? r.last_attempt_at.toISOString() : null,
    nextAttemptAt: r.next_attempt_at ? r.next_attempt_at.toISOString() : null,
    lastError: r.last_error,
  }));
}

/**
 * Watchdog sweep: bounded reconciliation of PENDING intents past the grace
 * interval whose backoff window has arrived. Honours the AUTOPILOT kill switch
 * and the optional-credentials off switch; never polls every customer
 * continuously (per-intent DB-driven backoff + per-cycle cap).
 */
export async function reconcilePaymentSweep(opts: { now?: number; limit?: number } = {}): Promise<{ scanned: number; actionable: number }> {
  if (!razorpayApiConfigured()) return { scanned: 0, actionable: 0 };
  const mode = await getEffectiveUnlockMode();
  if (mode !== 'AUTOPILOT') return { scanned: 0, actionable: 0 };

  const now = opts.now ?? Date.now();
  const limit = Math.min(opts.limit ?? RECONCILE_SWEEP_LIMIT, 25);
  const cutoff = new Date(now - RECONCILE_GRACE_MS).toISOString();

  const rows = await withSystem<Array<{ id: string }>>((db) =>
    db
      .query<{ id: string }>(
        `SELECT i.id
           FROM payment_intents i
           LEFT JOIN payment_reconciliation r ON r.intent_id = i.id
          WHERE i.status = 'PENDING'
            AND i.created_at <= $1
            AND (r.intent_id IS NULL OR (r.state = 'SCHEDULED' AND r.next_attempt_at <= now()))
          ORDER BY i.created_at ASC LIMIT $2`,
        [cutoff, limit],
      )
      .then((r) => r.rows),
  );

  let actionable = 0;
  for (const row of rows) {
    await reconcileIntent(row.id);
    actionable += 1;
  }
  return { scanned: rows.length, actionable };
}

/** Presence-only credential status for reports (values never leave this module). */
export async function reconcileCredentialStatus(): Promise<'MISSING' | 'VALID' | 'INVALID' | 'PRESENT'> {
  try {
    return await probeRazorpayCredentials();
  } catch {
    return razorpayApiConfigured() ? 'PRESENT' : 'MISSING';
  }
}