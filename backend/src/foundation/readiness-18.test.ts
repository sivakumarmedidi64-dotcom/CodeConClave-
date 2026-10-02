/**
 * CodeConClave — PHASE 18 liveness/readiness endpoint tests.
 * /healthz is a pure liveness probe; /ready returns 200 while core
 * dependencies (database) are reachable and 503 when they FAIL, always with
 * an honest body; /health keeps its backward-compatible envelope. The DB is
 * mocked; nothing is faked — DEGRADED/NOT_CONFIGURED providers stay visible
 * in the response bodies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

const db = vi.hoisted(() => {
  const state: { rows: unknown[]; pingOk: boolean } = { rows: [], pingOk: true };
  const query = async () => ({ rows: state.rows, rowCount: 0 });
  return {
    state,
    pool: { query },
    queryMany: async () => state.rows,
    ping: async () => state.pingOk,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const cacheMock = vi.hoisted(() => ({
  cache: {
    kind: 'redis',
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

beforeEach(() => {
  db.state.rows = [];
  db.state.pingOk = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PHASE 18 — liveness & readiness endpoints', () => {
  it('GET /healthz always answers with a pure liveness probe', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });
  });

  it('GET /ready returns 200 when the database is reachable (unconfigured providers stay visible)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status: string; checks: { id: string; status: string }[] };
      expect(body.ok).toBe(true);
      expect(body.checks.find((c) => c.id === 'database')?.status).toBe('HEALTHY');
      // Nothing is hidden: unconfigured providers are reported, never labeled healthy.
      expect(body.checks.some((c) => c.status === 'NOT_CONFIGURED')).toBe(true);
    });
  });

  it('GET /ready returns 503 when the database is unreachable', async () => {
    db.state.pingOk = false;
    await withServer(async (base) => {
      const res = await fetch(`${base}/ready`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; status: string; checks: { id: string; status: string }[] };
      expect(body.ok).toBe(false);
      expect(body.status).toBe('FAILED');
      expect(body.checks.find((c) => c.id === 'database')?.status).toBe('FAILED');
    });
  });

  it('GET /health keeps the backward-compatible envelope with honest state', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status: string; checks: unknown[]; provider: string };
      expect(body.ok).toBe(false); // unconfigured providers → DEGRADED, never a false healthy
      expect(body.status).toBe('DEGRADED');
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.provider).toBe('memory');
    });
  });
});