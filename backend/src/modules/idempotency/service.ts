/**
 * CodeConClave — idempotency keys (Phase 16).
 * Server-side dedupe for offline-synced state changes. The client generates a
 * per-operation idempotency key; the first request executes the operation, any
 * later request with the same (user, key) replays the stored response instead
 * of mutating state a second time. Keys expire after 24h (watchdog sweep).
 * The server remains authoritative: a replayed response is only returned when
 * the payload hash matches — a different payload with the same key is a client
 * bug and is rejected, never silently executed.
 */
import { withTenant, pool, queryOne } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/crypto.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRow {
  id: string;
  key: string;
  user_id: string;
  op: string;
  payload_hash: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  response: unknown;
  created_at: Date;
  completed_at: Date | null;
}

export interface IdempotencyBegin {
  outcome: 'new';
  row: IdempotencyRow;
}

export interface IdempotencyReplay {
  outcome: 'replay';
  response: unknown;
}

export function hashPayload(op: string, payload: unknown): string {
  return sha256Hex(`${op}:${JSON.stringify(payload ?? null)}`);
}

/**
 * Begin an idempotent operation. Returns 'new' when this (user, key) is
 * unknown — the caller executes the operation — or 'replay' with the stored
 * response when a completed operation with the same payload hash exists.
 * Throws idempotency_key_reused when the key was used with a different payload.
 */
export async function beginIdempotent(input: {
  key: string;
  userId: string;
  op: string;
  payload: unknown;
}): Promise<IdempotencyBegin | IdempotencyReplay> {
  const key = input.key.trim();
  if (!key || key.length > 128) throw AppError.badRequest('invalid_idempotency_key', 'Idempotency-Key must be 1-128 characters');
  const payloadHash = hashPayload(input.op, input.payload);
  const existing = await withTenant<IdempotencyRow | null>(input.userId, async (q) =>
    (await q.query<IdempotencyRow>('SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2', [input.userId, key])).rows[0] ?? null,
  );
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw AppError.conflict('idempotency_key_reused', 'Idempotency-Key was already used with a different payload');
    }
    if (existing.status === 'COMPLETED') {
      return { outcome: 'replay', response: existing.response };
    }
    if (existing.status === 'FAILED') {
      throw AppError.conflict('idempotency_key_failed', 'This operation failed previously; retry with a fresh key');
    }
    // PENDING from a concurrent in-flight request: treat as new — the caller
    // re-executes and we overwrite the pending row when it completes.
  }
  const id = newId(PREFIX.IDEMPOTENCY);
  await withTenant(input.userId, (q) =>
    q.query(
      `INSERT INTO idempotency_keys (id, key, user_id, op, payload_hash, status)
       VALUES ($1,$2,$3,$4,$5,'PENDING')
       ON CONFLICT (user_id, key) DO UPDATE SET payload_hash = EXCLUDED.payload_hash, op = EXCLUDED.op`,
      [id, key, input.userId, input.op, payloadHash],
    ),
  );
  const row = await withTenant<IdempotencyRow | null>(input.userId, async (q) =>
    (await q.query<IdempotencyRow>('SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2', [input.userId, key])).rows[0] ?? null,
  );
  return { outcome: 'new', row: row! };
}

/** Mark a completed idempotent operation and store its response for replay. */
export async function completeIdempotent(key: string, userId: string, response: unknown): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
        SET status = 'COMPLETED', response = $3::jsonb, completed_at = now()
      WHERE user_id = $1 AND key = $2`,
    [userId, key, JSON.stringify(response)],
  );
}

/** Mark a failed idempotent operation (never replayed). */
export async function failIdempotent(key: string, userId: string): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys SET status = 'FAILED', completed_at = now()
      WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
}

/** Watchdog: drop keys older than the 24h window (bounded table growth). */
export async function expireIdempotencyKeys(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' milliseconds')::interval`,
    [IDEMPOTENCY_TTL_MS],
  );
  return result.rowCount ?? 0;
}

export { PREFIX as _idempotencyPrefix };