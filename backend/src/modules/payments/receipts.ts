/**
 * CodeConClave — STAGE 26H: receipts / welcome.
 *
 * Resends the payment receipt (or welcome) notification for an intent.
 * Only ACTIVE (or REFUNDED) intents have a receipt to resend — a PENDING or
 * REVIEW intent gets nothing (no premature claims).
 */
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { NotificationType } from '@codeconclave/shared';
import { getIntent } from './intents.js';

export async function resendReceipt(userId: string, intentId: string): Promise<{ sent: boolean; status: string }> {
  const intent = await getIntent(userId, intentId);
  if (intent.status !== 'ACTIVE' && intent.status !== 'GRACE' && intent.status !== 'REFUNDED') {
    throw AppError.conflict('receipt_not_available', `No receipt is available for a ${intent.status.toLowerCase()} intent`);
  }
  const refunded = intent.status === 'REFUNDED';
  await notify(userId, NotificationType.PAYMENT_STATUS, refunded ? 'Payment refund receipt' : 'Payment receipt', {
    body: refunded
      ? `Refund receipt for your ${intent.plan_id.toUpperCase()} payment (₹${intent.amount_inr}). Reference ${intent.reference}.`
      : `Thank you! Your ${intent.plan_id.toUpperCase()} plan payment of ₹${intent.amount_inr} (reference ${intent.reference}) is confirmed.`,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    metadata: {
      plan: intent.plan_id,
      amountInr: intent.amount_inr,
      reference: intent.reference,
      status: intent.status,
      activatedAt: intent.activated_at?.toISOString() ?? null,
    },
    email: true,
  });
  await recordAudit({
    action: 'payment.receipt_sent',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_intent',
    resourceId: intent.id,
    detail: { plan: intent.plan_id, status: intent.status },
  });
  return { sent: true, status: intent.status };
}