/**
 * CodeConClave — PAYMENT AUTOPILOT INTERVENTION WINDOW.
 *
 * AUTOPILOT does not activate synchronously on a verified webhook. Every
 * successfully resolved autopilot payment first lands in
 * `payment_auto_approvals` as PENDING_APPROVAL: a durable, server-side window
 * (env.PAYMENT_AUTO_APPROVAL_MS, default 2000ms) during which the founder can
 * STOP/HOLD. If no one acts, `sweepAutoApprovals` transitions the row to
 * AUTO_APPROVED and runs the SAME trusted activation authority
 * (pipeline.ingestEvidence -> applyDecision -> activateEntitlement) that every
 * other rail uses — the payment was ALREADY verified by the signed webhook
 * resolver before this module was ever called; the timer expiry is never
 * payment proof, it only decides WHO approves (founder STOP) vs WHEN the
 * verified payment activates (auto).
 *
 * Exactly-once + idempotency:
 *   - payment_id UNIQUE => a re-delivered/replayed event can never schedule a
 *     second approval;
 *   - the PENDING_APPROVAL -> AUTO_APPROVED transition is an atomic guarded
 *     UPDATE (a concurrent sweep/decision loses and skips);
 *   - STOP is idempotent and can only transition PENDING_APPROVAL -> STOPPED;
 *     an already-AUTO_APPROVED activation can never be rolled back by STOP.
 *
 * Fail-closed:
 *   - a STOPped approval moves the intent to REVIEW and queues a founder
 *     review (payment_claim_reviews, source=autopilot) so the payment is not
 *     lost;
 *   - an ingestion/activation failure during auto-approval ALSO moves the
 *     intent to REVIEW + queues a founder review — never a silent unlock.
 *
 * This is a server-side payment rail with no authenticated principal (signed
 * webhook / watchdog / control-center-admin). Every query is system-scoped and
 * runs on `withSystem` clients; external rails (audit, notify, queueFounderReview,
 * pipeline) stay outside the callbacks.
 */
import { withSystem } from '../../../shared/db.js';
import { env } from '../../../config/env.js';
import { newId, PREFIX } from '../../../shared/ids.js';
import { logger } from '../../../shared/logger.js';
import { NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../../audit/service.js';
import { ingestEvidence } from '../pipeline.js';
import { purchaseTypeForPlan } from '../intents.js';
import { queueAutopilotReview } from '../autopilot/service.js';
import { notifyFounder } from '../founder/service.js';

export type AutoApprovalState = 'PENDING_APPROVAL' | 'AUTO_APPROVED' | 'STOPPED';

export interface AutoApprovalRow {
  id: string;
  intent_id: string;
  payment_id: string;
  plan_id: string;
  purchase_type: string;
  amount_inr: number;
  payer_email: string | null;
  owner_id: string;
  payload: Record<string, unknown>;
  state: AutoApprovalState;
  decided_by: string | null;
  stop_reason: string | null;
  created_at: Date;
  approved_at: Date | null;
  stopped_at: Date | null;
}

export interface ApprovalSignalPayload {
  paymentId: string;
  amountInr?: number;
  payerEmail?: string;
  paidAt?: string;
}

export type RequestApprovalOutcome =
  | { planned: 'PENDING' }
  | { planned: 'ALREADY_PENDING' }
  | { planned: 'ALREADY_APPROVED' }
  | { planned: 'ALREADY_STOPPED' }
  | { planned: 'REVIEW_QUEUED'; reason: string };

/** The 2-second intervention window (ms). */
export function autoApprovalWindowMs(): number {
  return env.PAYMENT_AUTO_APPROVAL_MS;
}

/**
 * Schedule a verified autopilot payment into the intervention window. Only the
 * webhook handler calls this, AFTER the signed-webhook resolver has proven the
 * product binding + amount + unique pending intent. Returns a fail-closed
 * outcome; a payment without a valid provider id is never scheduled — it goes
 * straight to the founder review queue instead.
 */
export async function requestAutoApproval(args: {
  intent: { id: string; owner_id: string; plan_id: string; amount_inr: number };
  signal: ApprovalSignalPayload;
}): Promise<RequestApprovalOutcome> {
  const { intent, signal } = args;
  const paymentId = signal.paymentId;
  if (!paymentId || !/^pay_[A-Za-z0-9_-]{8,64}$/.test(paymentId)) {
    await queueFounderReview(intent, paymentId);
    return { planned: 'REVIEW_QUEUED', reason: 'invalid_payment_id' };
  }

  const purchaseType = purchaseTypeForPlan(intent.plan_id);
  if (!purchaseType) {
    await queueFounderReview(intent, paymentId);
    return { planned: 'REVIEW_QUEUED', reason: 'unknown_plan' };
  }

  const insert = await withSystem(async (q) =>
    q.query<{ id: string; state: string }>(
      `INSERT INTO payment_auto_approvals
         (id, intent_id, payment_id, plan_id, purchase_type, amount_inr, payer_email,
          owner_id, payload, state, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'PENDING_APPROVAL',$10)
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING id, state`,
      [
        newId(PREFIX.PAYMENT),
        intent.id,
        paymentId,
        intent.plan_id,
        purchaseType,
        intent.amount_inr,
        signal.payerEmail ?? null,
        intent.owner_id,
        JSON.stringify(signal),
        intent.owner_id,
      ],
    ),
  );
  if (insert.rowCount === 1) {
    await recordAudit({
      action: 'payment.auto_approval_scheduled',
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: intent.owner_id,
      resourceType: 'payment_auto_approval',
      resourceId: paymentId,
      detail: { intent: intent.id, plan: intent.plan_id, amountInr: intent.amount_inr, paymentId },
    });
    await notifyFounder(
      NotificationType.PAYMENT_REVIEW_REQUIRED,
      'Auto-approval in 2 seconds — [STOP] to review',
      {
        body: `${intent.plan_id.toUpperCase()} ₹${intent.amount_inr} verified. Auto-approval in ${Math.round(
          autoApprovalWindowMs() / 1000,
        )}s unless stopped.`,
        resourceType: 'payment_auto_approval',
        resourceId: paymentId,
        email: true,
      },
    );
    return { planned: 'PENDING' };
  }

  const existing = await withSystem(async (q) =>
    (
      await q.query<{ state: string }>(
        `SELECT state FROM payment_auto_approvals WHERE payment_id = $1`,
        [paymentId],
      )
    ).rows[0],
  );
  switch (existing?.state) {
    case 'AUTO_APPROVED':
      return { planned: 'ALREADY_APPROVED' };
    case 'STOPPED':
      return { planned: 'ALREADY_STOPPED' };
    default:
      return { planned: 'ALREADY_PENDING' };
  }
}

/**
 * Founder STOP/HOLD. Idempotent. Only transitions PENDING_APPROVAL -> STOPPED;
 * an already-auto-approved payment is never rolled back (the entitlement grant
 * authority is replayed-exactly-once). On success the intent moves to REVIEW and
 * a founder review is queued so the verified payment is not lost.
 */
export async function stopAutoApproval(
  paymentId: string,
  actorUserId: string,
  reason: string | null,
): Promise<{ stopped: boolean; state?: AutoApprovalState; reason?: string; intentId?: string }> {
  if (!paymentId || !/^pay_[A-Za-z0-9_-]{8,64}$/.test(paymentId)) {
    return { stopped: false, reason: 'invalid_payment_id' };
  }

  const update = await withSystem(async (q) =>
    q.query<{ id: string; intent_id: string; owner_id: string; plan_id: string; amount_inr: number }>(
      `UPDATE payment_auto_approvals
       SET state = 'STOPPED', decided_by = $2, stop_reason = $3, stopped_at = now()
       WHERE payment_id = $1 AND state = 'PENDING_APPROVAL'
       RETURNING id, intent_id, owner_id, plan_id, amount_inr`,
      [paymentId, actorUserId, reason ?? null],
    ),
  );
  const row = update.rows[0];
  if (!row) {
    const existing = await withSystem(async (q) =>
      (
        await q.query<{ state: AutoApprovalState }>(
          `SELECT state FROM payment_auto_approvals WHERE payment_id = $1`,
          [paymentId],
        )
      ).rows[0],
    );
    if (!existing) return { stopped: false, reason: 'not_found' };
    return { stopped: false, state: existing.state, reason: existing.state === 'AUTO_APPROVED' ? 'already_approved' : 'already_stopped' };
  }

  await withSystem(async (q) => {
    await q.query(
      `UPDATE payment_intents SET status = 'REVIEW', updated_at = now()
       WHERE id = $1 AND status IN ('PENDING','REVIEW')`,
      [row.intent_id],
    );
  });
  await queueFounderReview({ id: row.intent_id, owner_id: row.owner_id, plan_id: row.plan_id }, paymentId);
  await recordAudit({
    action: 'payment.auto_approval_stopped',
    actorUserId: actorUserId,
    scope: 'SYSTEM',
    tenantId: row.owner_id,
    resourceType: 'payment_auto_approval',
    resourceId: paymentId,
    detail: { intent: row.intent_id, plan: row.plan_id, reason: reason ?? null },
  });
  await notifyFounder(
    'payment.review_required',
    'Auto-approval stopped — manual review',
    {
      body: `${row.plan_id.toUpperCase()} ₹${row.amount_inr} (${paymentId}) sent to manual review.`,
      resourceType: 'payment_auto_approval',
      resourceId: paymentId,
      email: true,
    },
  );
  return { stopped: true, state: 'STOPPED', intentId: row.intent_id };
}

/**
 * Sweep the intervention window (server-side timer, durable). Every
 * PENDING_APPROVAL row older than the window is auto-approved exactly once via
 * the trusted activation authority; failures fail closed to REVIEW + founder
 * review. Safe to run from a fast interval AND the 15s watchdog.
 */
export async function sweepAutoApprovals(opts: { now?: number; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - autoApprovalWindowMs()).toISOString();
  const limit = Math.min(opts.limit ?? 50, 200);

  const pending = await withSystem(async (q) =>
    (
      await q.query<AutoApprovalRow>(
        `SELECT * FROM payment_auto_approvals
         WHERE state = 'PENDING_APPROVAL' AND created_at <= $1
         ORDER BY created_at ASC LIMIT $2`,
        [cutoff, limit],
      )
    ).rows,
  );

  let processed = 0;
  for (const row of pending) {
    // Exactly-once claim: only one sweeper/decision may win the transition.
    const claimed = await withSystem(async (q) =>
      q.query(
        `UPDATE payment_auto_approvals
         SET state = 'AUTO_APPROVED', approved_at = now()
         WHERE id = $1 AND state = 'PENDING_APPROVAL'
         RETURNING id`,
        [row.id],
      ),
    );
    if (claimed.rowCount !== 1) continue; // another sweeper already decided

    processed += 1;
    try {
      // Conditional guard: only transition the intent if it is still
      // PENDING. REVIEW intents were deliberately moved there by STOP or
      // by the pipeline's fail-closed path — the sweep must not override
      // that decision. Previously REVIEW was also allowed, which created
      // a race where a STOP could move the intent to REVIEW but the sweep
      // (having already claimed AUTO_APPROVED) would still activate it.
      const intentCheck = await withSystem(async (q) =>
        (
          await q.query<{ status: string }>(
            `SELECT status FROM payment_intents WHERE id = $1`,
            [row.intent_id],
          )
        ).rows[0],
      );
      if (!intentCheck || intentCheck.status !== 'PENDING') {
        // Intent was already handled (ACTIVE, REVIEW, EXPIRED, etc.) — skip
        // activation but still record the approval was consumed.
        await recordAudit({
          action: 'payment.auto_approval_skipped',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: row.owner_id,
          resourceType: 'payment_auto_approval',
          resourceId: row.payment_id,
          detail: { intent: row.intent_id, intentStatus: intentCheck?.status ?? 'missing', reason: 'intent_not_activatable' },
        });
        continue;
      }
      const result = await ingestEvidence(row.owner_id, row.intent_id, 'razorpay_autopilot', {
        paymentId: row.payload?.paymentId ?? row.payment_id,
        amountInr: row.payload?.amountInr ?? row.amount_inr,
        payerEmail: row.payload?.payerEmail ?? row.payer_email,
        paidAt: row.payload?.paidAt ?? null,
      });
      if (result.result?.intentStatus === 'ACTIVE') {
        await recordAudit({
          action: 'payment.autopilot_activated',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: row.owner_id,
          resourceType: 'payment_auto_approval',
          resourceId: row.payment_id,
          detail: { intent: row.intent_id, plan: row.plan_id, decision: result.result.decision, confidence: result.result.confidence },
        });
        await notifyFounder(
          NotificationType.PAYMENT_STATUS,
          'Payment auto-approved',
          {
            body: `${row.plan_id.toUpperCase()} ₹${row.amount_inr} (${row.payment_id}) activated automatically (no intervention).`,
            resourceType: 'payment_auto_approval',
            resourceId: row.payment_id,
            email: true,
          },
        );
      } else {
        // The trusted pipeline refused (fraud/uncertainty) — fail closed: the
        // verified payment must not be lost, so it goes to the founder inbox.
        await withSystem(async (q) => {
          await q.query(
            `UPDATE payment_intents SET status = 'REVIEW', updated_at = now()
             WHERE id = $1 AND status IN ('PENDING','REVIEW')`,
            [row.intent_id],
          );
        });
        await queueFounderReview({ id: row.intent_id, owner_id: row.owner_id, plan_id: row.plan_id }, row.payment_id);
        await recordAudit({
          action: 'payment.auto_approval_review_required',
          actorUserId: null,
          scope: 'SYSTEM',
          tenantId: row.owner_id,
          resourceType: 'payment_auto_approval',
          resourceId: row.payment_id,
          detail: { intent: row.intent_id, intentStatus: result.result?.intentStatus, decision: result.result?.decision },
        });
      }
    } catch (err) {
      // DB/pipeline failure must never unlock: force REVIEW + founder review.
      await withSystem(async (q) => {
        await q.query(
          `UPDATE payment_intents SET status = 'REVIEW', updated_at = now()
           WHERE id = $1 AND status IN ('PENDING','REVIEW')`,
          [row.intent_id],
        );
      });
      await queueFounderReview({ id: row.intent_id, owner_id: row.owner_id, plan_id: row.plan_id }, row.payment_id);
      await recordAudit({
        action: 'payment.auto_approval_failed',
        actorUserId: null,
        scope: 'SYSTEM',
        tenantId: row.owner_id,
        resourceType: 'payment_auto_approval',
        resourceId: row.payment_id,
        detail: { intent: row.intent_id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return processed;
}

export async function listAutoApprovals(opts: { state?: AutoApprovalState; limit?: number } = {}): Promise<{
  rows: Array<AutoApprovalRow & { intent_status: string | null }>;
  pendingCount: number;
}> {
  return withSystem(async (q) => {
    const params: unknown[] = [];
    let where = '1=1';
    if (opts.state) {
      params.push(opts.state);
      where = `state = $${params.length}`;
    }
    const limit = Math.min(opts.limit ?? 100, 500);
    params.push(limit);
    const rows = (
      await q.query<AutoApprovalRow & { intent_status: string | null }>(
        `SELECT a.*, i.status AS intent_status
         FROM payment_auto_approvals a
         LEFT JOIN payment_intents i ON i.id = a.intent_id
         WHERE ${where}
         ORDER BY a.created_at DESC LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const counts = (
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_auto_approvals WHERE state = 'PENDING_APPROVAL'`,
      )
    ).rows[0];
    return { rows, pendingCount: counts?.n ?? 0 };
  });
}

/** Best-effort founder-review queue (never throws into the caller). */
async function queueFounderReview(
  intent: { id: string; owner_id: string; plan_id: string },
  paymentId: string | undefined,
): Promise<void> {
  try {
    const owner = await withSystem(async (q) =>
      (
        await q.query<{ email: string }>(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [intent.owner_id])
      ).rows[0],
    );
    if (owner?.email) {
      await queueAutopilotReview({
        user: { id: intent.owner_id, email: owner.email },
        intent: { id: intent.id, plan_id: intent.plan_id },
        paymentId,
      });
    }
  } catch {
    // best-effort: the intent already sits in REVIEW for the control-center.
  }
}

export function startAutoApprovalSweep(intervalMs = 1000): () => void {
  void sweepAutoApprovals().catch((err) => {
    logger.warn('auto-approval sweep init failed', { error: err instanceof Error ? err.message : String(err) });
  });
  const timer = setInterval(() => {
    void sweepAutoApprovals().catch((err) => {
      logger.warn('auto-approval sweep failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}