/**
 * CodeConClave — durable single-use burn for MFA / security-key challenges.
 *
 * The Redis implementation was an atomic INCR on `authid:mfa-challenge:<nonce>`:
 * the first caller saw 1 and was allowed through, every later or concurrent
 * caller saw >1 and was rejected. Here the INSERT *is* the consume, so a nonce
 * can be spent exactly once with no read-modify-write window and no dependence
 * on a store that can silently degrade to per-process memory.
 *
 * Fail-closed is preserved deliberately: a database error propagates to the
 * caller. An unverifiable challenge must never be treated as a fresh one, so
 * this module never returns "allowed" on an error path.
 */
import { pool } from './db.js';

/**
 * Atomically consume a challenge nonce.
 *
 * Returns true when this caller is the first (and therefore only) consumer, and
 * false when the nonce was already spent — which the caller maps to the existing
 * `mfa_challenge_replayed` rejection. Concurrent callers cannot both receive
 * true: the second INSERT conflicts and matches no row.
 *
 * `remainingTtlMs` is the challenge's remaining lifetime, so the marker is
 * retained for exactly as long as the challenge could still be presented and is
 * then eligible for cleanup.
 */
export async function burnChallengeNonce(nonce: string, remainingTtlMs: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO auth_challenge_uses (nonce, expires_at)
     VALUES ($1, now() + ($2 || ' milliseconds')::interval)
     ON CONFLICT (nonce) DO NOTHING
     RETURNING nonce`,
    [nonce, Math.max(remainingTtlMs, 1)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** True when a nonce has already been spent. Never treats absence as "fresh". */
export async function isChallengeNonceSpent(nonce: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM auth_challenge_uses WHERE nonce = $1`, [nonce]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Delete expired burn markers.
 *
 * Bounded and indexed on `expires_at`; idempotent, so concurrent sweeps from
 * multiple instances are safe.
 */
export async function expireChallengeUses(limit = 1000): Promise<number> {
  const result = await pool.query(
    `DELETE FROM auth_challenge_uses WHERE nonce IN (
       SELECT nonce FROM auth_challenge_uses WHERE expires_at <= now() LIMIT $1
     )`,
    [limit],
  );
  return result.rowCount ?? 0;
}
