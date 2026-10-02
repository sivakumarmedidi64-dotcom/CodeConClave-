/**
 * CodeConClave — regression test for the Razorpay webhook route-shadowing fix.
 *
 * Before the fix, `paymentRoutes()` (whose first middleware is `requireAuth`)
 * was mounted at `/api/v1/payments` BEFORE `paymentWebhookRoutes()` at
 * `/api/v1/payments/webhook`. Because Express matches mounts in registration
 * order by path prefix, a Razorpay webhook (which has no session cookie) was
 * intercepted by the auth-gated router and rejected with 401 before it ever
 * reached the webhook handler.
 *
 * After the fix the webhook router is mounted first, so a webhook request
 * reaches the dedicated handler (which then rejects based on signature). This
 * test verifies the ordering at the assembled-app level: with the webhook
 * rail disabled (default env), an unsigned webhook POST must return 404
 * ("Webhook not configured") — NOT the old auth-shadow 401 — while normal
 * `/api/v1/payments/*` routes must still require authentication (401).
 *
 * The webhook signature / amount / plan / idempotency / replay families are
 * covered at the handler level in payments-26h.test.ts; this file only pins
 * the route-registration ordering defect.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const RAZORPAY_WEBHOOK_BODY = JSON.stringify({
  event: 'payment.captured',
  id: 'evt_router_regression',
  payload: {
    payment: { entity: { id: 'pay_router_regression', amount: 99900, email: 'a@b.c', created_at: 1700000000 } },
  },
});

describe('Razorpay webhook route ordering (route-shadowing regression)', () => {
  it('webhook path reaches the webhook router without a session cookie (NOT auth-shadowed)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: RAZORPAY_WEBHOOK_BODY,
      });
      // With the rail disabled the dedicated handler answers 404 "Webhook not
      // configured". If the auth-gated payments router were still shadowing
      // this path, the response would be the 401 auth rejection instead.
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('not_found');
    });
  });

  it('normal /api/v1/payments/* routes still require authentication', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/payments/entitlements`);
      expect(res.status).toBe(401);
    });
  });

  it('normal /api/v1/payments/* state-changing route still requires authentication', async () => {
    await withServer(async (base) => {
      // State-changing payment routes are CSRF-gated (403) before auth — the
      // webhook is exempt from CSRF only because it is signature-authenticated.
      // Either way a client with no session/CSRF token is rejected (never a
      // 200/success), confirming the normal payments surface is not open.
      const res = await fetch(`${base}/api/v1/payments/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'pro' }),
      });
      expect(res.status).toBe(403);
    });
  });
});
