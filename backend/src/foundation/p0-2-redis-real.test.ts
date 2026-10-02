/**
 * CodeConClave — P0-2 REAL Redis (Upstash) security-context test.
 *
 * RUNS AGAINST THE REAL PRODUCTION REDIS (no mocks, no in-memory substitute).
 * Backed by the real `cache` store (ioredis over `REDIS_URL`) exactly as the
 * deployed backend uses it. When REDIS_URL is absent/unreachable (e.g. the unit
 * config's pinned localhost placeholder), the store degrades to the dev memory
 * store and this suite SKIPS HONESTLY rather than passing on a fake store.
 *
 * Coverage:
 *   1. connectivity         — real client PING, set/get/incr/del round-trip
 *   2. MFA single-use       — real `createIdentityMfaChallenge` +
 *                            `verifyIdentityMfaChallenge`: consume once, then
 *                            replay MUST fail (authid:mfa-challenge:<nonce> is
 *                            an atomic INCR, so exactly one caller sees uses=1)
 *   3. replay after restart — a completely fresh client/process instance still
 *                            sees the consumed nonce as burned
 *   4. cross-instance       — two independent real clients: exactly one of the
 *                            two competing INCRs returns 1
 *   5. rate-limit isolation — Client A's `rl:auth:*` bucket cannot move
 *                            Client B's; per-IP and per-identity shapes as the
 *                            shipped middleware builds them
 *   6. queue provider       — QUEUE_PROVIDER=redis confirmed (no memory
 *                            fallback in the deployed configuration)
 *
 * Run (from backend/, after wiring REDIS_URL from the guarded env):
 *   REDIS_URL=<real-rediss://...> QUEUE_PROVIDER=redis \
 *   node ../node_modules/vitest/vitest.mjs run \
 *     --config vitest.integration.config.ts \
 *     src/foundation/p0-2-redis-real.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { cache, initCache } from '../shared/cache.js';
import { createIdentityMfaChallenge, verifyIdentityMfaChallenge } from '../modules/auth/identity.js';

const TEST_NS = `p02r:${Date.now()}:`;
const createdKeys: string[] = [];

let realRedis = false;
let realReason = 'probe not run';

beforeAll(async () => {
  await initCache();
  if (cache.kind !== 'redis') {
    realReason = 'cache store is not redis (no reachable REDIS_URL in this run)';
    return;
  }
  try {
    realRedis = await cache.health();
    realReason = realRedis ? '' : 'cache.health() returned false';
  } catch (err) {
    realReason = err instanceof Error ? err.message : String(err);
  }
});

afterAll(async () => {
  for (const key of createdKeys) {
    await cache.del(key).catch(() => {});
  }
});

it('real Redis not reachable — suite skipped honestly (non-secret reason)', (ctx) => {
  if (realRedis) {
    ctx.skip();
    return;
  }
  expect(realReason).not.toContain(env.REDIS_URL ?? '');
  expect(realReason.length).toBeGreaterThan(0);
});

describe('real Redis: distributed store semantics', () => {
  it('connectivity — PING + set/get/incr/del round-trip', async (ctx) => {
    if (!realRedis) return ctx.skip();
    const key = `${TEST_NS}conn`;
    createdKeys.push(key);
    await cache.set(key, 'hello', 60_000);
    expect(await cache.get(key)).toBe('hello');
    expect(await cache.incr(`${key}ct`, 60_000)).toBe(1);
    expect(await cache.incr(`${key}ct`, 60_000)).toBe(2);
    await cache.del(key);
    expect(await cache.get(key)).toBeNull();
  });

  it('MFA challenge — consume once, replay MUST fail (real verifyIdentityMfaChallenge)', async (ctx) => {
    if (!realRedis) return ctx.skip();
    const token = createIdentityMfaChallenge('usr_p02_redis_a', 'security_key');
    const first = await verifyIdentityMfaChallenge(token);
    expect(first.userId).toBe('usr_p02_redis_a');
    await expect(verifyIdentityMfaChallenge(token)).rejects.toMatchObject({
      errorCode: 'mfa_challenge_replayed',
    });
  });

  it('replay after fresh process instance — burned nonce stays burned', async (ctx) => {
    if (!realRedis) return ctx.skip();
    const token = createIdentityMfaChallenge('usr_p02_redis_b', 'security_key');
    // Consume exactly once through the real app path.
    const first = await verifyIdentityMfaChallenge(token);
    expect(first.userId).toBe('usr_p02_redis_b');
    // "Restart/redeploy" = a brand-new connection to the same shared store:
    // the already-consumed nonce must be seen as used (INCR returns 2),
    // never reset by the new process instance.
    const nonce = decodeChallengeNonce(token);
    const key = `authid:mfa-challenge:${nonce}`;
    const fresh = await createFreshCache();
    try {
      // Fresh instance must observe the already-burned nonce (INCR returns 2).
      expect(await fresh.incr(key, 10_000)).toBe(2);
      await expect(verifyIdentityMfaChallenge(token)).rejects.toMatchObject({
        errorCode: 'mfa_challenge_replayed',
      });
    } finally {
      await fresh.del(key);
    }
  }, 20000);

  it('cross-instance atomicity — exactly one competing INCR wins', async (ctx) => {
    if (!realRedis) return ctx.skip();
    const nonce = `${TEST_NS}xinst`;
    const key = `authid:mfa-challenge:${nonce}`;
    createdKeys.push(key);
    const [a, b] = [await rawClient(), await rawClient()];
    try {
      const [ra, rb] = await Promise.all([a.incr(key), b.incr(key)]);
      const wins = [ra, rb].filter((n) => n === 1).length;
      expect(wins).toBe(1);
    } finally {
      await a.quit().catch(() => {});
      await b.quit().catch(() => {});
    }
  }, 20000);

  it('rate-limit isolation — Client A cannot exhaust Client B', async (ctx) => {
    if (!realRedis) return ctx.skip();
    const ipA = `${TEST_NS}rlA`;
    const ipB = `${TEST_NS}rlB`;
    for (let n = 0; n < 5; n += 1) {
      expect(await cache.incr(`rl:auth:client:ip:${ipA}`, 60_000)).toBe(n + 1);
    }
    expect(await cache.incr(`rl:auth:client:ip:${ipB}`, 60_000)).toBe(1);
    expect(await cache.incr(`rl:auth:client:ip:${ipA}`, 60_000)).toBe(6);
    createdKeys.push(`rl:auth:client:ip:${ipA}`, `rl:auth:client:ip:${ipB}`);
  });
});

describe('real Redis: production configuration', () => {
  it('QUEUE_PROVIDER=redis (no production memory fallback)', (ctx) => {
    if (!realRedis) return ctx.skip();
    expect(env.QUEUE_PROVIDER).toBe('redis');
  });

  it('cache store is redis-typed with working health', (ctx) => {
    if (!realRedis) return ctx.skip();
    expect(cache.kind).toBe('redis');
  });
});

function decodeChallengeNonce(token: string): string {
  const [, body] = /^imfa_([^.]+)\.[^.]+$/.exec(token) ?? [];
  if (!body) throw new Error('malformed imfa token in test');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { nonce: string };
  return payload.nonce;
}

async function createFreshCache() {
  const client = new Redis(env.REDIS_URL ?? '', {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    commandTimeout: 10_000,
  });
  client.on('error', () => {});
  await client.connect();
  return {
    async incr(key: string, ttlMs: number) {
      const n = await client.incr(key);
      if (n === 1) await client.pexpire(key, ttlMs);
      return n;
    },
    async del(key: string) {
      await client.del(key);
    },
  };
}

function rawClient() {
  const client = new Redis(env.REDIS_URL ?? '', { lazyConnect: true });
  client.on('error', () => {});
  return client.connect().then(() => client);
}