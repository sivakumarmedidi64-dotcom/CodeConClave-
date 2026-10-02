/**
 * CodeConClave — payments foundation tests (Section: payments + entitlements).
 * Covers: server-derived capability, honest no-evidence behavior (state stays
 * PENDING), exactly-one entitlement activation, session TTL, watchdog sweep.
 * All DB interaction is mocked; no payment provider is ever contacted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
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

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { AppError } from '../shared/errors.js';
import { env } from '../config/env.js';
import {
  paymentCapability,
  createPaymentSession,
  handleReturn,
  verifySession,
  getSession,
  SESSION_TTL_MS,
  sweepPaymentExpiry,
  PLAN_PRICES_INR,
} from '../modules/payments/service.js';

function session(id: string, sessionState: string): Record<string, unknown> {
  return {
    id,
    user_id: 'u1',
    plan_id: 'pro',
    amount_inr: 999,
    currency: 'INR',
    mode: 'PAYMENT_LINK',
    state: sessionState,
    reference: null,
    provider_payment_id: null,
    provider_order_id: null,
    verification_evidence: null,
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
  env.RAZORPAY_MODE = 'payment_link';
  env.RAZORPAY_KEY_ID = undefined;
  env.RAZORPAY_KEY_SECRET = undefined;
  env.RAZORPAY_WEBHOOK_SECRET = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paymentCapability (server-derived, honest)', () => {
  it('reports no API/webhook capability without credentials (link mode default)', () => {
    const cap = paymentCapability();
    expect(cap.api).toBe(false);
    expect(cap.webhook).toBe(false);
    expect(cap.link).toBe(true);
    expect(cap.mode).toBe('payment_link');
    expect(cap.plans.pro).toBe(PLAN_PRICES_INR.pro);
  });

  it('enables API capability only when key AND secret are both set', () => {
    expect(paymentCapability().api).toBe(false);
    env.RAZORPAY_KEY_ID = 'rzp_test_x';
    expect(paymentCapability().api).toBe(false);
    env.RAZORPAY_KEY_SECRET = 'secret';
    expect(paymentCapability().api).toBe(true);
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_token';
    expect(paymentCapability().webhook).toBe(true);
  });
});

describe('session lifecycle — never claims success without evidence', () => {
  it('creates a session in PENDING state with a configured link reference', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM payment_sessions') && !text.includes('plan_id = $2')) {
        return [{ ...session(String(params[0]), 'PENDING') }];
      }
      return null;
    };
    const created = await createPaymentSession('u1', 'pro');
    expect(created.state).toBe('PENDING');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_sessions'))!;
    expect(insert).toBeDefined();
    expect(insert.text).toContain("'PENDING'");
    expect(insert.params[4]).toBe('PAYMENT_LINK');
    const entitlement = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    expect(entitlement.params[3]).toBe('PRO_PENDING');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.session_created' }));
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
  });

  it('rejects unknown plans', async () => {
    await expect(createPaymentSession('u1', 'free')).rejects.toThrow(AppError);
  });

  it('stays PENDING after the paid-link return when no provider evidence exists', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("'CANCELLED'")) sessionState = 'CANCELLED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    const result = await handleReturn('u1', 's1', '1');
    expect(result.state).toBe('PENDING');
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_events')).length).toBe(1);
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels the session on an explicit cancelled return', async () => {
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("'CANCELLED'")) sessionState = 'CANCELLED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    const result = await handleReturn('u1', 's1', 'cancelled');
    expect(result.state).toBe('CANCELLED');
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE payment_sessions'))!;
    expect(upd.text).toContain("'CANCELLED'");
  });
});

describe('verifySession — only evidence activates exactly one entitlement', () => {
  it('VERIFIED only via explicit provider evidence; idempotent single activation', async () => {
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("SET state = 'VERIFIED'")) sessionState = 'VERIFIED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    const first = await verifySession('u1', 's1', {
      source: 'WEBHOOK',
      provider_payment_id: 'pay_1',
      raw: { event: 'payment.captured' },
    });
    expect(first.state).toBe('VERIFIED');
    const payments = db.state.calls.filter((c) => c.text.includes('INSERT INTO payments'));
    expect(payments.length).toBe(1);
    expect(payments[0].text).toContain('ON CONFLICT (provider_ref) DO NOTHING');
    expect(payments[0].params[3]).toBe('pay_1');
    const entitlements = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements'));
    expect(entitlements.length).toBe(1);
    expect(entitlements[0].text).toContain("'PRO_VERIFIED'");
    expect(db.state.calls.some((c) => c.text.includes('UPDATE users SET plan_id'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.verified' }));

    const second = await verifySession('u1', 's1', {
      source: 'WEBHOOK',
      provider_payment_id: 'pay_1',
      raw: {},
    });
    expect(second.state).toBe('VERIFIED');
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO payments')).length).toBe(1);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements')).length).toBe(1);
  });

  it('rejects verification of a non-pending session', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions')) return [session('s1', 'EXPIRED')];
      return null;
    };
    await expect(
      verifySession('u1', 's1', { source: 'ADMIN', raw: {} }),
    ).rejects.toMatchObject({ errorCode: 'session_not_pending' });
  });
});

describe('session TTL + watchdog sweep', () => {
  it('exposes a 30-minute session TTL constant', () => {
    expect(SESSION_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('sweep returns the number of stale PENDING sessions expired', async () => {
    db.state.rowCount = 2;
    const n = await sweepPaymentExpiry();
    expect(n).toBe(2);
    const sweep = db.state.calls.find((c) => c.text.includes("state = 'EXPIRED'"))!;
    expect(sweep.text).toContain("state = 'PENDING'");
    expect(sweep.text).toContain('expires_at <= now()');
  });
});

describe('getSession tenant isolation', () => {
  it('always filters by user id', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM payment_sessions')) return [{ ...session(String(params[0]), 'PENDING') }];
      return null;
    };
    const result = await getSession('u1', 's1');
    expect(result.id).toBe('s1');
    const call = db.state.calls.find((c) => c.text.includes('FROM payment_sessions'))!;
    expect(call.text).toContain('user_id = $2');
  });
});