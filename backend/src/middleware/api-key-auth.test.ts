/**
 * CodeConClave — Bearer API-key auth gateway (/api/v1/ai): identity, the
 * mandatory API Access (₹9,999) product gate, per-key window/daily/concurrency
 * limits and FAIL-CLOSED outage behavior. Session requests without a Bearer
 * header always pass through unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const svc = vi.hoisted(() => ({
  resolveUserApiKey: vi.fn(async () => ({ ownerId: 'usr_owner', keyId: 'ak_key' })),
  apiAccessEntitlementState: vi.fn(async () => ({ planId: 'api', entitled: true, state: 'PRO_VERIFIED' })),
}));
vi.mock('../modules/apikeys/service.js', () => svc);

const mem = vi.hoisted(() => {
  interface Entry { value: string; expiresAt: number }
  const store = new Map<string, Entry>();
  let failAll = false;
  return {
    store,
    failAll,
    async get(key: string): Promise<string | null> {
      if (mem.failAll) throw new Error('cache outage');
      const e = store.get(key);
      if (!e) return null;
      if (Date.now() > e.expiresAt) { store.delete(key); return null; }
      return e.value;
    },
    async set(key: string, value: string, ttlMs: number): Promise<void> {
      if (mem.failAll) throw new Error('cache outage');
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    async incr(key: string, ttlMs: number): Promise<number> {
      if (mem.failAll) throw new Error('cache outage');
      const now = Date.now();
      const e = store.get(key);
      if (!e || now > e.expiresAt!) { store.set(key, { value: '1', expiresAt: now + ttlMs }); return 1; }
      const next = Number(e.value) + 1;
      store.set(key, { value: String(next), expiresAt: now + ttlMs });
      return next;
    },
  };
});
vi.mock('../shared/cache.js', () => ({ cache: mem }));

const db = vi.hoisted(() => {
  const query = vi.fn(async () => ({
    rows: [{
      id: 'usr_owner', email: 'api-owner@codeconclave.dev', email_verified: true,
      display_name: null, avatar_url: null, google_sub: null, role: null,
      primary_use_case: null, mfa_enabled: false,
      rbac_role: 'member', plan_id: 'free', entitlement_state: 'FREE',
    }],
  }));
  return { pool: { query } };
});
vi.mock('../shared/db.js', () => db);

import { AppError } from '../shared/errors.js';
import { env } from '../config/env.js';
import { apiKeyAuth } from './api-key-auth.js';

function makeReq(headers: Record<string, string> = {}, ctx: Record<string, unknown> | null = {}) {
  return { headers, ctx: ctx as { user?: { id: string } } & Record<string, unknown> } as unknown as Parameters<Parameters<typeof apiKeyAuth>[0]>[0];
}

function makeRes() {
  const res = new EventEmitter() as EventEmitter & { setHeader: ReturnType<typeof vi.fn>; keepAliveProperty: unknown };
  (res as unknown as { setHeader: unknown }).setHeader = vi.fn();
  return res;
}

type NextFn = (err?: unknown) => void;

beforeEach(() => {
  vi.clearAllMocks();
  mem.store.clear();
  mem.failAll = false;
  env.API_RATE_LIMIT_REQUESTS = 60;
  env.API_RATE_LIMIT_WINDOW_SECONDS = 60;
  env.API_MAX_CONCURRENT_REQUESTS = 3;
  env.API_MAX_DAILY_REQUESTS = 500;
});

afterEach(() => {
  mem.failAll = false;
  mem.store.clear();
});

async function run(headers: Record<string, string>, ctx: Record<string, unknown> | null = {}) {
  const req = makeReq(headers, ctx);
  const res = makeRes();
  const next: NextFn = vi.fn();
  await (apiKeyAuth())(req, res, next);
  return { req, res, next };
}

describe('apiKeyAuth — identity (Bearer)', () => {
  it('passes session requests through untouched when no Bearer token is present', async () => {
    const { next, req } = await run({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.ctx!.user).toBeUndefined();
  });

  it('also passes through garbage Authorization headers (never matches Bearer)', async () => {
    const { next } = await run({ authorization: 'Basic abc==' });
    expect(next).toHaveBeenCalledWith();
  });

  it('denies invalid/expired/revoked keys with 401 invalid_api_key', async () => {
    svc.resolveUserApiKey.mockResolvedValueOnce(null);
    const { next } = await run({ authorization: 'Bearer cc_live_bogus' });
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.errorCode).toBe('invalid_api_key');
  });
});

describe('apiKeyAuth — API Access product gate', () => {
  it('denies a valid key without a VERIFIED api entitlement (402) — Solo/Team never grant it', async () => {
    svc.apiAccessEntitlementState.mockResolvedValueOnce({ planId: 'api', entitled: false, state: 'PRO_PENDING' });
    const { next } = await run({ authorization: 'Bearer cc_live_own' });
    const err = next.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe('api_access_required');
    expect(err.message).toContain('₹9,999');
    expect(mem.store.size).toBe(0);
  });

  it('allows an entitled key through and populates the request identity for downstream handlers', async () => {
    const { next, req, res } = await run({ authorization: 'Bearer cc_live_own' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.ctx!.user).toMatchObject({ id: 'usr_owner', email: 'api-owner@codeconclave.dev' });
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '60');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
  });
});

describe('apiKeyAuth — per-key rate limiting', () => {
  it('rejects a request over the window limit (429 rate_limited)', async () => {
    mem.store.set('rl:apikey:w:ak_key', { value: '60', expiresAt: Date.now() + 60_000 });
    const { next } = await run({ authorization: 'Bearer cc_live_own' });
    const err = next.mock.calls[0]![0] as AppError;
    expect(err.status).toBe(429);
    expect(err.errorCode).toBe('rate_limited');
  });

  it('rejects a request over the daily budget (429)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mem.store.set(`rl:apikey:d:ak_key:${today}`, { value: '500', expiresAt: Date.now() + 86_400_000 });
    const { next } = await run({ authorization: 'Bearer cc_live_own' });
    expect((next.mock.calls[0]![0] as AppError).status).toBe(429);
  });

  it('caps in-flight concurrency per key and releases it when the response closes', async () => {
    mem.store.set('rl:apikey:conc:ak_key', { value: '3', expiresAt: Date.now() + 120_000 });
    const { next, res } = await run({ authorization: 'Bearer cc_live_own' });
    expect((next.mock.calls[0]![0] as AppError).status).toBe(429);
    expect(mem.store.get('rl:apikey:conc:ak_key')!.value).toBe('3');

    mem.store.set('rl:apikey:conc:ak_key', { value: '1', expiresAt: Date.now() + 120_000 });
    const ok = await run({ authorization: 'Bearer cc_live_own' });
    expect(ok.next.mock.calls[0]![0]).toBeUndefined();
    expect(mem.store.get('rl:apikey:conc:ak_key')!.value).toBe('2');
    ok.res.emit('close');
    await new Promise((r) => setImmediate(r));
    expect(mem.store.get('rl:apikey:conc:ak_key')!.value).toBe('1');
  });

  it('PROOF — a rate-limited request NEVER reaches a downstream provider call (Express mount, counter stays 0)', async () => {
    const { default: express } = await import('express');
    const downstreamProviderCalls = vi.fn(async () => ({
      choices: [{ message: { content: 'ok' } }],
    }));
    const app = express();
    app.use(apiKeyAuth());
    app.post('/api/v1/ai', async (_req, res) => {
      const out = await downstreamProviderCalls();
      res.json(out);
    });
    app.use((err: AppError, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
      res.status(err.status ?? 500).json({ error: { code: err.errorCode ?? 'error' } });
    });
    // Window budget exhausted for this key.
    mem.store.set('rl:apikey:w:ak_key', { value: '60', expiresAt: Date.now() + 60_000 });

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/ai`, {
        method: 'POST',
        headers: { authorization: 'Bearer cc_live_own', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('rate_limited');
      // The provider adapter was NEVER invoked: the gateway cut off the
      // request before the downstream AI route could call it.
      expect(downstreamProviderCalls).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('apiKeyAuth — fail closed', () => {
  it('returns 503 when the key owner row is gone', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [] });
    const { next } = await run({ authorization: 'Bearer cc_live_own' });
    const err = next.mock.calls[0]![0] as AppError;
    expect(err.status).toBe(401);
    expect(err.errorCode).toBe('api_key_owner_missing');
  });

  it('fails closed (503) on any inner error — never silently unlimited', async () => {
    svc.resolveUserApiKey.mockRejectedValueOnce(new Error('db transient'));
    const { next } = await run({ authorization: 'Bearer cc_live_own' });
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe('api_key_auth_unavailable');
  });

  it('fails closed (503) when the limit store is unavailable', async () => {
    mem.failAll = true;
    const { next } = await run({ authorization: 'Bearer cc_live_own' });
    const err = next.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe('api_key_auth_unavailable');
  });
});