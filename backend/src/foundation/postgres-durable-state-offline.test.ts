/**
 * CodeConClave — Phase 2 offline contract tests for the durable-state primitives.
 *
 * These run with NO database. They assert the properties that make the
 * primitives safe to reason about before any migration is applied anywhere:
 *
 *   1. Each mutating primitive issues exactly ONE statement. A read-then-write
 *      would reintroduce the TOCTOU window this work exists to close, so the
 *      statement count is pinned rather than assumed.
 *   2. That statement carries the atomicity primitives: ON CONFLICT for the
 *      increment/burn paths, a conditional WHERE for cooldown and concurrency
 *      admission, and a status guard for the single-use payment transitions.
 *   3. Nothing silently degrades: there is no in-memory or null-returning
 *      fallback on an error path, so callers keep their fail-closed behaviour.
 *
 * The real behaviour and concurrency proofs live in
 * postgres-durable-state.test.ts against a real database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() =>
  vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 })),
);

vi.mock('../shared/db.js', () => ({
  pool: { query: queryMock },
}));

const counters = await import('../shared/durable-counters.js');
const challenges = await import('../shared/durable-challenges.js');
const concurrency = await import('../shared/durable-concurrency.js');
const payment = await import('../shared/durable-payment-tokens.js');

function lastSql(): string {
  return String(queryMock.mock.calls.at(-1)?.[0] ?? '');
}

function callCount(): number {
  return queryMock.mock.calls.length;
}

beforeEach(() => {
  queryMock.mockClear();
  queryMock.mockResolvedValue({ rows: [{ count: '1' }], rowCount: 1 });
});

describe('single-statement guarantee', () => {
  it('incrementRateCounter issues exactly one statement', async () => {
    await counters.incrementRateCounter('k', 1000);
    expect(callCount()).toBe(1);
  });

  it('acquireLastSeen issues exactly one statement', async () => {
    await counters.acquireLastSeen('k', 1000, 1000);
    expect(callCount()).toBe(1);
  });

  it('burnChallengeNonce issues exactly one statement', async () => {
    await challenges.burnChallengeNonce('n', 1000);
    expect(callCount()).toBe(1);
  });

  it('acquireApiKeySlot issues exactly one statement', async () => {
    await concurrency.acquireApiKeySlot('key', 5);
    expect(callCount()).toBe(1);
  });

  it('releaseApiKeySlot issues exactly one statement', async () => {
    await concurrency.releaseApiKeySlot('key');
    expect(callCount()).toBe(1);
  });

  it('consumeDemoActivation issues exactly one statement', async () => {
    await payment.consumeDemoActivation('h');
    expect(callCount()).toBe(1);
  });

  it('consumeSelfServiceToken issues exactly one statement', async () => {
    await payment.consumeSelfServiceToken('h');
    expect(callCount()).toBe(1);
  });

  it('read helpers issue at most one statement', async () => {
    await counters.readRateCounter('k');
    expect(callCount()).toBe(1);
    queryMock.mockClear();
    await counters.readLastSeen('k');
    expect(callCount()).toBe(1);
    queryMock.mockClear();
    await concurrency.readApiKeyActive('k');
    expect(callCount()).toBe(1);
  });
});

describe('atomicity primitives present in the emitted SQL', () => {
  it('the increment is a single upsert guarded on the window', async () => {
    await counters.incrementRateCounter('k', 1000);
    const sql = lastSql();
    expect(sql).toMatch(/INSERT\s+INTO\s+auth_rate_counters/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(bucket_key\)\s+DO\s+UPDATE/i);
    // TTL stamped only on the first increment, never extended.
    expect(sql).toMatch(/expires_at\s*<=\s*now\(\)\s+THEN\s+1/i);
    expect(sql).toMatch(/RETURNING\s+count/i);
    // No read-modify-write.
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });

  it('the cooldown claim decides inside the conditional UPDATE', async () => {
    await counters.acquireLastSeen('k', 1000, 1000);
    const sql = lastSql();
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(scope_key\)\s+DO\s+UPDATE/i);
    expect(sql).toMatch(/WHERE\s+auth_last_seen\.seen_at\s*<=/i);
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });

  it('the challenge burn is insert-or-nothing and returns nothing on replay', async () => {
    await challenges.burnChallengeNonce('n', 1000);
    const sql = lastSql();
    expect(sql).toMatch(/INSERT\s+INTO\s+auth_challenge_uses/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(nonce\)\s+DO\s+NOTHING/i);
    expect(sql).toMatch(/RETURNING\s+nonce/i);
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });

  it('the concurrency acquire enforces the cap in the same statement', async () => {
    await concurrency.acquireApiKeySlot('key', 7);
    const sql = lastSql();
    expect(sql).toMatch(/INSERT\s+INTO\s+api_key_concurrency/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(key_id\)\s+DO\s+UPDATE/i);
    // The admission predicate lives in the upsert, so "refused" is a DB fact.
    expect(sql).toMatch(/WHERE\s+c\.expires_at\s*<=\s*now\(\)\s+OR\s+c\.active\s*<\s*\$2/i);
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });

  it('the concurrency release is an atomic decrement that cannot go negative', async () => {
    await concurrency.releaseApiKeySlot('key');
    const sql = lastSql();
    expect(sql).toMatch(/UPDATE\s+api_key_concurrency/i);
    expect(sql).toMatch(/GREATEST\(\s*0\s*,\s*active\s*-\s*1\s*\)/i);
    expect(sql).toMatch(/active\s*>\s*0/i);
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });

  it('both payment transitions are guarded on the pending status and expiry', async () => {
    await payment.consumeDemoActivation('h');
    let sql = lastSql();
    expect(sql).toMatch(/status\s*=\s*'DEMO_ACTIVATED'/i);
    expect(sql).toMatch(/status\s*=\s*'DEMO_PENDING'/i);
    expect(sql).toMatch(/expires_at\s*>\s*now\(\)/i);
    expect(sql).not.toMatch(/\bSELECT\b/i);

    await payment.consumeSelfServiceToken('h');
    sql = lastSql();
    expect(sql).toMatch(/status\s*=\s*'USED'/i);
    expect(sql).toMatch(/status\s*=\s*'PENDING'/i);
    expect(sql).toMatch(/expires_at\s*>\s*now\(\)/i);
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });

  it('issuance is insert-only so a spent token cannot be revived', async () => {
    await payment.issueDemoActivation({
      tokenHash: 'h',
      sessionId: 's',
      userId: 'u',
      email: 'e@x.invalid',
      plan: 'pro',
      amountInr: 1,
      ttlMs: 1000,
    }).catch(() => undefined);
    expect(lastSql()).toMatch(/ON\s+CONFLICT\s*\(token_hash\)\s+DO\s+NOTHING/i);
  });

  it('cleanup is bounded, indexed and never touches live rows', async () => {
    await counters.expireDurableCounters();
    let sql = lastSql();
    expect(sql).toMatch(/DELETE\s+FROM\s+auth_last_seen/i);
    expect(sql).toMatch(/expires_at\s*<=\s*now\(\)/i);
    expect(sql).toMatch(/LIMIT\s+\$1/i);

    queryMock.mockClear();
    await challenges.expireChallengeUses();
    expect(lastSql()).toMatch(/DELETE\s+FROM\s+auth_challenge_uses/i);

    queryMock.mockClear();
    await concurrency.expireStaleApiKeyConcurrency();
    expect(lastSql()).toMatch(/DELETE\s+FROM\s+api_key_concurrency/i);

    queryMock.mockClear();
    await payment.expirePaymentTokens();
    expect(lastSql()).toMatch(/DELETE\s+FROM\s+payment_self_service_tokens/i);
  });
});

describe('no silent degradation', () => {
  it('a database failure propagates instead of returning a permissive value', async () => {
    // Not `Once`: every primitive in this block must see the failure.
    queryMock.mockRejectedValue(new Error('db down'));

    // Rate limits must fail closed: the caller decides 503, and an unresolved
    // rejection here would silently ALLOW the request.
    await expect(counters.incrementRateCounter('k', 1000)).rejects.toThrow('db down');
    await expect(counters.acquireLastSeen('k', 1000, 1000)).rejects.toThrow('db down');
    // A challenge burn must never resolve true when it could not be recorded.
    await expect(challenges.burnChallengeNonce('n', 1000)).rejects.toThrow('db down');
    // Concurrency must fail closed rather than admit an untracked request.
    await expect(concurrency.acquireApiKeySlot('key', 5)).rejects.toThrow('db down');
  });

  it('an empty result row is treated as a refusal, not as success', async () => {
    // rowCount 0 means the upsert's admission predicate suppressed the update
    // (at cap / inside cooldown / already burned). None of these may be read as
    // "allowed".
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await concurrency.acquireApiKeySlot('key', 1)).toBeNull();
    expect(await challenges.burnChallengeNonce('n', 1000)).toBe(false);
    expect(await counters.acquireLastSeen('k', 60_000, 1000)).toBe(false);
    expect(await payment.consumeDemoActivation('h')).toBeNull();
    expect(await payment.consumeSelfServiceToken('h')).toBeNull();
  });
});
