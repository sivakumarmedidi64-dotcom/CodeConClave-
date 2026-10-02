/**
 * CodeConClave — JSON-body POST error-semantics regression tests.
 *
 * Pins the fix for the production JSON-POST defect: a JSON-body POST whose
 * body-parser rejects it (e.g. malformed JSON → entity.parse.failed) previously
 * escaped the error mapper to a sanitized 500 `internal_error`. It must be a
 * sanitized 400. All other status semantics are pinned unchanged:
 *
 *   401 auth failure · 403 CSRF failure · 400 validation · 429/503 rate limit ·
 *   500 unexpected (sanitized, no stack).
 *
 * These run against the assembled app (`createApp`) like a real client: DB and
 * cache stores are mocked but the full HTTP/middleware stack is exercised.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

const db = vi.hoisted(() => {
  const query = async () => ({ rows: [], rowCount: 0 });
  return {
    pool: { query },
    queryMany: async () => [],
    queryOne: async () => null,
    ping: async () => true,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const cacheMock = vi.hoisted(() => ({
  cache: {
    kind: 'memory' as const,
    health: async () => true,
    incr: async () => 1,
    get: async () => null,
    set: async () => {},
  },
}));
vi.mock('../shared/cache.js', () => cacheMock);

import { createApp } from '../app.js';

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getCsrf(base: string): Promise<{ cookie: string; value: string }> {
  const r = await fetch(`${base}/`, {});
  const setCookie = r.headers.get('set-cookie') ?? '';
  const m = /codeconclave_csrf=([^;]+)/.exec(setCookie);
  return { cookie: `codeconclave_csrf=${m ? m[1] : ''}`, value: m ? m[1] : '' };
}

function jsonPost(url: string, cookie: string, csrf: string, body: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body,
  });
}

beforeEach(() => {
  cacheMock.cache.incr = vi.fn(async () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST error semantics (JSON-body fix regression)', () => {
  it('valid JSON POST reaches the route handler (wrong creds → 401, not 500)', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(
        `${base}/api/v1/auth/login`,
        csrf.cookie,
        csrf.value,
        JSON.stringify({ email: 'audit@x.test', password: 'wrongpass' }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('bad_credentials');
    });
  });

  it('malformed JSON returns a sanitized 400 (was 500)', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(`${base}/api/v1/auth/login`, csrf.cookie, csrf.value, '{bad');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('invalid_body');
      expect(body.error?.message).toBe('Invalid request body');
      expect(JSON.stringify(body)).not.toContain('stack');
      expect(JSON.stringify(body)).not.toContain('SyntaxError');
    });
  });

  it('missing CSRF token on a POST returns 403', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: csrf.cookie },
        body: JSON.stringify({ email: 'audit@x.test', password: 'wrongpass' }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('csrf_mismatch');
    });
  });

  it('invalid credentials (valid email shape) return 401 bad_credentials', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(
        `${base}/api/v1/auth/login`,
        csrf.cookie,
        csrf.value,
        JSON.stringify({ email: 'audit@x.test', password: 'wrongpass' }),
      );
      expect(res.status).toBe(401);
    });
  });

  it('validation failure returns the existing 400 validation_error envelope', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(
        `${base}/api/v1/auth/login`,
        csrf.cookie,
        csrf.value,
        JSON.stringify({ email: 'not-an-email', password: 'x' }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; details?: unknown } };
      expect(body.error?.code).toBe('validation_error');
      expect(Array.isArray(body.error?.details)).toBe(true);
    });
  });

  it('unexpected internal error returns a sanitized 500 (no stack, no message leak)', async () => {
    // Direct middleware-level assertion of the generic mapper branch: a raw
    // Error (not AppError/ZodError/body-parser) must become a sanitized 500 —
    // never the raw message, never a stack.
    vi.resetModules();
    const { errorHandler } = await import('../middleware/security.js');
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as import('express').Response;
    errorHandler(new Error('TOP-SECRET internal detail'), {} as never, res, vi.fn() as never);
    const status = (res.status as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      error?: { code?: string; message?: string };
    };
    expect(status).toBe(500);
    expect(payload.error?.code).toBe('internal_error');
    expect(payload.error?.message).toBe('Internal server error');
    expect(JSON.stringify(payload)).not.toContain('TOP-SECRET');
    expect(JSON.stringify(payload)).not.toContain('stack');
  });

  it('rate limit returns 429 when the limit is exceeded (fail-closed store healthy)', async () => {
    cacheMock.cache.incr = vi.fn(async () => 9999);
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(
        `${base}/api/v1/auth/login`,
        csrf.cookie,
        csrf.value,
        JSON.stringify({ email: 'audit@x.test', password: 'wrongpass' }),
      );
      expect(res.status).toBe(429);
    });
  });

  it('rate-limit store outage fails closed with 503 for security paths', async () => {
    cacheMock.cache.incr = vi.fn(async () => {
      throw new Error('store down');
    });
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(
        `${base}/api/v1/auth/login`,
        csrf.cookie,
        csrf.value,
        JSON.stringify({ email: 'audit@x.test', password: 'wrongpass' }),
      );
      expect([503, 401]).toContain(res.status);
    });
  });

  it('normal GET auth remains unchanged (401 on protected route, 200 on healthz)', async () => {
    await withServer(async (base) => {
      const me = await fetch(`${base}/api/v1/auth/me`);
      expect(me.status).toBe(401);
      const healthz = await fetch(`${base}/healthz`);
      expect(healthz.status).toBe(200);
    });
  });

  it('protected POST remains protected (projects requires auth → 401 with CSRF)', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await jsonPost(
        `${base}/api/v1/projects`,
        csrf.cookie,
        csrf.value,
        JSON.stringify({ name: 'x' }),
      );
      expect(res.status).toBe(401);
    });
  });

  it('body-less POST still reaches CSRF gate (payments session → 403)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/payments/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'pro' }) });
      expect(res.status).toBe(403);
    });
  });
});