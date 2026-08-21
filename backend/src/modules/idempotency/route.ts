/**
 * CodeConClave — idempotent route helper (Phase 16).
 * Wraps a state-changing handler so an offline client retry with the same
 * Idempotency-Key replays the stored response instead of double-executing.
 * The handler's return value must be the jsonResult payload (response body).
 */
import { beginIdempotent, completeIdempotent, failIdempotent } from './service.js';

export type IdempotentResult<T> =
  | { outcome: 'replay'; response: unknown }
  | { outcome: 'executed'; response: T };

export async function withIdempotency<T>(
  opts: {
    op: string;
    key: string | undefined;
    userId: string;
    payload: unknown;
    run: () => Promise<T>;
  },
): Promise<IdempotentResult<T>> {
  const { op, key, userId, payload, run } = opts;
  if (!key) {
    // No key supplied: execute once, no replay guarantee (plain request).
    return { outcome: 'executed', response: await run() };
  }
  const begun = await beginIdempotent({ key, userId, op, payload });
  if (begun.outcome === 'replay') return { outcome: 'replay', response: begun.response };
  try {
    const response = await run();
    await completeIdempotent(key, userId, response);
    return { outcome: 'executed', response };
  } catch (err) {
    await failIdempotent(key, userId);
    throw err;
  }
}

export function idempotencyKeyFrom(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}