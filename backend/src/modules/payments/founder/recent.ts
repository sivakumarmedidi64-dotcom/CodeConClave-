/**
 * CodeConClave — founder recent-payments read (server truth, no client input).
 */
import { withSystem } from '../../../shared/db.js';

export interface RecentIntentRow {
  id: string;
  planId: string;
  purchaseType: string;
  amountInr: number;
  status: string;
  reference: string | null;
  userEmail: string | null;
  paymentId: string | null;
  evidenceSource: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export async function recentIntents(limit = 20): Promise<RecentIntentRow[]> {
  const cap = Math.min(limit, 100);
  return withSystem<RecentIntentRow[]>(async (q) =>
    (
      await q.query<RecentIntentRow>(
      `SELECT i.id, i.plan_id AS "planId", i.purchase_type AS "purchaseType",
            i.amount_inr AS "amountInr", i.status, i.reference,
            u.email AS "userEmail",
            e.provider_payment_id AS "paymentId",
            e.source AS "evidenceSource",
            e.paid_at AS "paidAt",
            i.created_at AS "createdAt"
     FROM payment_intents i
     LEFT JOIN users u ON u.id = i.owner_id
     LEFT JOIN LATERAL (
       SELECT source, provider_payment_id, paid_at FROM payment_evidence ev
       WHERE ev.intent_id = i.id ORDER BY ev.created_at DESC LIMIT 1
     ) e ON true
     ORDER BY COALESCE(e.paid_at, i.activated_at, i.created_at) DESC
     LIMIT ${cap}`,
      )
    ).rows,
  );
}