/**
 * CodeConClave — PRIVATE FOUNDER CONTROL PLANE: reads + founder identity.
 *
 * Every query here is READ-ONLY and globally unscoped (the DB role bypasses
 * RLS like control-center.ts), so EVERY route that uses this module MUST be
 * behind requireAuth + assertControlCenterAccess. Nothing in this module can
 * grant an entitlement, refund, approve a claim or invent payment truth.
 *
 * The single payment/entitlement authority stays where it has always been:
 * activation.applyDecision -> activateEntitlement (webhook / claims / autopilot
 * auto-approval). The founder plane reads that state and exposes the two
 * approved founder controls (autopilot mode, STOP an intervention) which are
 * themselves thin, gated wrappers over existing services.
 */
import { withSystem } from '../../../shared/db.js';
import { env } from '../../../config/env.js';
import { NotificationType } from '@codeconclave/shared';
import { notify } from '../../notifications/service.js';
import { getEffectiveUnlockMode, getRuntimeUnlockMode, autopilotReadiness } from '../autopilot/service.js';
import { controlCenterPayment, controlCenterSummary } from '../control-center.js';
import { listClaimInbox } from '../claims/service.js';

// ---------------------------------------------------------------------------
// FOUNDER IDENTITY + NOTIFICATIONS
// ---------------------------------------------------------------------------

/** Server-side founder lookup from PAYMENT_FOUNDER_EMAIL (fail closed: null). */
export async function getFounderUserId(): Promise<string | null> {
  const email = env.PAYMENT_FOUNDER_EMAIL;
  if (!email) return null;
  const row = await withSystem<{ id: string } | null>(async (q) =>
    q.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email.trim()]).then((r) => r.rows[0] ?? null),
  );
  return row?.id ?? null;
}

export async function isFounderByUserId(userId: string): Promise<boolean> {
  const founderId = await getFounderUserId();
  return founderId ? founderId === userId : false;
}

/**
 * Signal the founder (in-app + optional email) using the existing
 * notifications rail. Never throws — the autopilot/auto-approval hot path must
 * not break when the founder email is unconfigured.
 */
export async function notifyFounder(
  type: (typeof NotificationType)[keyof typeof NotificationType],
  title: string,
  input: Omit<import('../../notifications/service.js').NotifyInput, 'recipientId' | 'type' | 'title'> = {},
): Promise<void> {
  try {
    const founderId = await getFounderUserId();
    if (!founderId) return;
    await notify(founderId, type, title, input);
  } catch {
    // best-effort signal; the authoritative audit trail is already written.
  }
}

// ---------------------------------------------------------------------------
// FOUNDER DASHBOARD
// ---------------------------------------------------------------------------

export interface FounderView {
  periodLabel: string;
  collectedInr: number;
  refundedInr: number;
  netInr: number;
  paidCount: number;
  customerCount: number;
  byProduct: {
    solo: { collectedInr: number; refundedInr: number; paidCount: number };
    team: { collectedInr: number; refundedInr: number; paidCount: number };
    api: { collectedInr: number; refundedInr: number; paidCount: number };
  };
}

export async function founderDashboard(userId: string) {
  const [autopilotState, summary, review, failures, interventions] = await Promise.all([
    founderAutopilotState(),
    controlCenterSummary(),
    founderReviewQueue(20),
    founderVerificationFailures(10),
    listApprovals(),
  ]);
  return {
    autopilot: autopilotState,
    summary,
    review: { total: review.total, rows: review.rows.slice(0, 10) },
    failures,
    interventions,
  };
}

async function listApprovals() {
  const { listAutoApprovals } = await import('../autoapproval/service.js');
  return listAutoApprovals({ limit: 25 });
}

export async function founderAutopilotState() {
  const [effective, runtime, readiness] = await Promise.all([
    getEffectiveUnlockMode(),
    getRuntimeUnlockMode(),
    autopilotReadiness(),
  ]);
  return { effective, runtimeMode: runtime, readiness };
}

// ---------------------------------------------------------------------------
// REVIEW QUEUE (verified-but-unactivated payments must never be lost)
// ---------------------------------------------------------------------------

export interface ReviewQueueRow {
  id: string;
  intentId: string | null;
  userEmail: string | null;
  planId: string;
  amountInr: number;
  source: string;
  paymentId: string | null;
  reason: string | null;
  createdAt: Date;
}

export async function founderReviewQueue(limit = 100): Promise<{ rows: ReviewQueueRow[]; total: number }> {
  const cap = Math.min(limit, 500);

  const reviewIntents = await withSystem<{
    id: string; reference: string; plan_id: string; amount_inr: number; status: string;
    confidence: number | null; created_at: Date; email: string | null; last_source: string | null; provider_payment_id: string | null;
  }[]>(async (q) =>
    (await q.query<{
      id: string; reference: string; plan_id: string; amount_inr: number; status: string;
      confidence: number | null; created_at: Date; email: string | null; last_source: string | null; provider_payment_id: string | null;
    }>(
      `SELECT i.id, i.reference, i.plan_id, i.amount_inr, i.status, i.confidence, i.created_at,
              u.email, e.source AS last_source, e.provider_payment_id
       FROM payment_intents i
       LEFT JOIN users u ON u.id = i.owner_id
       LEFT JOIN LATERAL (
         SELECT source, provider_payment_id FROM payment_evidence ev
         WHERE ev.intent_id = i.id ORDER BY ev.created_at DESC LIMIT 1
       ) e ON true
       WHERE i.status = 'REVIEW'
       ORDER BY i.created_at DESC LIMIT ${cap}`,
    )).rows,
  );
  const reviewRows: ReviewQueueRow[] = reviewIntents.map((r) => ({
    id: `intent:${r.id}`,
    intentId: r.id,
    userEmail: r.email,
    planId: r.plan_id,
    amountInr: r.amount_inr,
    source: r.last_source ?? 'intent',
    paymentId: r.provider_payment_id,
    reason: r.reference,
    createdAt: r.created_at,
  }));

  const claims = await listClaimInbox({ status: 'PENDING', limit: cap });
  const claimRows: ReviewQueueRow[] = (claims.claims ?? []).map((c) => ({
    id: `claim:${c.id}`,
    intentId: c.intentId ?? null,
    userEmail: c.email ?? null,
    planId: c.planId ?? c.purchaseType ?? '',
    amountInr: c.amountInr ?? 0,
    source: c.source ?? 'manual_claim',
    paymentId: c.razorpayPaymentId ?? null,
    reason: c.rejectionReason ?? null,
    createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
  }));

  const rows = [...reviewRows, ...claimRows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, cap);
  return { rows, total: rows.length + (await pendingInterviewCount()) };
}

async function pendingInterviewCount(): Promise<number> {
  const row = await withSystem<{ n: number } | null>(async (q) =>
    q.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_auto_approvals WHERE state = 'PENDING_APPROVAL'`).then((r) => r.rows[0] ?? null),
  );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// VERIFICATION FAILURES + AUDIT TRAIL
// ---------------------------------------------------------------------------

const FAILURE_ACTIONS = [
  'payment.webhook_unmatched',
  'payment.webhook_amount_mismatch',
  'payment.webhook_signature_invalid',
  'payment.auto_approval_review_required',
  'payment.auto_approval_failed',
  'payment.review_required',
  'payment.fraud_flagged',
];

export async function founderVerificationFailures(limit = 50) {
  const cap = Math.min(limit, 200);
  const result = await withSystem((q) =>
    q.query(
      `SELECT id, action, tenant_scope, tenant_id, resource_type, resource_id, detail, created_at
       FROM audit_logs
       WHERE action = ANY($1::text[])
       ORDER BY created_at DESC LIMIT $2`,
      [FAILURE_ACTIONS, cap],
    ),
  );
  return result.rows;
}

export async function founderAuditTrail(limit = 100) {
  const cap = Math.min(limit, 300);
  const result = await withSystem((q) =>
    q.query(
      `SELECT id, action, actor_user_id, tenant_scope, tenant_id, resource_type, resource_id, detail, created_at
       FROM audit_logs
       WHERE action LIKE 'payment.%'
       ORDER BY created_at DESC LIMIT $1`,
      [cap],
    ),
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// PAYMENT DETAIL
// ---------------------------------------------------------------------------

export async function founderPaymentDetail(intentId: string) {
  return controlCenterPayment(intentId);
}