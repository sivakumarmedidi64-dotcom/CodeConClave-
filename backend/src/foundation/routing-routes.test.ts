/**
 * CodeConClave — Model Routing 2026: HTTP route mounting.
 *
 * Runs against the assembled app (`createApp`) like a real client. The DB and
 * cache are mocked; we assert the auth boundary here — the routing routes are
 * mounted behind `requireAuth` and every unprotected request must fail closed
 * with 401 before any handler runs. Full decision/preference semantics are
 * covered by the engine tests (model-routing-51.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing routes are mounted behind requireAuth (fail closed)', () => {
  it('GET /api/v1/ai/routing without a session returns 401 unauthorized', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/ai/routing`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unauthorized');
    });
  });

  it('GET /api/v1/ai/routing/preferences without a session returns 401', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/ai/routing/preferences`);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('unauthorized');
    });
  });

  it('PUT /api/v1/ai/routing/preferences without a session fails closed (403 CSRF write-edge)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/ai/routing/preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routingPreference: 'FAST' }),
      });
      expect(res.status).toBe(403);
    });
  });
});