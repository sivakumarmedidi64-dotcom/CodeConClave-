/**
 * CodeConClave — B1 cowork safety review loop: HTTP route mounting.
 *
 * Runs against the assembled app (`createApp`) like a real client. The DB and
 * cache are mocked (we only assert the auth boundary here — the review routes
 * are mounted behind `requireAuth` and every unprotected request must fail
 * closed with 401 before any handler runs). Deeper authorization/ownership
 * semantics are covered by the service tests.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

beforeEach(() => {
  cacheMock.cache.incr = vi.fn(async () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reviews routes are mounted behind requireAuth (fail closed)', () => {
  it('GET /api/v1/reviews without a session returns 401 unauthorized', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/reviews?projectId=prj-1`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unauthorized');
    });
  });

  it('POST /api/v1/reviews without a session returns 401 (write edge mounted)', async () => {
    await withServer(async (base) => {
      const csrf = await getCsrf(base);
      const res = await fetch(`${base}/api/v1/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: csrf.cookie, 'X-CSRF-Token': csrf.value },
        body: JSON.stringify({ projectId: 'prj-1', taskId: 'tsk-1', files: [] }),
      });
      expect(res.status).toBe(401);
    });
  });

  it('GET /api/v1/reviews/:id/status without a session returns 401', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/reviews/rvw_0000000000000000/status`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unauthorized');
    });
  });
});