/**
 * CodeConClave — agent management routes: HTTP mounting + fail-closed auth.
 *
 * Runs against the assembled app (`createApp`) like a real client with the DB
 * and cache mocked. We assert the auth boundary and that the entitlement usage
 * route (`GET /api/v1/agents/limits`) is actually mounted: without a session
 * every request must fail closed with 401 before any handler runs. Deeper
 * semantics are covered by agents-25 service tests.
 */
import { describe, it, expect, vi } from 'vitest';
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

describe('agent routes are mounted behind requireAuth (fail closed)', () => {
  it('GET /api/v1/agents/limits is mounted and requires a session', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/agents/limits`);
      expect(res.status).toBe(401);
    });
  });

  it('collection routes (roles, agents) also fail closed without a session', async () => {
    await withServer(async (base) => {
      const roles = await fetch(`${base}/api/v1/agents/roles`);
      expect(roles.status).toBe(401);
      const agents = await fetch(`${base}/api/v1/agents`);
      expect(agents.status).toBe(401);
    });
  });
});