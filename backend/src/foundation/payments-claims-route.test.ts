/**
 * CodeConClave — MANUAL PAYMENT CLAIMS ROUTE-LEVEL INTEGRATION TEST.
 *
 * Exercises the ACTUAL HTTP endpoints of the manual claims rail (the founder's
 * UNLOCK_MODE=MANUAL workflow):
 *   POST /api/v1/payments/claims             (user submits a Razorpay Payment ID)
 *   GET  /api/v1/payments/claims             (user lists own claims)
 *   GET  /api/v1/payments/claims/:id         (user reads own claim)
 *   GET  /api/v1/admin/payments/claims       (founder inbox, admin-only)
 *   POST /api/v1/admin/payments/claims/:id/approve
 *   POST /api/v1/admin/payments/claims/:id/reject
 *
 * Strategy (same discipline as the autopilot route test):
 *   ROUTE TESTED — INFRA MOCKED (DB, cache, audit, notifications, outbox,
 *   logger). Everything else — Express app, auth middleware (real session
 *   JOIN query), CSRF double-submit, RBAC gate, claims service, the REAL
 *   activateEntitlement authority and its entitlement/users SQL — runs as in
 *   production. Session cookies are seeded against the token_hash the auth
 *   middleware actually computes.
 *
 * Covers the ZERO-MONEY audit sections 2 (claim submission), 3 (admin
 * approval + exactly-once), 4 (transaction rollback), 5 (payment-id attack
 * matrix), 13 (manual rail converges on the same activateEntitlement authority
 * as autopilot), 22 (admin review fallback / PENDING), 24 (cross-user authz).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

const mock = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const sessions = new Map<string, Row>();
  const users = new Map<string, Row>();
  const intents = new Map<string, Row>();
  const claims = new Map<string, Row>();
  const entitlements = new Map<string, Row>();
  const queries: string[] = [];
  let failEntitlementInsert = false;

  const reset = () => {
    sessions.clear();
    users.clear();
    intents.clear();
    claims.clear();
    entitlements.clear();
    queries.splice(0);
    failEntitlementInsert = false;
  };

  const handler = (text: string, params: unknown[] = []): Row[] => {
    const t = text.replace(/\s+/g, ' ').trim();
    queries.push(t);

    // ---- auth: session JOIN users (loaded by the REAL optionalAuth middleware)
    if (t.includes('FROM sessions s JOIN users u')) {
      const sess = sessions.get(String(params[0]));
      if (!sess) return [];
      const user = users.get(String(sess.user_id));
      if (!user) return [];
      return [{
        id: sess.id, state: sess.state, expires_at: sess.expires_at,
        user_id: user.id, email: user.email, email_verified: user.email_verified ?? true,
        display_name: null, avatar_url: null, google_sub: null, role: null,
        primary_use_case: null, mfa_enabled: false,
        rbac_role: user.rbac_role, plan_id: user.plan_id, entitlement_state: user.entitlement_state,
      }];
    }
    if (t.startsWith('UPDATE sessions SET last_seen_at')) return [];

    // ---- SELECT email FROM users WHERE id
    if (t.startsWith('SELECT email FROM users WHERE id')) {
      const u = users.get(String(params[0]));
      return u ? [{ email: u.email }] : [];
    }

    // ---- getIntent / approve revalidation
    if (t.startsWith('SELECT * FROM payment_intents WHERE id = $1 AND owner_id')) {
      const it = intents.get(String(params[0]));
      if (!it) return [];
      if (it.owner_id !== params[1]) return [];
      return [{ ...it }];
    }
    if (t.startsWith('SELECT reference FROM payment_intents WHERE id')) {
      const it = intents.get(String(params[0]));
      return it ? [{ reference: it.reference }] : [];
    }

    // ---- claim INSERT (submitPaymentClaim)
    if (t.startsWith('INSERT INTO payment_claim_reviews')) {
      const id = String(params[0]);
      const paymentId = String(params[7]);
      if ([...claims.values()].some((cl) => cl.razorpay_payment_id === paymentId)) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'payment_claim_reviews_razorpay_payment_id_key' });
      }
      const pending = [...claims.values()].filter((cl) => cl.status === 'PENDING');
      if (pending.some((cl) => cl.user_id === params[1])) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_payment_claim_reviews_user_pending' });
      }
      if (pending.some((cl) => cl.intent_id === params[3])) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_payment_claim_reviews_intent_pending' });
      }
      claims.set(id, {
        id, user_id: params[1], email: params[2], intent_id: params[3],
        plan_id: params[4], purchase_type: params[5], amount_inr: params[6],
        currency: 'INR', razorpay_payment_id: paymentId, status: 'PENDING', source: 'manual',
        rejection_reason: null, decided_by: null, decided_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      return [];
    }

    // ---- claim SELECT single
    if (t.startsWith('SELECT * FROM payment_claim_reviews WHERE id = $1 AND user_id')) {
      const cl = claims.get(String(params[0]));
      if (!cl || cl.user_id !== params[1]) return [];
      return [{ ...cl }];
    }
    if (t.startsWith('SELECT * FROM payment_claim_reviews WHERE id = $1 FOR UPDATE')) {
      const cl = claims.get(String(params[0]));
      return cl ? [{ ...cl }] : [];
    }
    if (t.startsWith('SELECT * FROM payment_claim_reviews WHERE id = $1')) {
      const cl = claims.get(String(params[0]));
      return cl ? [{ ...cl }] : [];
    }

    // ---- claim SELECT list (user)
    if (t.startsWith('SELECT * FROM payment_claim_reviews WHERE user_id')) {
      return [...claims.values()].filter((cl) => cl.user_id === params[0]).map((cl) => ({ ...cl }));
    }

    // ---- inbox + count
    if (t.includes('FROM payment_claim_reviews cr') || (t.startsWith('SELECT count(*)') && t.includes('payment_claim_reviews'))) {
      if (t.startsWith('SELECT count(*)')) {
        return [{ n: claims.size }];
      }
      const status = params[0] as string | undefined;
      const all = [...claims.values()]
        .filter((cl) => (status ? cl.status === status : true))
        .sort((a, b) => (a.status === 'PENDING' ? -1 : 1) || String(a.created_at).localeCompare(String(b.created_at)));
      return all.map((cl) => ({ ...cl, user_email: users.get(String(cl.user_id))?.email ?? cl.email }));
    }

    // ---- entitlements INSERT (REAL activateEntitlement authority)
    if (t.startsWith('INSERT INTO entitlements')) {
      if (failEntitlementInsert) throw new Error('simulated entitlement insert failure');
      const key = `${params[1]}:${params[2]}`;
      const existing = entitlements.get(key);
      if (existing) {
        Object.assign(existing, { state: 'PRO_VERIFIED', payment_session_id: params[3], reason: 'verified' });
      } else {
        entitlements.set(key, { id: params[0], user_id: params[1], plan_id: params[2], state: 'PRO_VERIFIED', payment_session_id: params[3], reason: 'verified' });
      }
      return [];
    }

    // ---- UPDATE users SET plan_id (base plans pro/team mirror)
    if (t.startsWith('UPDATE users SET plan_id')) {
      const u = users.get(String(params[0]));
      if (u) u.plan_id = params[1];
      return [];
    }

    // ---- UPDATE payment_intents SET status = 'ACTIVE' (approve activation)
    if (t.startsWith('UPDATE payment_intents SET status') && t.includes("'ACTIVE'")) {
      const it = intents.get(String(params[0]));
      if (it && ['PENDING', 'REVIEW'].includes(String(it.status))) {
        it.status = 'ACTIVE';
        it.activated_at = new Date();
      }
      return [];
    }

    // ---- claim UPDATE (exactly-once conditional flip)
    if (t.startsWith('UPDATE payment_claim_reviews SET status')) {
      const cl = claims.get(String(params[0]));
      if (!cl || cl.status !== 'PENDING') return []; // rowCount 0 => claim_race
      const next = t.includes("'APPROVED'") ? 'APPROVED' : 'REJECTED';
      cl.status = next;
      cl.decided_by = params[1];
      cl.decided_at = new Date();
      cl.updated_at = new Date();
      if (next === 'REJECTED') cl.rejection_reason = params[2];
      return [{ ...cl }];
    }

    return [];
  };

  return {
    sessions, users, intents, claims, entitlements, queries, reset,
    setFailEntitlementInsert: (v: boolean) => { failEntitlementInsert = v; },
    pool: { query: async (q: string, p: unknown[] = []) => { const rows = handler(q, p); return { rows, rowCount: rows.length }; } },
    queryOne: async (q: string, p: unknown[] = []) => handler(q, p)[0] ?? null,
    queryMany: async (q: string, p: unknown[] = []) => handler(q, p),
    withTenant: async (_u: string | null, fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: mock.pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
    withSystem: async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: mock.pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
  };
});

vi.mock('../shared/db.js', () => mock);
vi.mock('../shared/cache.js', () => ({
  cache: {
    kind: 'memory', health: async () => true, incr: async () => 1, get: async () => null, set: async () => {},
  },
}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox: vi.fn(async () => {}) }));
vi.mock('../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { sha256Hex } from '../shared/crypto.js';

const PLAYER = 'usr-owner';
const ADMIN = 'usr-admin';
const CSRF = 'route-csrf-token';

function setupEnv(): void {
  env.UNLOCK_MODE = 'MANUAL';
  env.RAZORPAY_WEBHOOK_ENABLED = 'false';
  env.RAZORPAY_WEBHOOK_SECRET = 'whsec_claims_test';
  env.RAZORPAY_PRO_PAYMENT_LINK_ID = 'plink_pro';
  env.RAZORPAY_TEAM_PAYMENT_LINK_ID = 'plink_team';
  env.RAZORPAY_API_PAYMENT_LINK_ID = 'plink_api';
  env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
}

function seedSession(token: string, userId: string, rbacRole: string): void {
  mock.sessions.set(sha256Hex(token), {
    id: `sess-${userId}`, state: 'ACTIVE', expires_at: new Date(Date.now() + 3_600_000), user_id: userId,
  });
  mock.users.set(userId, {
    id: userId, email: `${userId}@codeconclave.test`, email_verified: true,
    rbac_role: rbacRole, plan_id: 'free', entitlement_state: 'FREE',
  });
}

function seedIntent(userId: string, planId: 'pro' | 'team' | 'api', status = 'PENDING'): string {
  const id = `pin_${planId}_${Math.random().toString(36).slice(2, 8)}`;
  const amount = planId === 'pro' ? 999 : planId === 'team' ? 4999 : 9999;
  const purchaseType = planId === 'pro' ? 'solo' : planId === 'team' ? 'team' : 'api_access';
  mock.intents.set(id, {
    id, owner_id: userId, plan_id: planId, amount_inr: amount, currency: 'INR',
    reference: `CC${planId.toUpperCase()}-TKN`, payment_link: `https://rzp.io/rzp/${planId}`,
    mode: 'PAYMENT_LINK', status, confidence: 0, decision: null, fraud_flags: null,
    expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
    purchase_type: purchaseType,
  });
  return id;
}

function seedClaim(claimId: string, userId: string, intentId: string, planId: string, purchaseType: string, amountInr: number, paymentId: string): void {
  mock.claims.set(claimId, {
    id: claimId, user_id: userId, email: `${userId}@codeconclave.test`, intent_id: intentId,
    plan_id: planId, purchase_type: purchaseType, amount_inr: amountInr, currency: 'INR',
    razorpay_payment_id: paymentId, status: 'PENDING', source: 'manual',
    rejection_reason: null, decided_by: null, decided_at: null,
    created_at: new Date(), updated_at: new Date(),
  });
}

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

async function postJson(base: string, path: string, body: unknown, token?: string, adminCsrf = false): Promise<{ status: number; data: { error?: { code?: string } } & Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `codeconclave_csrf=${CSRF}${token ? `; cc_session=${token}` : ''}`,
      'X-CSRF-Token': CSRF,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as never };
}

async function getJson(base: string, path: string, token?: string): Promise<{ status: number; data: { error?: { code?: string } } & Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { Cookie: `cc_session=${token}` } : {},
  });
  return { status: res.status, data: (await res.json()) as never };
}

beforeEach(() => {
  mock.reset();
  setupEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =========================================================================
// 2. CLAIM SUBMISSION SECURITY
// =========================================================================
describe('MANUAL CLAIM SUBMISSION (POST /api/v1/payments/claims)', () => {
  it('2A — a valid pay_ id claim against the authenticated intent is accepted (201), server-derived product', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const intentId = seedIntent(PLAYER, 'pro');

    await withServer(async (base) => {
      const { status, data } = await postJson(base, '/api/v1/payments/claims', { intentId, paymentId: 'pay_claim_2A_0001' }, 'tok-a');
      expect(status).toBe(201);
      const claim = data.data?.claim as Record<string, unknown>;
      expect(claim.planId).toBe('pro');
      expect(claim.purchaseType).toBe('solo');
      expect(claim.amountInr).toBe(999);
      expect(claim.currency).toBe('INR');
      expect(claim.status).toBe('PENDING');
      expect(claim.source).toBe('manual');
      expect(claim.reference).toBe('CCPRO-TKN');
      expect(claim.razorpayPaymentId).toBe('pay_claim_2A_0001');
    });
  });

  it('2B — the same payment id under ANOTHER user is rejected (409, global unique)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    seedSession('tok-b', 'usr-b', 'member');
    const iA = seedIntent(PLAYER, 'pro');
    const iB = seedIntent('usr-b', 'pro');

    await withServer(async (base) => {
      const first = await postJson(base, '/api/v1/payments/claims', { intentId: iA, paymentId: 'pay_claim_2B_0001' }, 'tok-a');
      expect(first.status).toBe(201);
      const second = await postJson(base, '/api/v1/payments/claims', { intentId: iB, paymentId: 'pay_claim_2B_0001' }, 'tok-b');
      expect(second.status).toBe(409);
      expect(second.data.error?.code).toBe('payment_id_already_claimed');
    });
  });

  it('2C — a second PENDING claim by the same user is rejected (claim_pending_exists)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const i1 = seedIntent(PLAYER, 'pro');
    const i2 = seedIntent(PLAYER, 'team');

    await withServer(async (base) => {
      await postJson(base, '/api/v1/payments/claims', { intentId: i1, paymentId: 'pay_claim_2C_0001' }, 'tok-a');
      const second = await postJson(base, '/api/v1/payments/claims', { intentId: i2, paymentId: 'pay_claim_2C_0002' }, 'tok-a');
      expect(second.status).toBe(409);
      expect(second.data.error?.code).toBe('claim_pending_exists');
    });
  });

  it('2D — malformed / empty / prose payment ids are rejected (400 invalid_payment_id)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const intentId = seedIntent(PLAYER, 'pro');

    await withServer(async (base) => {
      for (const bad of ['', 'pay_', 'https://rzp.io/link/pay_isthisapayment', 'please check my bank statement', 'pay_!!notvalid!!']) {
        const r = await postJson(base, '/api/v1/payments/claims', { intentId, paymentId: bad }, 'tok-a');
        expect(r.status).toBe(400);
        expect(r.data.error?.code).toBe('invalid_payment_id');
      }
    });
  });

  it('2E — client-supplied plan/amount/purchase_type/user_id are IGNORED (server re-derives everything)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const intentId = seedIntent(PLAYER, 'pro');

    await withServer(async (base) => {
      const { status, data } = await postJson(base, '/api/v1/payments/claims', {
        intentId,
        paymentId: 'pay_claim_2E_0001',
        plan: 'api',
        amount: 1,
        purchase_type: 'api_access',
        user_id: 'usr-evil',
      }, 'tok-a');
      expect(status).toBe(201);
      const claim = data.data?.claim as Record<string, unknown>;
      expect(claim.planId).toBe('pro');
      expect(claim.purchaseType).toBe('solo');
      expect(claim.amountInr).toBe(999);
      expect(data.data?.claim.id).toBeDefined();
    });
  });

  it('2F — claim against a non-owned intent is rejected (404 payment intent not found)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const intentId = seedIntent('usr-other', 'pro');

    await withServer(async (base) => {
      const r = await postJson(base, '/api/v1/payments/claims', { intentId, paymentId: 'pay_claim_2F_0001' }, 'tok-a');
      expect(r.status).toBe(404);
    });
  });

  it('2G — an already-ACTIVE intent cannot be claimed (plan_already_active); EXPIRED cannot either', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const active = seedIntent(PLAYER, 'pro', 'ACTIVE');
    const expired = seedIntent(PLAYER, 'pro', 'EXPIRED');

    await withServer(async (base) => {
      const r1 = await postJson(base, '/api/v1/payments/claims', { intentId: active, paymentId: 'pay_claim_2G_0001' }, 'tok-a');
      expect(r1.status).toBe(409);
      expect(r1.data.error?.code).toBe('plan_already_active');
      const r2 = await postJson(base, '/api/v1/payments/claims', { intentId: expired, paymentId: 'pay_claim_2G_0002' }, 'tok-a');
      expect(r2.status).toBe(409);
      expect(r2.data.error?.code).toBe('intent_not_claimable');
    });
  });

  it('2H — unauthenticated submission is rejected (401) before any handler runs', async () => {
    await withServer(async (base) => {
      const r = await postJson(base, '/api/v1/payments/claims', { intentId: 'pin_x', paymentId: 'pay_claim_2H_0001' });
      expect(r.status).toBe(401);
    });
  });
});

// =========================================================================
// 3. ADMIN APPROVAL (exactly-once, RBAC)
// =========================================================================
describe('ADMIN CLAIM APPROVAL (POST /api/v1/admin/payments/claims/:id/approve)', () => {
  function seedPending(): { claimId: string; userId: string; intentId: string } {
    seedSession('tok-player', PLAYER, 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_3_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_3A_0001');
    return { claimId, userId: PLAYER, intentId };
  }

  it('3A — a non-admin (member) session is forbidden (403) from approving', async () => {
    seedSession('tok-player', PLAYER, 'member');
    seedSession('tok-member', 'usr-member', 'member');
    const { claimId } = seedPending();

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-member');
      expect(r.status).toBe(403);
    });
  });

  it('3B — an unauthenticated approve is rejected (401)', async () => {
    const { claimId } = seedPending();
    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {});
      expect(r.status).toBe(401);
    });
  });

  it('3C — owner approval grants EXACTLY ONE PRO_VERIFIED entitlement, mirrors users.plan_id, activates the intent', async () => {
    const { claimId, intentId } = seedPending();
    const intentStatusBefore = mock.intents.get(intentId)!.status;
    expect(intentStatusBefore).toBe('PENDING');

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(r.status).toBe(200);
      expect(r.data.claim).toBeDefined();
    });

    const entitlements = [...mock.entitlements.values()];
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]).toMatchObject({ user_id: PLAYER, plan_id: 'pro', state: 'PRO_VERIFIED' });
    expect(mock.users.get(PLAYER)!.plan_id).toBe('pro');
    expect(mock.intents.get(intentId)!.status).toBe('ACTIVE');
  });

  it('3D — a double-click (second approve) is rejected (409 claim_not_pending) and still ONE entitlement', async () => {
    const { claimId } = seedPending();

    await withServer(async (base) => {
      const first = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(first.status).toBe(200);
      const second = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(second.status).toBe(409);
      expect(['claim_not_pending', 'claim_race']).toContain(second.data.error?.code);
    });

    expect(mock.entitlements.size).toBe(1);
  });

  it('3E — two concurrent owners: exactly ONE approval wins, ONE entitlement, claim ends APPROVED', async () => {
    seedSession('tok-admin', ADMIN, 'owner');
    seedSession('tok-owner2', 'usr-owner2', 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_3E_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_3E_0001');

    await withServer(async (base) => {
      const [a, b] = await Promise.all([
        postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin'),
        postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-owner2'),
      ]);
      const ok = [a, b].filter((r) => r.status === 200);
      const conflict = [a, b].filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
      expect(['claim_not_pending', 'claim_race']).toContain(conflict[0]!.data.error?.code);
    });

    expect(mock.entitlements.size).toBe(1);
    expect(mock.claims.get(claimId)!.status).toBe('APPROVED');
  });

  it('3F — approving a claim whose product does not match its intent is rejected (claim_plan_mismatch)', async () => {
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_3F_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'team', 'team', 4999, 'pay_claim_3F_0001');

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(r.status).toBe(409);
      expect(r.data.error?.code).toBe('claim_plan_mismatch');
    });
    expect(mock.entitlements.size).toBe(0);
    expect(mock.claims.get(claimId)!.status).toBe('PENDING');
  });

  it('3G — approving a claim with the wrong amount is rejected (claim_amount_mismatch)', async () => {
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_3G_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 1, 'pay_claim_3G_0001');

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(r.status).toBe(409);
      expect(r.data.error?.code).toBe('claim_amount_mismatch');
    });
    expect(mock.entitlements.size).toBe(0);
  });
});

// =========================================================================
// 4. TRANSACTION ROLLBACK
// =========================================================================
describe('ADMIN APPROVAL — transactional rollback', () => {
  it('4A — entitlement-write failure rolls everything back: claim stays PENDING, no partial activation', async () => {
    seedSession('tok-player', PLAYER, 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_4_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_4_0001');
    mock.setFailEntitlementInsert(true);

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect([500, 503]).toContain(r.status);
    });

    expect(mock.entitlements.size).toBe(0);
    expect(mock.claims.get(claimId)!.status).toBe('PENDING');
    expect(mock.intents.get(intentId)!.status).toBe('PENDING');
    expect(mock.users.get(PLAYER)!.plan_id).toBe('free');
  });
});

// =========================================================================
// 5. PAYMENT-ID ATTACK MATRIX
// =========================================================================
describe('PAYMENT-ID ATTACK MATRIX (replay / reuse / fraud)', () => {
  it('5A — replayed payment id after APPROVAL is still rejected (claim row keeps the unique id)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const iA = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_5A_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, iA, 'pro', 'solo', 999, 'pay_claim_5A_0001');

    await withServer(async (base) => {
      const approve = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(approve.status).toBe(200);
      const replay = await postJson(base, '/api/v1/payments/claims', { intentId: iA, paymentId: 'pay_claim_5A_0001' }, 'tok-a');
      expect(replay.status).toBe(409);
      // Either gate wins — the ACTIVE intent blocks before payment-id uniqueness,
      // and both are fail-closed. Both prove the replay never activates again.
      expect(['plan_already_active', 'payment_id_already_claimed']).toContain(replay.data.error?.code);
    });
  });

  it('5B — reusing the id of one payment across different products is rejected (global uniqueness wins)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    const iPro = seedIntent(PLAYER, 'pro');
    const iApi = seedIntent(PLAYER, 'api');

    await withServer(async (base) => {
      const first = await postJson(base, '/api/v1/payments/claims', { intentId: iPro, paymentId: 'pay_claim_5B_0001' }, 'tok-a');
      expect(first.status).toBe(201);
      const cross = await postJson(base, '/api/v1/payments/claims', { intentId: iApi, paymentId: 'pay_claim_5B_0001' }, 'tok-a');
      expect(cross.status).toBe(409);
      expect(cross.data.error?.code).toBe('payment_id_already_claimed');
    });
  });

  it('5C — reused id across different users AND products is blocked', async () => {
    seedSession('tok-a', PLAYER, 'member');
    seedSession('tok-b', 'usr-b', 'member');
    const iA = seedIntent(PLAYER, 'team');
    const iB = seedIntent('usr-b', 'api');

    await withServer(async (base) => {
      await postJson(base, '/api/v1/payments/claims', { intentId: iA, paymentId: 'pay_claim_5C_0001' }, 'tok-a');
      const r = await postJson(base, '/api/v1/payments/claims', { intentId: iB, paymentId: 'pay_claim_5C_0001' }, 'tok-b');
      expect(r.status).toBe(409);
    });
  });

  it('5D — id for a dead/foreign intent is rejected by the owner-scoped lookup', async () => {
    seedSession('tok-a', PLAYER, 'member');
    seedSession('tok-b', 'usr-b', 'member');
    const claimId = `mcl_5D_${Math.random().toString(36).slice(2, 8)}`;
    const iB = seedIntent('usr-b', 'pro');
    seedClaim(claimId, 'usr-b', iB, 'pro', 'solo', 999, 'pay_claim_5D_0001');

    await withServer(async (base) => {
      const r = await postJson(base, '/api/v1/payments/claims', { intentId: iB, paymentId: 'pay_claim_5D_0001' }, 'tok-a');
      expect(r.status).toBe(404);
    });
  });
});

// =========================================================================
// 13. MANUAL RAIL CONVERGES ON THE SAME activateEntitlement AUTHORITY
// =========================================================================
describe('MANUAL ⇄ AUTOPILOT — one activation authority', () => {
  it('13A — manual approval runs the SAME entitlements statement autopilot uses (ON CONFLICT upsert, PRO_VERIFIED)', async () => {
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_13_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_13_0001');

    await withServer(async (base) => {
      await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
    });

    const ent = mock.queries.find((q) => q.startsWith('INSERT INTO entitlements'));
    expect(ent).toBeDefined();
    expect(ent).toContain('ON CONFLICT (user_id, plan_id)');
    expect(ent).toContain("'PRO_VERIFIED'");
    expect(ent).toContain('payment_session_id = EXCLUDED.payment_session_id');
  });

  it('13B — an api claim activates an api_access entitlement WITHOUT overwriting users.plan_id (add-on identity)', async () => {
    seedSession('tok-player', PLAYER, 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'api');
    const claimId = `mcl_13B_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'api', 'api_access', 9999, 'pay_claim_13B_0001');

    await withServer(async (base) => {
      const approve = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-admin');
      expect(approve.status).toBe(200);
      const claim = approve.data.claim as Record<string, unknown>;
      expect(claim.planId).toBe('api');
      expect(claim.purchaseType).toBe('api_access');
    });

    expect(mock.entitlements.has(`${PLAYER}:api`)).toBe(true);
    expect(mock.users.get(PLAYER)!.plan_id).toBe('free');
  });
});

// =========================================================================
// 109. ALL THREE PRODUCTS THROUGH THE MANUAL RAIL (₹999 / ₹4,999 / ₹9,999)
// =========================================================================
describe('ALL PRODUCTS — manual submit -> approve -> entitlement (price-bound matrix)', () => {
  const matrix = [
    { plan: 'pro',  amount: 999,  purchase: 'solo',       expectsPlanOverwrite: true },
    { plan: 'team', amount: 4999, purchase: 'team',       expectsPlanOverwrite: true },
    { plan: 'api',  amount: 9999, purchase: 'api_access', expectsPlanOverwrite: false },
  ] as const;

  it.each(matrix)('$plan (₹$amount) — submit + owner approve grants exactly ONE entitlement for that product', async ({ plan, amount, purchase, expectsPlanOverwrite }) => {
    seedSession('tok-player', PLAYER, 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, plan);

    await withServer(async (base) => {
      // User submits the REAL Payment ID; server must derive plan/amount from the intent.
      const submit = await postJson(base, '/api/v1/payments/claims', { intentId, paymentId: `pay_claim_mat_${plan}_0001` }, 'tok-player');
      expect(submit.status).toBe(201);
      const claim = submit.data.data?.claim as Record<string, unknown>;
      expect(claim.planId).toBe(plan);
      expect(claim.purchaseType).toBe(purchase);
      expect(claim.amountInr).toBe(amount);

      const approve = await postJson(base, `/api/v1/admin/payments/claims/${claim.id}/approve`, {}, 'tok-admin');
      expect(approve.status).toBe(200);

      // Exactly ONE entitlement for (user, plan), PRO_VERIFIED, session-bound to this claim.
      const ent = mock.entitlements.get(`${PLAYER}:${plan}`);
      expect(ent).toBeDefined();
      expect(ent!.state).toBe('PRO_VERIFIED');
      expect(ent!.payment_session_id).toBe(claim.id);
      expect(ent!.reason).toBe('verified');
    });

    // For pro/team the users.plan_id mirrors the purchase; for api it must NOT overwrite.
    if (expectsPlanOverwrite) expect(mock.users.get(PLAYER)!.plan_id).toBe(plan);
    else expect(mock.users.get(PLAYER)!.plan_id).toBe('free');

    // Intent lifecycle converges to ACTIVE on the same, single authority.
    expect(mock.intents.get(intentId)!.status).toBe('ACTIVE');
  });
});

// =========================================================================
// 22. ADMIN REVIEW FALLBACK (reject never touches entitlement/intent)
// =========================================================================
describe('ADMIN REVIEW FALLBACK — reject path', () => {
  it('22A — reject keeps the intent PENDING, grants NO entitlement, and records the reason', async () => {
    seedSession('tok-player', PLAYER, 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_22_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_22_0001');

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/reject`, { reason: 'Payment ID not found in Razorpay' }, 'tok-admin');
      expect(r.status).toBe(200);
      expect(r.data.claim).toMatchObject({ status: 'REJECTED', rejectionReason: 'Payment ID not found in Razorpay' });
    });

    expect(mock.entitlements.size).toBe(0);
    expect(mock.intents.get(intentId)!.status).toBe('PENDING');
    expect(mock.users.get(PLAYER)!.plan_id).toBe('free');
  });

  it('22B — reject requires a reason (400 rejection_reason_required)', async () => {
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_22B_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_22B_0001');

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/reject`, {}, 'tok-admin');
      expect(r.status).toBe(400);
      expect(r.data.error?.code).toBe('rejection_reason_required');
    });
  });
});

// =========================================================================
// 24. CROSS-USER AUTHORIZATION (fail closed)
// =========================================================================
describe('CROSS-USER CLAIM AUTHORIZATION', () => {
  it('24A — user B cannot read user A\'s claim (404)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    seedSession('tok-b', 'usr-b', 'member');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_24A_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_24A_0001');

    await withServer(async (base) => {
      const r = await getJson(base, `/api/v1/payments/claims/${claimId}`, 'tok-b');
      expect(r.status).toBe(404);
    });
  });

  it('24B — GET /claims lists only the caller\'s claims', async () => {
    seedSession('tok-a', PLAYER, 'member');
    seedSession('tok-b', 'usr-b', 'member');
    const iA = seedIntent(PLAYER, 'pro');
    const iB = seedIntent('usr-b', 'pro');
    seedClaim('mcl_24B_1', PLAYER, iA, 'pro', 'solo', 999, 'pay_claim_24B_0001');
    seedClaim('mcl_24B_2', 'usr-b', iB, 'pro', 'solo', 999, 'pay_claim_24B_0002');

    await withServer(async (base) => {
      const r = await getJson(base, '/api/v1/payments/claims', 'tok-a');
      expect(r.status).toBe(200);
      const claims = r.data.data?.claims as Array<{ id: string }>;
      expect(claims.map((c) => c.id)).toEqual(['mcl_24B_1']);
    });
  });

  it('24C — the founder inbox is admin-gated (member → 403)', async () => {
    seedSession('tok-a', PLAYER, 'member');
    await withServer(async (base) => {
      const r = await getJson(base, '/api/v1/admin/payments/claims?status=PENDING', 'tok-a');
      expect(r.status).toBe(403);
    });
  });

  it('24D — a member CANNOT use the approve route on any claim (RBAC gate precedes the handler)', async () => {
    seedSession('tok-member', 'usr-member', 'member');
    seedSession('tok-admin', ADMIN, 'owner');
    const intentId = seedIntent(PLAYER, 'pro');
    const claimId = `mcl_24D_${Math.random().toString(36).slice(2, 8)}`;
    seedClaim(claimId, PLAYER, intentId, 'pro', 'solo', 999, 'pay_claim_24D_0001');

    await withServer(async (base) => {
      const r = await postJson(base, `/api/v1/admin/payments/claims/${claimId}/approve`, {}, 'tok-member');
      expect(r.status).toBe(403);
    });
    expect(mock.claims.get(claimId)!.status).toBe('PENDING');
    expect(mock.entitlements.size).toBe(0);
  });
});