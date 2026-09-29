/**
 * CodeConClave — comprehensive tests for the Gmail claim rail.
 *
 * Tests cover:
 *   - HMAC signature verification (pure: valid, invalid, tampered, wrong secret,
 *     empty, cross-tenant guard, timing-safe)
 *   - Timestamp validation (pure: valid, expired, future, non-numeric)
 *   - Route-level integration (disabled rail → 404, NOT 401 auth-shadow)
 *
 * The signature + timestamp helpers are pure functions (secret/tolerance passed
 * in), so their correctness is verified independently of the process env
 * singleton. The route-level tests use the assembled app with the default env
 * (rail disabled), asserting deterministic 404 (rail-not-enabled) rather than
 * auth rejection — the same pattern as payments-webhook-route.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

const db = vi.hoisted(() => {
  const query = async () => ({ rows: [], rowCount: 0 });
  return {
    pool: { query },
    queryMany: async () => [],
    queryOne: async () => null,
    ping: async () => true,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../../shared/db.js', () => db);

const cacheMock = vi.hoisted(() => ({
  cache: {
    kind: 'redis',
    health: async () => true,
    incr: async () => 1,
    get: async () => null,
    set: async () => {},
  },
}));
vi.mock('../../shared/cache.js', () => cacheMock);

import { verifyGmailClaimSignature, isTimestampValid } from './gmail-claim.js';

const SHARED_SECRET = 'test-secret-key-for-hmac-signing-32bytes!';
const ATTACKER_SECRET = 'attacker-controlled-secret-key-1234567890!';

function signPayload(payload: Record<string, unknown>, timestamp: number, secret = SHARED_SECRET): string {
  const message = `${timestamp}:${JSON.stringify(payload)}`;
  return createHmac('sha256', secret).update(message).digest('hex');
}

const BASE_PAYLOAD = {
  paymentId: 'pay_123',
  amount: 999,
  plan: 'pro',
  payerEmail: 'a@b.c',
  paidAt: '2026-08-31T11:00:00Z',
  reference: 'CCPRO-123456',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyGmailClaimSignature (pure)', () => {
  it('returns true for a valid HMAC-SHA256 signature', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signPayload(BASE_PAYLOAD, timestamp);
    expect(verifyGmailClaimSignature(BASE_PAYLOAD, timestamp, sig, SHARED_SECRET)).toBe(true);
  });

  it('returns false for a tampered payload', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signPayload(BASE_PAYLOAD, timestamp);
    const tampered = { ...BASE_PAYLOAD, amount: 4999 };
    expect(verifyGmailClaimSignature(tampered, timestamp, sig, SHARED_SECRET)).toBe(false);
  });

  it('returns false for a wrong secret (cross-tenant guard)', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signPayload(BASE_PAYLOAD, timestamp, ATTACKER_SECRET);
    expect(verifyGmailClaimSignature(BASE_PAYLOAD, timestamp, sig, SHARED_SECRET)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verifyGmailClaimSignature(BASE_PAYLOAD, timestamp, '', SHARED_SECRET)).toBe(false);
  });

  it('returns false when the secret is not provided', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signPayload(BASE_PAYLOAD, timestamp);
    expect(verifyGmailClaimSignature(BASE_PAYLOAD, timestamp, sig, undefined)).toBe(false);
  });

  it('returns false for a truncated (non-matching-length) signature', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signPayload(BASE_PAYLOAD, timestamp);
    expect(verifyGmailClaimSignature(BASE_PAYLOAD, timestamp, sig.slice(0, 16), SHARED_SECRET)).toBe(false);
  });

  it('returns false for a valid signature over a DIFFERENT timestamp', () => {
    const ts1 = Math.floor(Date.now() / 1000);
    const ts2 = ts1 + 7; // different timestamp, same payload
    const sig = signPayload(BASE_PAYLOAD, ts1);
    expect(verifyGmailClaimSignature(BASE_PAYLOAD, ts2, sig, SHARED_SECRET)).toBe(false);
  });
});

describe('isTimestampValid (pure)', () => {
  const nowMs = Date.parse('2026-08-31T12:00:00Z');
  const nowSec = Math.floor(nowMs / 1000);
  const tol = 300; // 5 minutes

  it('accepts a current timestamp', () => {
    expect(isTimestampValid(nowSec, tol, nowMs)).toBe(true);
  });

  it('accepts a timestamp within tolerance', () => {
    expect(isTimestampValid(nowSec - 299, tol, nowMs)).toBe(true);
    expect(isTimestampValid(nowSec + 299, tol, nowMs)).toBe(true);
  });

  it('rejects a timestamp beyond the window (replay)', () => {
    expect(isTimestampValid(nowSec - 301, tol, nowMs)).toBe(false);
  });

  it('rejects a future timestamp beyond the window', () => {
    expect(isTimestampValid(nowSec + 301, tol, nowMs)).toBe(false);
  });

  it('rejects zero and negative timestamps', () => {
    expect(isTimestampValid(0, tol, nowMs)).toBe(false);
    expect(isTimestampValid(-5, tol, nowMs)).toBe(false);
  });

  it('rejects non-finite timestamps', () => {
    expect(isTimestampValid(Number.NaN, tol, nowMs)).toBe(false);
    expect(isTimestampValid(Number.POSITIVE_INFINITY, tol, nowMs)).toBe(false);
  });
});

describe('Gmail claim route-level integration (default env, rail disabled)', () => {
  // Single shared server for all three route tests: one full app boot instead
  // of three. This is also a stronger integration check — one live server
  // instance serves the 404(disabled)/401(no bypass) assertions back-to-back.
  let base: string;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    const { createApp } = await import('../../app.js');
    server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    // This is the ONE assembled-app boot for the whole file (it cold-transforms
    // the full app graph). A quantified deadline for a single heavy hook — not
    // per-assertion padding — keeps full-suite contention from tripping
    // vitest's default 10s hook cap. Under a full parallel suite the app graph
    // cold-transforms slower than 30s took it over the edge, so the deadline is
    // 120s (boot cost is per-worker-slot and bounded; familiarity-safe).
  }, 120000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = undefined as unknown as ReturnType<typeof createServer>;
    }
  });

  it('POST /gmail-claim/request returns 404 (rail disabled) and is NOT auth-shadowed to 401', async () => {
    const res = await fetch(`${base}/api/v1/payments/gmail-claim/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: {}, timestamp: 1, signature: 'x' }),
    });
    // Rail disabled => 404 "rail not enabled". If the auth-gated payments
    // router shadowed this path, it would be a 401 instead.
    expect(res.status).toBe(404);
  });

  it('POST /gmail-claim/activate returns 404 (rail disabled) and is NOT auth-shadowed to 401', async () => {
    const res = await fetch(`${base}/api/v1/payments/gmail-claim/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'abc', id: 'pcl_123' }),
    });
    expect(res.status).toBe(404);
  });

  it('normal /api/v1/payments/* routes still require authentication (no bypass)', async () => {
    const res = await fetch(`${base}/api/v1/payments/entitlements`);
    expect(res.status).toBe(401);
  });
});
