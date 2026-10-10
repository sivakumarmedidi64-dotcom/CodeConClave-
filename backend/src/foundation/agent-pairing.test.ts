/**
 * CodeConClave — Local Agent mount: pairing must be reachable, status must
 * stay fail-closed.
 *
 * POST /api/v1/agent/pair is called by the CLI, which has no browser session,
 * so it must not sit behind the workspace entitlement gate (that gate rejects
 * any request without `req.ctx.user`, which made pairing permanently 401).
 * The route authenticates with the 6-digit pairing code + attempt cap; the
 * browser-facing GET /status still requires a session, so mounting the router
 * without `paid` does not open an unauthenticated surface.
 *
 * Runs against the assembled app (`createApp`) with DB and cache mocked.
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

async function postPair(base: string, body: unknown): Promise<{ status: number; code: string }> {
  const res = await fetch(`${base}/api/v1/agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return { status: res.status, code: json?.error?.code ?? '' };
}

describe('Local Agent mount — pairing reachable, status fail-closed', () => {
  it('POST /pair is not blocked by the entitlement/session gate', async () => {
    await withServer(async (base) => {
      const missingCode = await postPair(base, {});
      expect(missingCode.status, 'no session must not yield 401').toBe(400);
      expect(missingCode.code).toBe('pairing_code_invalid');

      const badDevice = await postPair(base, { code: '123456', deviceId: 'nope' });
      expect(badDevice.status).toBe(400);
      expect(badDevice.code).toBe('device_id_invalid');
    });
  });

  it('POST /pair reaches the handler and consults the device registry', async () => {
    await withServer(async (base) => {
      const res = await postPair(base, {
        code: '123456',
        deviceId: 'dev_abcdefghijklmnopqrst',
      });
      expect(res.status, 'unknown device must fail in the handler, not the gate').toBe(400);
      expect(res.code).toBe('device_not_found');
    });
  });

  it('GET /status still fails closed without a session', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/agent/status`);
      expect(res.status).toBe(401);
    });
  });
});
