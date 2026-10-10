/**
 * CodeConClave — durable PostgreSQL replacement for the Redis counter/bucket store.
 *
 * Every primitive here is a SINGLE statement, so the read-decide-write sequence
 * happens under one row lock. That is what makes the limits safe with several
 * backend instances: two concurrent increments serialize on the same row and
 * each caller observes a distinct, gap-free value, and two concurrent cooldown
 * claims cannot both win.
 *
 * These functions deliberately THROW on database failure instead of falling back
 * to per-process memory. A silent fallback is precisely the failure mode that
 * would let auth brute-force and API-key limits be bypassed by spreading traffic
 * across instances, so callers keep their existing fail-closed handling.
 */
import { pool } from './db.js';

export interface RateCounterRow {
  bucket_key: string;
  count: string | number;
  window_started_at: Date;
  expires_at: Date;
}

/**
 * Atomically increment a fixed-window bucket and return the new count.
 *
 * The window is stamped on the FIRST increment only. Later increments never
 * extend `expires_at`, so the window is anchored to the first request and cannot
 * be stretched by hammering the endpoint — identical to Redis INCR where the TTL
 * is applied only when the increment returns 1.
 *
 * An expired row is reset to 1 with a fresh window inside the same statement, so
 * a stale bucket can never leak a previously large count into a new window.
 */
export async function incrementRateCounter(bucketKey: string, windowMs: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `INSERT INTO auth_rate_counters (bucket_key, count, window_started_at, expires_at)
     VALUES ($1, 1, now(), now() + ($2 || ' milliseconds')::interval)
     ON CONFLICT (bucket_key) DO UPDATE SET
       count             = CASE WHEN auth_rate_counters.expires_at <= now() THEN 1
                                 ELSE auth_rate_counters.count + 1 END,
       window_started_at = CASE WHEN auth_rate_counters.expires_at <= now() THEN now()
                                 ELSE auth_rate_counters.window_started_at END,
       expires_at        = CASE WHEN auth_rate_counters.expires_at <= now()
                                 THEN now() + ($2 || ' milliseconds')::interval
                                 ELSE auth_rate_counters.expires_at END,
       updated_at        = now()
     RETURNING count`,
    [bucketKey, windowMs],
  );
  return Number(result.rows[0]!.count);
}

/** Current count for a bucket, or 0 when the bucket is absent or expired. */
export async function readRateCounter(bucketKey: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count FROM auth_rate_counters WHERE bucket_key = $1 AND expires_at > now()`,
    [bucketKey],
  );
  return result.rows[0] ? Number(result.rows[0].count) : 0;
}

/**
 * Atomically claim a cooldown slot.
 *
 * Returns true when the caller may proceed and false while the previous marker
 * is still inside `minIntervalMs`. Because the conditional UPDATE *is* the
 * decision, two instances racing on the same cooldown cannot both succeed —
 * the loser's statement matches no row.
 */
export async function acquireLastSeen(scopeKey: string, minIntervalMs: number, ttlMs: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO auth_last_seen (scope_key, seen_at, expires_at)
     VALUES ($1, now(), now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (scope_key) DO UPDATE SET
       seen_at    = now(),
       expires_at = now() + ($3 || ' milliseconds')::interval,
       updated_at = now()
     WHERE auth_last_seen.seen_at <= now() - ($2 || ' milliseconds')::interval
     RETURNING scope_key`,
    [scopeKey, minIntervalMs, ttlMs],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Timestamp of the last successful cooldown claim, or null when never claimed. */
export async function readLastSeen(scopeKey: string): Promise<number | null> {
  const result = await pool.query<{ seen_at: Date }>(
    `SELECT seen_at FROM auth_last_seen WHERE scope_key = $1 AND expires_at > now()`,
    [scopeKey],
  );
  const row = result.rows[0];
  return row ? new Date(row.seen_at).getTime() : null;
}

/**
 * Delete expired buckets and cooldown markers.
 *
 * Bounded and indexed on `expires_at`, so this is an index range scan with a
 * LIMIT rather than a full-table pass, and it never touches live rows. Safe to
 * run from several instances at once: the predicate is idempotent and a losing
 * racer simply matches fewer rows.
 */
export async function expireDurableCounters(limit = 1000): Promise<{ counters: number; lastSeen: number }> {
  const counters = await pool.query(
    `DELETE FROM auth_rate_counters WHERE bucket_key IN (
       SELECT bucket_key FROM auth_rate_counters WHERE expires_at <= now() LIMIT $1
     )`,
    [limit],
  );
  const lastSeen = await pool.query(
    `DELETE FROM auth_last_seen WHERE scope_key IN (
       SELECT scope_key FROM auth_last_seen WHERE expires_at <= now() LIMIT $1
     )`,
    [limit],
  );
  return { counters: counters.rowCount ?? 0, lastSeen: lastSeen.rowCount ?? 0 };
}
