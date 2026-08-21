/**
 * CodeConClave — STAGE 26H: founder payment digest.
 *
 * Aggregate payment/intent/evidence/fraud state for the founder. Gate is the
 * configured PAYMENT_FOUNDER_EMAIL — anyone else gets forbidden. Digests are
 * persisted (one per bucket) and audited.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';

export interface DigestRow {
  id: string;
  bucket: string;
  period_days: number;
  stats: Record<string, unknown>;
  created_at: Date;
}

export async function isFounder(userId: string): Promise<boolean> {
  const email = env.PAYMENT_FOUNDER_EMAIL;
  if (!email) return false;
  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  return user?.email?.trim().toLowerCase() === email.trim().toLowerCase();
}

export async function generateFounderDigest(userId: string, periodDays = 7): Promise<DigestRow> {
  if (!(await isFounder(userId))) {
    throw AppError.forbidden('founder_only', 'The payment digest is restricted to the configured founder account');
  }

  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

  const byStatus = await queryMany<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM payment_intents WHERE created_at >= $1 GROUP BY status`,
    [since],
  );
  const bySource = await queryMany<{ source: string; n: number }>(
    `SELECT source, count(*)::int AS n FROM payment_evidence WHERE created_at >= $1 GROUP BY source`,
    [since],
  );
  const fraud = await queryMany<{ id: string; intent_id: string; fraud_flags: string[] }>(
    `SELECT id, intent_id, fraud_flags FROM payment_evidence WHERE created_at >= $1 AND (fraud_flags IS NOT NULL AND jsonb_array_length(fraud_flags::jsonb) > 0)`,
    [since],
  );
  const collected = await queryMany<{ total: number }>(
    `SELECT COALESCE(sum(amount_inr),0)::int AS total FROM payment_intents WHERE status IN ('ACTIVE','GRACE')`,
  );
  const refunded = await queryMany<{ total: number }>(
    `SELECT COALESCE(sum(amount_inr),0)::int AS total FROM payment_intents WHERE status = 'REFUNDED'`,
  );
  const review = await queryMany<{ id: string; reference: string; confidence: number }>(
    `SELECT id, reference, confidence FROM payment_intents WHERE status = 'REVIEW' AND created_at >= $1`,
    [since],
  );
  const drift = await queryMany<{ status: string }>(
    `SELECT status FROM payment_reconciliations ORDER BY created_at DESC LIMIT 1`,
  );

  const stats: Record<string, unknown> = {
    periodDays,
    since,
    intentsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    evidenceBySource: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
    fraudFlaggedEvidence: fraud.length,
    collectedInr: collected[0]?.total ?? 0,
    refundedInr: refunded[0]?.total ?? 0,
    reviewQueue: review,
    lastReconciliationStatus: drift[0]?.status ?? null,
  };

  const bucket = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO payment_digests (id, bucket, period_days, stats)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (bucket) DO UPDATE SET stats = EXCLUDED.stats, period_days = EXCLUDED.period_days, created_at = now()`,
    [newId(PREFIX.PAYMENT_DIGEST), bucket, periodDays, JSON.stringify(stats)],
  );
  await recordAudit({
    action: 'payment.digest_generated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'payment_digest',
    resourceId: bucket,
    detail: { bucket, periodDays, stats },
  });

  const row = await queryOne<DigestRow>('SELECT * FROM payment_digests WHERE bucket = $1', [bucket]);
  return row!;
}

export async function listDigests(userId: string, limit = 10): Promise<DigestRow[]> {
  if (!(await isFounder(userId))) {
    throw AppError.forbidden('founder_only', 'The payment digest is restricted to the configured founder account');
  }
  return queryMany<DigestRow>('SELECT * FROM payment_digests ORDER BY created_at DESC LIMIT $1', [limit]);
}