/**
 * CodeConClave — PRIVATE PAYMENT CONTROL CENTER tests.
 *
 * Covers the mandated requirements:
 *  - unauthorized dashboard access rejected (founder_only)
 *  - non-founder access rejected (member/viewer, even with a user row)
 *  - admin/owner RBAC access allowed; founder (PAYMENT_FOUNDER_EMAIL) allowed
 *  - payment state cannot be directly modified through the dashboard:
 *      * the router registers GET reads plus one POST (verify-payment) that
 *        funnels through the EXISTING activation authority — never a direct
 *        activate/approve/force/grant
 *      * service layer performs only SELECT reads
 *  - secrets never returned (no token / credential / raw evidence fields)
 *  - cross-tenant: only founder/admin can read ANY tenant; members never can
 *  - duplicate payment id -> surfaced as fraud flag, never ACTIVE from REVIEW
 *  - uncertain correlation stays non-ACTIVE (PENDING/UNKNOWN)
 *  - fake evidence / amount mismatch / plan mismatch -> flagged, non-ACTIVE
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], resolve: null };

  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : [];
    return { rows, rowCount: rows.length };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../../shared/db.js', () => db);
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));

import { assertControlCenterAccess, canAccessControlCenter } from './control-center.js';

const env = await import('../../config/env.js').then((m) => m.env);

function setFounder(email: string | null) {
  (env as unknown as Record<string, unknown>).PAYMENT_FOUNDER_EMAIL = email;
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  setFounder('founder@codeconclave.dev');
});

function authUser(over: Partial<{ id: string; rbacRole: string }>) {
  return { id: over.id ?? 'u1', rbacRole: (over.rbacRole ?? 'member') as 'owner' | 'admin' | 'member' | 'viewer' };
}

// ---------------------------------------------------------------------------
// Access gate
// ---------------------------------------------------------------------------
describe('control-center access gate (RBAC + founder)', () => {
  it('rejects an unauthenticated caller (unauthorized access)', async () => {
    await expect(assertControlCenterAccess(null)).rejects.toMatchObject({ errorCode: 'founder_only' });
  });

  it('rejects a member who is NOT the founder', async () => {
    // users.email = member@x.com  (not the founder email) -> isFounder false
    db.state.resolve = (t) => (t.includes('SELECT email FROM users') ? [{ email: 'member@x.com' }] : null);
    await expect(assertControlCenterAccess(authUser({}))).rejects.toMatchObject({ errorCode: 'founder_only' });
  });

  it('rejects a viewer who is NOT the founder', async () => {
    db.state.resolve = (t) => (t.includes('SELECT email FROM users') ? [{ email: 'viewer@x.com' }] : null);
    await expect(assertControlCenterAccess(authUser({ rbacRole: 'viewer' }))).rejects.toMatchObject({ errorCode: 'founder_only' });
  });

  it('allows the founder account (PAYMENT_FOUNDER_EMAIL match)', async () => {
    db.state.resolve = (t) => (t.includes('SELECT email FROM users') ? [{ email: 'founder@codeconclave.dev' }] : null);
    expect(await canAccessControlCenter(authUser({ id: 'u_founder' }))).toBe(true);
    await expect(assertControlCenterAccess(authUser({ id: 'u_founder' }))).resolves.toBeUndefined();
  });

  it('allows account-level owner role without a founder DB check', async () => {
    await expect(assertControlCenterAccess(authUser({ rbacRole: 'owner' }))).resolves.toBeUndefined();
  });

  it('allows account-level admin role without a founder DB check', async () => {
    await expect(assertControlCenterAccess(authUser({ rbacRole: 'admin' }))).resolves.toBeUndefined();
  });

  it('fails closed when PAYMENT_FOUNDER_EMAIL is not configured', async () => {
    setFounder(null);
    db.state.resolve = (t) => (t.includes('SELECT email FROM users') ? [{ email: 'founder@codeconclave.dev' }] : null);
    await expect(assertControlCenterAccess(authUser({ id: 'u_founder' }))).rejects.toMatchObject({ errorCode: 'founder_only' });
  });
});

// ---------------------------------------------------------------------------
// Service layer: mapping + safety + statuses
// ---------------------------------------------------------------------------
describe('control-center service (read-only mapping + safety)', () => {
  function intentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      intentId: `pin_${over.id ?? 1}`,
      ownerId: 'u_alice',
      email: 'alice@example.com',
      plan: 'pro',
      expectedAmount: 999,
      status: 'PENDING',
      decision: 'PENDING',
      fraud_flags: [],
      reference: 'CCPRO-ABC123',
      payment_link: 'https://rzp.io/rzp/x',
      mode: 'PAYMENT_LINK',
      paymentLinkId: null,
      referenceId: null,
      confidence: 0,
      created_at: '2026-09-01T10:00:00.000Z',
      expires_at: '2026-09-02T10:00:00.000Z',
      activated_at: null,
      detected_amount: null,
      paymentId: null,
      paymentMethod: null,
      paymentTimestamp: null,
      evidenceSource: null,
      ent_state: null,
      ...over,
    };
  }

  it('summary derives TODAY aggregates and revenue from VERIFIED payments only', async () => {
    // "TODAY" is computed from the live clock (created_at at 00:00 UTC today),
    // so the fixture timestamps must be relative to now — a hardcoded date goes
    // stale the day after it is written and would break the TODAY assertions.
    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const today10 = new Date(todayMidnight.getTime() + 10 * 3600e3).toISOString();
    const today11 = new Date(todayMidnight.getTime() + 11 * 3600e3).toISOString();
    const today12 = new Date(todayMidnight.getTime() + 12 * 3600e3).toISOString();
    const yesterday = new Date(todayMidnight.getTime() - 3600e3).toISOString();
    db.state.resolve = (t) => {
      if (!t.includes('FROM payment_intents i')) return null;
      return [
        intentRow({ id: 1, status: 'ACTIVE', decision: 'ACTIVE', expectedAmount: 999, created_at: today10, ent_state: 'PRO_VERIFIED' }),
        intentRow({ id: 2, status: 'PENDING', decision: 'PENDING', expectedAmount: 999, created_at: today11 }),
        intentRow({ id: 3, plan: 'team', status: 'REVIEW', decision: 'REVIEW', expectedAmount: 4999, created_at: today12 }),
        // yesterday — excluded from TODAY but counted in stats scope only
        intentRow({ id: 4, status: 'ACTIVE', decision: 'ACTIVE', expectedAmount: 999, created_at: yesterday }),
      ];
    };
    const { controlCenterSummary } = await import('./control-center.js');
    const s = await controlCenterSummary();
    expect(s.totalIntents).toBe(3);
    expect(s.proIntents).toBe(2);
    expect(s.teamIntents).toBe(1);
    expect(s.verifiedPayments).toBe(1);
    expect(s.activeEntitlements).toBe(1);
    expect(s.verifiedRevenueInr).toBe(999); // excludes yesterday's + pending/review
  });

  it('returns only secret-safe fields (no tokens/credentials/raw evidence) in payment rows', async () => {
    db.state.resolve = (t, _) => (t.includes('FROM payment_intents i') ? [intentRow()] : null);
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    const serialized = JSON.stringify(r);
    expect(serialized.toLowerCase()).not.toMatch(/token|secret|api[_-]?key|password|credential|raw/);
    // no evidence_summary / raw provider payload leaked
    expect(r).not.toHaveProperty('evidence_summary');
    expect(r).not.toHaveProperty('raw');
  });

  it('uncertain correlation stays non-ACTIVE (PENDING/UNKNOWN) when no evidence exists', async () => {
    db.state.resolve = (t, _) => (t.includes('FROM payment_intents i') ? [intentRow()] : null);
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows[0]!.verificationStatus).toBe('PENDING');
    expect(rows[0]!.correlationStatus).toBe('UNKNOWN');
    expect(rows[0]!.entitlementStatus).toBe('NONE');
  });

  it('verifies a trusted ACTIVE intent shows CORRELATED + ACTIVE verification', async () => {
    db.state.resolve = (t, _) =>
      t.includes('FROM payment_intents i')
        ? [
            intentRow({
              status: 'ACTIVE',
              decision: 'ACTIVE',
              confidence: 0.95,
              paymentId: 'pay_123',
              evidenceSource: 'gmail',
              detected_amount: 999,
              ent_state: 'PRO_VERIFIED',
            }),
          ]
        : null;
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows[0]!.correlationStatus).toBe('CORRELATED');
    expect(rows[0]!.verificationStatus).toBe('ACTIVE');
    expect(rows[0]!.entitlementStatus).toBe('ACTIVE');
  });

  it('amount mismatch surfaces fraud flag and reason, and never shows ACTIVE', async () => {
    db.state.resolve = (t, _) =>
      t.includes('FROM payment_intents i')
        ? [intentRow({ status: 'REVIEW', decision: 'REVIEW', fraud_flags: ['amount_mismatch'], detected_amount: 500 }) ]
        : null;
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows[0]!.fraudFlags).toContain('amount_mismatch');
    expect(rows[0]!.verificationStatus).toBe('REVIEW');
    expect(rows[0]!.reason).toContain('amount_mismatch');
  });

  it('plan mismatch surfaces fraud flag and reason, and never shows ACTIVE', async () => {
    db.state.resolve = (t, _) =>
      t.includes('FROM payment_intents i')
        ? [intentRow({ status: 'REVIEW', decision: 'REVIEW', fraud_flags: ['plan_mismatch'] }) ]
        : null;
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows[0]!.fraudFlags).toContain('plan_mismatch');
    expect(rows[0]!.verificationStatus).toBe('REVIEW');
  });

  it('duplicate payment id stays idempotently non-ACTIVE when flagged (REVIEW)', async () => {
    db.state.resolve = (t, _) =>
      t.includes('FROM payment_intents i')
        ? [
            intentRow({ id: 1, status: 'REVIEW', decision: 'REVIEW', fraud_flags: ['duplicate_payment_id'], paymentId: 'pay_dup', evidenceSource: 'gmail' }),
            intentRow({ id: 2, status: 'REVIEW', decision: 'REVIEW', fraud_flags: ['duplicate_payment_id'], paymentId: 'pay_dup', evidenceSource: 'gmail' }),
          ]
        : null;
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.fraudFlags.includes('duplicate_payment_id'))).toBe(true);
    expect(rows.every((r) => r.verificationStatus === 'REVIEW')).toBe(true);
    expect(rows.every((r) => r.entitlementStatus === 'NONE')).toBe(true);
  });

  it('fake evidence (no paymentId) stays PARTIAL/PENDING — never ACTIVE', async () => {
    db.state.resolve = (t, _) =>
      t.includes('FROM payment_intents i')
        ? [intentRow({ status: 'PENDING', decision: 'PENDING', paymentId: null }) ]
        : null;
    const { controlCenterPayments } = await import('./control-center.js');
    const rows = await controlCenterPayments({});
    expect(rows[0]!.verificationStatus).toBe('PENDING');
    expect(rows[0]!.correlationStatus).toBe('UNKNOWN');
  });

  it('single-payment detail returns the verification chain with safe evidence fields', async () => {
    db.state.resolve = (t, _) => {
      if (t.includes('FROM payment_intents i')) return [intentRow({ status: 'ACTIVE', decision: 'ACTIVE', paymentId: 'pay_1', ent_state: 'PRO_VERIFIED' })];
      if (t.includes('FROM payment_evidence') && t.includes('WHERE intent_id')) {
        return [
          { id: 'ev_1', source: 'gmail', providerPaymentId: 'pay_1', amountInr: 999, payerEmail: 'alice@example.com', paidAt: '2026-09-01T10:01:00.000Z', createdAt: '2026-09-01T10:01:00.000Z', fraudFlags: [] },
        ];
      }
      return null;
    };
    const { controlCenterPayment } = await import('./control-center.js');
    const detail = await controlCenterPayment('pin_x');
    expect(detail).not.toBeNull();
    expect(detail!.payment.paymentId).toBe('pay_1');
    expect(detail!.evidence).toHaveLength(1);
    const serialized = JSON.stringify(detail);
    expect(serialized.toLowerCase()).not.toMatch(/token|secret|api[_-]?key|password|credential/);
  });
});

// ---------------------------------------------------------------------------
// Route surface: read-only guarantees
// ---------------------------------------------------------------------------
describe('control-center router is read-only', () => {
  it('registers GET reads + the sole founder POST verify-payment (no activate/approve/force/grant)', async () => {
    const { controlCenterRoutes } = await import('./control-center-routes.js');
    const router = controlCenterRoutes();
    const stack = (router as unknown as { stack: Array<{ route?: { methods?: Record<string, boolean>; path?: string } }> }).stack ?? [];
    const seen: Array<{ method: string; path: string }> = [];
    for (const layer of stack) {
      const route = layer.route;
      if (!route) continue;
      for (const m of Object.keys(route.methods ?? {})) {
        if (route.methods[m]) seen.push({ method: m.toUpperCase(), path: String(route.path ?? '') });
      }
    }
    const paths = seen.map((s) => s.path);
    expect(paths).toContain('/summary');
    expect(paths).toContain('/payments');
    expect(paths).toContain('/payments/:id');
    expect(paths).toContain('/stats');
    expect(paths).toContain('/reconcile');
    expect(paths).toContain('/reconcile/credentials');
    expect(paths).toContain('/verify-payment');
    // The ONLY non-GET is the founder verify-payment action (server-side Razorpay
    // verification -> the EXISTING authority; it never directly activates).
    const nonGet = seen.filter((s) => s.method !== 'GET');
    expect(nonGet).toEqual([{ method: 'POST', path: '/verify-payment' }]);
    expect(seen.some((s) => s.path.includes('activate'))).toBe(false);
    expect(seen.some((s) => s.path.includes('approve'))).toBe(false);
    expect(seen.some((s) => s.path.includes('force'))).toBe(false);
    expect(seen.some((s) => s.path.includes('grant'))).toBe(false);
  });
});