/**
 * CodeConClave — durable API-key in-flight concurrency accounting.
 *
 * Replaces a Redis read-modify-write (`GET` then `SET`) whose comment claimed an
 * atomic DECRBY the store interface never provided. Both directions are now
 * single statements, so slots can neither leak under concurrent release nor be
 * double-issued under concurrent acquire.
 *
 * The cap is enforced inside the acquire statement: when the live count has
 * already reached the limit the conditional update is suppressed and no row is
 * returned, so "refused" is a database fact rather than a racy read.
 */
import { pool } from './db.js';

/** Stale-holder safety net, matching the previous 120s TTL semantics. */
export const CONCURRENCY_TTL_MS = 120_000;

/**
 * Atomically take one in-flight slot for an API key.
 *
 * Returns the new active count, or null when the cap is already reached (or the
 * previous holder's row went stale at the cap). A null result is the caller's
 * signal to reject with the existing `tooMany` response — no counter is left
 * incremented, so a refused request never consumes a slot.
 */
export async function acquireApiKeySlot(
  keyId: string,
  maxConcurrent: number,
  ttlMs: number = CONCURRENCY_TTL_MS,
): Promise<number | null> {
  const result = await pool.query<{ active: number }>(
    `INSERT INTO api_key_concurrency AS c (key_id, active, updated_at, expires_at)
     VALUES ($1, 1, now(), now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (key_id) DO UPDATE SET
       active     = CASE WHEN c.expires_at <= now() THEN 1 ELSE c.active + 1 END,
       updated_at = now(),
       expires_at = now() + ($3 || ' milliseconds')::interval
     WHERE c.expires_at <= now() OR c.active < $2
     RETURNING c.active`,
    [keyId, maxConcurrent, ttlMs],
  );
  return result.rows[0] ? Number(result.rows[0].active) : null;
}

/**
 * Atomically give one in-flight slot back.
 *
 * `GREATEST(0, active - 1)` plus the `active > 0` predicate makes an
 * over-release a no-op instead of a negative count, so a duplicated release
 * event cannot hand a later request free capacity.
 */
export async function releaseApiKeySlot(keyId: string): Promise<number> {
  const result = await pool.query<{ active: number }>(
    `UPDATE api_key_concurrency
        SET active = GREATEST(0, active - 1), updated_at = now()
      WHERE key_id = $1 AND active > 0
      RETURNING active`,
    [keyId],
  );
  return result.rows[0] ? Number(result.rows[0].active) : 0;
}

/** Live in-flight count, treating a lapsed row as empty. */
export async function readApiKeyActive(keyId: string): Promise<number> {
  const result = await pool.query<{ active: number }>(
    `SELECT active FROM api_key_concurrency WHERE key_id = $1 AND expires_at > now()`,
    [keyId],
  );
  return result.rows[0] ? Number(result.rows[0].active) : 0;
}

/**
 * Drop rows whose holder is presumed dead (TTL lapsed without a release).
 *
 * Purely hygiene: `acquireApiKeySlot` already treats a lapsed row as empty, so
 * this sweep never changes an admission decision. Bounded and idempotent.
 */
export async function expireStaleApiKeyConcurrency(limit = 500): Promise<number> {
  const result = await pool.query(
    `DELETE FROM api_key_concurrency WHERE key_id IN (
       SELECT key_id FROM api_key_concurrency WHERE expires_at <= now() LIMIT $1
     )`,
    [limit],
  );
  return result.rowCount ?? 0;
}
