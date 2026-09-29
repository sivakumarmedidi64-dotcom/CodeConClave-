/**
 * P0-3 — reverse-proxy trust model and rate-limit identity.
 *
 * These tests pin the two properties the audit found broken:
 *   1. Behind a shared proxy, Client A must not be able to consume Client B's
 *      authentication budget.
 *   2. A client must not be able to choose its own rate-limit identity by
 *      forging X-Forwarded-For.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TrustProxyConfigError,
  assertTrustProxyUsable,
  describeTrustProxy,
  parseTrustProxy,
  toExpressTrustProxy,
} from '../config/trust-proxy.js';

describe('P0-3 trust proxy model', () => {
  it('treats unset/false/0 as no trusted proxy', () => {
    expect(parseTrustProxy(undefined)).toEqual({ kind: 'none' });
    expect(parseTrustProxy('')).toEqual({ kind: 'none' });
    expect(parseTrustProxy('false')).toEqual({ kind: 'none' });
    expect(parseTrustProxy('0')).toEqual({ kind: 'none' });
  });

  it('rejects blind boolean trust instead of enabling IP spoofing', () => {
    expect(() => parseTrustProxy('true')).toThrow(TrustProxyConfigError);
    expect(() => parseTrustProxy('TRUE')).toThrow(/spoof their own IP/);
    expect(() => parseTrustProxy('*')).toThrow(TrustProxyConfigError);
  });

  it('parses a bounded hop count', () => {
    expect(parseTrustProxy('1')).toEqual({ kind: 'hops', hops: 1 });
    expect(parseTrustProxy('2')).toEqual({ kind: 'hops', hops: 2 });
    expect(toExpressTrustProxy({ kind: 'hops', hops: 2 })).toBe(2);
  });

  it('rejects hop counts outside the safe range', () => {
    expect(() => parseTrustProxy('0')).not.toThrow();
    expect(() => parseTrustProxy('11')).toThrow(/between 1 and 10/);
  });

  it('parses a proxy allowlist of IPs and CIDRs', () => {
    const model = parseTrustProxy('10.0.0.1, 10.1.0.0/16, 2001:db8::1');
    expect(model).toEqual({
      kind: 'addresses',
      // Bare IPv4 is widened to a single host; a bare IPv6 address is left
      // intact because Express/proxy-addr treats a colonless-vs-colon form
      // differently, and widening an IPv6 host mask is error-prone.
      addresses: ['10.0.0.1/32', '10.1.0.0/16', '2001:db8::1'],
    });
    expect(toExpressTrustProxy(model)).toBe('10.0.0.1/32, 10.1.0.0/16, 2001:db8::1');
  });

  it('rejects malformed proxy addresses rather than trusting nothing', () => {
    expect(() => parseTrustProxy('not-an-ip')).toThrow(/not a valid IP address or CIDR/);
    expect(() => parseTrustProxy('10.0.0.1,garbage')).toThrow(TrustProxyConfigError);
  });

  it('refuses to boot in production with no proxy model configured', () => {
    expect(() => assertTrustProxyUsable({ kind: 'none' }, true)).toThrow(
      /Missing production requirement: TRUST_PROXY/,
    );
    expect(() => assertTrustProxyUsable({ kind: 'none' }, false)).not.toThrow();
    expect(() => assertTrustProxyUsable({ kind: 'hops', hops: 1 }, true)).not.toThrow();
  });

  it('describes the model without leaking configuration values', () => {
    expect(describeTrustProxy({ kind: 'none' })).toMatch(/direct/);
    expect(describeTrustProxy({ kind: 'hops', hops: 3 })).toBe('3 proxy hop(s)');
  });
});

/** Minimal in-memory stand-in for the shared cache, mirroring cache.incr semantics. */
class FakeCache {
  private readonly counters = new Map<string, number>();
  incr(key: string, _windowMs: number): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
  clear(): void {
    this.counters.clear();
  }
}

function makeReq(opts: {
  ip?: string;
  body?: unknown;
  userId?: string;
  headers?: Record<string, string>;
}) {
  return {
    ip: opts.ip,
    body: opts.body,
    headers: opts.headers ?? {},
    ctx: opts.userId ? { user: { id: opts.userId } } : {},
  } as never;
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    headers,
  } as never;
}

describe('P0-3 rate limit identity', () => {
  let cacheMock: FakeCache;

  beforeEach(() => {
    vi.resetModules();
    cacheMock = new FakeCache();
    vi.doMock('../shared/cache.js', () => ({
      cache: {
        incr: (key: string, window: number) => cacheMock.incr(key, window),
        health: () => Promise.resolve(),
      },
    }));
  });

  it('keeps Client A from consuming Client B authentication budget', async () => {
    const { identityAwareLimit } = await import('../middleware/rate-limit.js');
    // perClient is generous; the per-identity budget is the one under test.
    const limit = identityAwareLimit({ name: 't', perClient: 1000, perIdentity: 3, windowMs: 60_000 });

    const attempt = async (ip: string, body: unknown) => {
      let outcome: 'ok' | 'limited' = 'ok';
      await new Promise<void>((resolve) => {
        limit(makeReq({ ip, body }), makeRes(), (err?: unknown) => {
          if (err) outcome = 'limited';
          resolve();
        });
      });
      return outcome;
    };

    // Client A exhausts its own identifier budget on its own handle.
    for (let i = 0; i < 3; i += 1) {
      expect(await attempt('1.1.1.1', { handle: 'Alice' })).toBe('ok');
    }
    expect(await attempt('1.1.1.1', { handle: 'Alice' })).toBe('limited');

    // Client B, on a different IP and a different handle, is unaffected.
    expect(await attempt('2.2.2.2', { handle: 'bob' })).toBe('ok');
    expect(await attempt('2.2.2.2', { handle: 'bob' })).toBe('ok');

    // Client B attacking Client A's handle is capped by A's identifier budget,
    // so A's account cannot be locked out from a third address.
    expect(await attempt('3.3.3.3', { handle: 'alice' })).toBe('limited');
  });

  it('caps an attacker who rotates identifiers on one connection', async () => {
    const { identityAwareLimit } = await import('../middleware/rate-limit.js');
    const limit = identityAwareLimit({ name: 't', perClient: 4, perIdentity: 100, windowMs: 60_000 });

    const attempt = async (body: unknown) => {
      let outcome: 'ok' | 'limited' = 'ok';
      await new Promise<void>((resolve) => {
        limit(makeReq({ ip: '9.9.9.9', body }), makeRes(), (err?: unknown) => {
          if (err) outcome = 'limited';
          resolve();
        });
      });
      return outcome;
    };

    // Each request uses a brand-new identifier, so the per-identity budget never
    // trips; the per-client budget must stop the rotation.
    const results: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await attempt({ handle: `victim-${i}` }));
    }
    expect(results.filter((r) => r === 'ok').length).toBe(4);
    expect(results[5]).toBe('limited');
  });

  it('falls back to the client address when no identifier is submitted', async () => {
    const { identityAwareLimit } = await import('../middleware/rate-limit.js');
    const limit = identityAwareLimit({ name: 't', perClient: 1000, perIdentity: 2, windowMs: 60_000 });
    const attempt = async () => {
      let outcome: 'ok' | 'limited' = 'ok';
      await new Promise<void>((resolve) => {
        limit(makeReq({ ip: '4.4.4.4', body: {} }), makeRes(), (err?: unknown) => {
          if (err) outcome = 'limited';
          resolve();
        });
      });
      return outcome;
    };
    expect(await attempt()).toBe('ok');
    expect(await attempt()).toBe('ok');
    expect(await attempt()).toBe('limited');
  });

  it('normalizes identifier casing so handle aliases share one budget', async () => {
    const { identityAwareLimit } = await import('../middleware/rate-limit.js');
    const limit = identityAwareLimit({ name: 't', perClient: 1000, perIdentity: 2, windowMs: 60_000 });
    const attempt = async (handle: string) => {
      let outcome: 'ok' | 'limited' = 'ok';
      await new Promise<void>((resolve) => {
        limit(makeReq({ ip: '5.5.5.5', body: { handle } }), makeRes(), (err?: unknown) => {
          if (err) outcome = 'limited';
          resolve();
        });
      });
      return outcome;
    };
    expect(await attempt('Alice')).toBe('ok');
    expect(await attempt('ALICE')).toBe('ok');
    expect(await attempt('  alice  ')).toBe('limited');
  });

  it('ignores a client-supplied identity header for bucketing', async () => {
    const { identityAwareLimit } = await import('../middleware/rate-limit.js');
    const limit = identityAwareLimit({ name: 't', perClient: 1000, perIdentity: 1, windowMs: 60_000 });
    const attempt = async (header: string) => {
      let outcome: 'ok' | 'limited' = 'ok';
      await new Promise<void>((resolve) => {
        limit(
          makeReq({ ip: '6.6.6.6', body: {}, headers: { 'x-auth-identifier': header } }),
          makeRes(),
          (err?: unknown) => {
            if (err) outcome = 'limited';
            resolve();
          },
        );
      });
      return outcome;
    };
    // Headers are never used as an identity source, so rotating one cannot
    // mint a fresh budget; the request falls back to the client address.
    expect(await attempt('one')).toBe('ok');
    expect(await attempt('two')).toBe('limited');
  });

  it('fails closed when the rate limit store is unavailable', async () => {
    vi.resetModules();
    vi.doMock('../shared/cache.js', () => ({
      cache: {
        incr: () => Promise.reject(new Error('redis down')),
        health: () => Promise.resolve(),
      },
    }));
    const { identityAwareLimit } = await import('../middleware/rate-limit.js');
    const limit = identityAwareLimit({ name: 't', perClient: 10, perIdentity: 10, windowMs: 60_000 });
    const err = await new Promise<unknown>((resolve) => {
      limit(makeReq({ ip: '7.7.7.7', body: {} }), makeRes(), (e?: unknown) => resolve(e));
    });
    expect(err).toBeTruthy();
  });
});
