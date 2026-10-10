/**
 * CodeConClave — durable demo-activation and self-service payment records.
 *
 * These replace JSON blobs written into Redis. Two properties are load-bearing:
 *
 *  1. Only the SHA-256 of the emailed token is ever persisted; the raw token is
 *     never stored.
 *  2. The single-use transition is ONE conditional UPDATE guarded on the pending
 *     status and the expiry. The Redis implementation did GET -> check -> GET
 *     -> SET, which two concurrent callers could both win; here exactly one
 *     caller can move a row out of the pending status.
 *
 * The demo record is pinned in the schema: `status` only accepts the existing
 * DemoStatus values, `payment_verification_method` defaults to 'DEMO_REDIRECT'
 * and `is_real_payment` is CHECK-constrained to false, so a demo row can never be
 * promoted into real payment evidence. Nothing here writes entitlements — that
 * stays the caller's job exactly as before, so no entitlement can be created by
 * this module.
 */
import { pool } from './db.js';

export interface DemoActivationRow {
  token_hash: string;
  session_id: string | null;
  user_id: string | null;
  email: string;
  plan: 'pro' | 'team';
  amount_inr: number;
  status: 'DEMO_PENDING' | 'DEMO_ACTIVATED';
  payment_verification_method: string;
  is_real_payment: boolean;
  issued_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

export interface SelfServiceTokenRow {
  token_hash: string;
  user_id: string | null;
  intent_id: string | null;
  plan_id: string | null;
  amount_inr: number;
  status: 'PENDING' | 'USED';
  issued_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

export interface DemoActivationInput {
  tokenHash: string;
  sessionId: string;
  userId: string;
  email: string;
  plan: 'pro' | 'team';
  amountInr: number;
  ttlMs: number;
}

export interface SelfServiceTokenInput {
  tokenHash: string;
  userId: string;
  intentId: string;
  planId: string;
  amountInr: number;
  ttlMs: number;
}

/**
 * Persist a freshly issued demo activation.
 *
 * Insert-only: an existing token_hash is left untouched rather than reset, so a
 * replayed issue cannot revive a spent activation.
 */
export async function issueDemoActivation(input: DemoActivationInput): Promise<DemoActivationRow> {
  const result = await pool.query<DemoActivationRow>(
    `INSERT INTO payment_demo_activations
       (token_hash, session_id, user_id, email, plan, amount_inr, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' milliseconds')::interval)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING *`,
    [input.tokenHash, input.sessionId, input.userId, input.email, input.plan, input.amountInr, input.ttlMs],
  );
  const row = result.rows[0];
  if (!row) throw new Error('demo activation already issued for this token');
  return row;
}

export async function findDemoActivation(tokenHash: string): Promise<DemoActivationRow | null> {
  const result = await pool.query<DemoActivationRow>(
    `SELECT * FROM payment_demo_activations WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically move a demo activation from pending to activated.
 *
 * Returns the activated row to the single caller that won the transition, and
 * null to every concurrent or later caller — the caller maps null to its
 * existing "already used" rejection. Expiry is part of the guard, so an expired
 * activation can never be redeemed by winning the race.
 */
export async function consumeDemoActivation(tokenHash: string): Promise<DemoActivationRow | null> {
  const result = await pool.query<DemoActivationRow>(
    `UPDATE payment_demo_activations
        SET status = 'DEMO_ACTIVATED', used_at = now()
      WHERE token_hash = $1
        AND status = 'DEMO_PENDING'
        AND expires_at > now()
      RETURNING *`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Persist a freshly issued self-service confirmation.
 *
 * `intent_id` is recorded for audit only; this module never marks an intent paid
 * and never creates an entitlement, so the normal payment contract is untouched.
 */
export async function issueSelfServiceToken(input: SelfServiceTokenInput): Promise<SelfServiceTokenRow> {
  const result = await pool.query<SelfServiceTokenRow>(
    `INSERT INTO payment_self_service_tokens
       (token_hash, user_id, intent_id, plan_id, amount_inr, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING *`,
    [input.tokenHash, input.userId, input.intentId, input.planId, input.amountInr, input.ttlMs],
  );
  const row = result.rows[0];
  if (!row) throw new Error('self-service confirmation already issued for this token');
  return row;
}

export async function findSelfServiceToken(tokenHash: string): Promise<SelfServiceTokenRow | null> {
  const result = await pool.query<SelfServiceTokenRow>(
    `SELECT * FROM payment_self_service_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically move a self-service confirmation from PENDING to USED.
 *
 * Exactly one caller wins; every replay receives null and is rejected. This is
 * what makes a second redemption of the same emailed link impossible even when
 * two instances verify it at the same instant.
 */
export async function consumeSelfServiceToken(tokenHash: string): Promise<SelfServiceTokenRow | null> {
  const result = await pool.query<SelfServiceTokenRow>(
    `UPDATE payment_self_service_tokens
        SET status = 'USED', used_at = now()
      WHERE token_hash = $1
        AND status = 'PENDING'
        AND expires_at > now()
      RETURNING *`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Delete expired payment token rows.
 *
 * Bounded, indexed on `expires_at`, and idempotent so concurrent sweeps from
 * several instances are safe. Expired rows are already unusable because both
 * consume paths guard on `expires_at > now()`.
 */
export async function expirePaymentTokens(limit = 500): Promise<{ demo: number; selfService: number }> {
  const demo = await pool.query(
    `DELETE FROM payment_demo_activations WHERE token_hash IN (
       SELECT token_hash FROM payment_demo_activations WHERE expires_at <= now() LIMIT $1
     )`,
    [limit],
  );
  const selfService = await pool.query(
    `DELETE FROM payment_self_service_tokens WHERE token_hash IN (
       SELECT token_hash FROM payment_self_service_tokens WHERE expires_at <= now() LIMIT $1
     )`,
    [limit],
  );
  return { demo: demo.rowCount ?? 0, selfService: selfService.rowCount ?? 0 };
}
