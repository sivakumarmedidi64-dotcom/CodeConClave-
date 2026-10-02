/**
 * CodeConClave — PAYMENT AUTO-UNLOCK E2E (PAYMENT INCIDENT FIX).
 *
 * Deterministic, DB-mocked, no-network proof that a REAL Razorpay payment-link
 * browser-redirect callback (provider-AUTHENTIC signature scheme:
 * HMAC-SHA256(key_secret, payment_id|payment_link_id|reference_id|status))
 * drives a reserved intent all the way to a PRO_VERIFIED entitlement for the
 * reserving user — the automatic activation chain the live-payment incident
 * proved was unreachable in the field:
 *
 *   reserve (assignLink) -> Razorpay callback -> pool binding checks ->
 *   trusted pipeline (razorpay_callback) -> applyDecision (SOLE authority) ->
 *   entitlement PRO_VERIFIED + users.plan_id -> reservation FULFILLED + ledger.
 *
 * Fail-closed invariants re-checked for the authentic scheme:
 *   - wrong-secret callback -> invalid_signature, NO activation
 *   - late callback on an expired reservation -> reservation_expired, NO activation
 *   - replay of the same payment_id -> duplicate, NO second grant
 *   - legacy in-repo scheme (reference_id:payment_id) remains accepted (compat)
 *
 * The signature under test is the AUTHENTIC Razorpay payment-link redirect
 * format (four fields joined by '|'), which the previous in-repo scheme
 * (reference_id:payment_id) could never match — so every real callback would
 * have been ledged invalid_signature and the payment permanently unable to
 * unlock. acceptance of both requires RAZORPAY_KEY_SECRET, so no authenticity
 * weakening.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock DB (repo convention: vi.hoisted mock of ../shared/db.js)
// ---------------------------------------------------------------------------
const mock = vi.hoisted(() => {
  const state: {
    poolRows: Record<number, Record<string, unknown>>;
    reservationRows: Record<string, Record<string, unknown>>;
    byReference: Record<string, Record<string, unknown>>;
    intentRows: Record<string, Record<string, unknown>>;
  } = { poolRows: {}, reservationRows: {}, byReference: {}, intentRows: {} };
  const reset = () => {
    state.poolRows = {};
    state.reservationRows = {};
    state.byReference = {};
    state.intentRows = {};
  };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = handler(text, params);
    return { rows, rowCount: rows.length };
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const rows = handler(text, params);
    return rows[0] ?? null;
  };
  const queryMany = async (text: string, params: unknown[] = []) => handler(text, params);
  let handler: (text: string, params: unknown[]) => Record<string, unknown>[] = (_, __) => [];
  return {
    state,
    reset,
    setHandler(fn: (text: string, params: unknown[]) => Record<string, unknown>[]) {
      handler = fn;
    },
    pool: { query },
    queryOne,
    queryMany,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query, queryOne, queryMany }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query, queryOne, queryMany }),
  };
});

vi.mock('../../../shared/db.js', () => mock);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { env } from '../../../config/env.js';
import { verifyCallbackSignature } from './service.js';
import { handlePoolCallback } from './callback.js';

const SECRET = 'rzp_test_secret_123';

function poolRow(over: Record<string, unknown> = {}) {
  return {
    link_index: 1,
    payment_link_id: 'plink_a',
    razorpay_url: 'https://rzp.io/rzp/poolA',
    reference_id: 'CCPOOL-001',
    amount: 999,
    currency: 'INR',
    plan: 'pro',
    callback_path: '/cb/1',
    is_active: true,
    ...over,
  };
}

function reservationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pvr-a',
    link_index: 1,
    intent_id: 'pin-a',
    user_id: 'u1',
    workspace_id: null,
    plan: 'pro',
    amount_inr: 999,
    currency: 'INR',
    link_reference_id: 'CCPOOL-001',
    status: 'RESERVED',
    session_id: null,
    client_ip: null,
    heartbeat_last: null,
    reserved_at: new Date(),
    expires_at: new Date(Date.now() + 15 * 60 * 1000),
    fulfilled_at: null,
    payment_id: null,
    ...over,
  };
}

function intentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pin-a',
    owner_id: 'u1',
    plan_id: 'pro',
    amount_inr: 999,
    currency: 'INR',
    reference: 'CCPRO-ABCD12',
    payment_link: 'https://rzp.io/rzp/poolA',
    status: 'PENDING',
    confidence: 0,
    decision: null,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    created_at: new Date(),
    updated_at: new Date(),
    pool_link_index: 1,
    pool_reference_id: 'CCPOOL-001',
    reservation_status: 'RESERVED',
    ...over,
  };
}

/** AUTHENTIC Razorpay payment-link redirect signature message.
 * Official order (razorpay-node lib/utils/razorpay-utils.js):
 * payment_link_id | payment_link_reference_id | payment_link_status | payment_id
 */
function authenticMessage(f: { paymentId: string; paymentLinkId: string; referenceId: string; status: string }) {
  return `${f.paymentLinkId}|${f.referenceId}|${f.status}|${f.paymentId}`;
}

function authenticCallback(f: { paymentId?: string; paymentLinkId?: string; referenceId?: string; status?: string; secret?: string } = {}) {
  const fields = {
    paymentId: f.paymentId ?? 'pay_rp_auto1',
    paymentLinkId: f.paymentLinkId ?? 'plink_a',
    referenceId: f.referenceId ?? 'CCPOOL-001',
    status: f.status ?? 'paid',
  };
  const message = authenticMessage(fields);
  const secret = f.secret ?? SECRET;
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return { fields, message, signature };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.RAZORPAY_KEY_SECRET = SECRET;
  mock.reset();
});

describe('payment auto-unlock: authentic Razorpay redirect -> PRO_VERIFIED (incident fix)', () => {
  it('drives a reserved intent end-to-end to PRO_VERIFIED entitlement + users.plan', async () => {
    const link = poolRow();
    const res = reservationRow();
    const intent = intentRow();
    mock.state.poolRows[1] = link;
    mock.state.reservationRows['pvr-a'] = res;
    mock.state.byReference['CCPOOL-001'] = res;
    mock.state.intentRows['pin-a'] = intent;

    const writes: string[] = [];
    let currentIntent: Record<string, unknown> = intent;
    mock.setHandler((text, params) => {
      const t = text.trim();
      if (t.startsWith('SELECT * FROM payment_link_pool')) return [link];
      if (t.startsWith('SELECT * FROM payment_link_reservations WHERE link_reference_id')) return [res];
      if (t.startsWith('SELECT * FROM payment_link_reservations WHERE intent_id')) return [res];
      if (t.startsWith('SELECT * FROM payment_intents') || (t.startsWith('SELECT *') && t.includes('FROM payment_intents'))) return [currentIntent];
      if (t.startsWith('INSERT INTO payment_evidence')) return [{ id: 'ev-insert' }];
      if (t.startsWith('SELECT * FROM payment_evidence WHERE id')) return [{ id: 'ev-a', intent_id: 'pin-a', owner_id: 'u1', source: 'razorpay_callback', sha256: 'x', signals: '{}', matched: true, fraud_flags: null, provider_payment_id: 'pay_rp_auto1', reference: 'CCPRO-ABCD12', amount_inr: 999, payer_email: null, paid_at: new Date(), created_at: new Date() }];
      if (t.includes('provider_payment_id')) return [];
      if (t.includes('FROM payment_evidence WHERE sha256')) return [];
      if (t.startsWith('SELECT count(*)') && t.includes('payment_evidence')) return [{ n: 0 }];
      if (t.includes('FROM payment_evidence')) return [];
      if (t.includes('FROM payment_intents WHERE reference')) return [];
      if (t.includes('FROM users')) return [];
      if (t.startsWith('SELECT id, outcome FROM payment_pool_callbacks')) return [];
      if (t.startsWith('UPDATE payment_intents SET confidence')) return [];
      if (t.startsWith('UPDATE payment_intents') && t.includes("status = 'ACTIVE'")) {
        currentIntent = { ...intent, status: 'ACTIVE' };
        writes.push('intent:ACTIVE');
        return [currentIntent];
      }
      if (t.startsWith('UPDATE payment_intents') && t.includes('reservation_status')) {
        writes.push('reservation:intent FULFILLED');
        return [];
      }
      if (t.startsWith('UPDATE payment_link_reservations') && t.includes("status = 'FULFILLED'")) {
        writes.push('reservation:FULFILLED');
        return [];
      }
      if (t.startsWith('INSERT INTO entitlements')) {
        writes.push('entitlement:PRO_VERIFIED');
        return [];
      }
      if (t.startsWith('UPDATE users')) {
        writes.push('users:plan=pro');
        return [];
      }
      if (t.startsWith('INSERT INTO payment_pool_callbacks')) {
        writes.push(`callback:${String(params?.[8] ?? '')}`);
        return [];
      }
      return [];
    });

    const c = authenticCallback();
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: c.fields.paymentId,
      razorpay_payment_link_id: c.fields.paymentLinkId,
      razorpay_payment_link_reference_id: c.fields.referenceId,
      razorpay_payment_link_status: c.fields.status,
      razorpay_signature: c.signature,
    });

    expect(result.outcome).toBe('accepted');
    expect(result.activated).toBe(true);
    expect(result.intentId).toBe('pin-a');
    // Auto-unlock writes must reach the authoritative grant surface.
    expect(writes).toContain('intent:ACTIVE');
    expect(writes).toContain('entitlement:PRO_VERIFIED');
    expect(writes).toContain('users:plan=pro');
    expect(writes).toContain('reservation:FULFILLED');
    expect(writes).toContain('callback:accepted');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.pool_callback_activated' }));
  });

  it('rejects an authentic-scheme callback signed with the WRONG secret (fail-closed)', async () => {
    const link = poolRow();
    const res = reservationRow();
    mock.state.poolRows[1] = link;
    mock.state.reservationRows['pvr-a'] = res;
    mock.state.byReference['CCPOOL-001'] = res;
    mock.state.intentRows['pin-a'] = intentRow();
    const writes: string[] = [];
    mock.setHandler((text, params) => {
      const t = text.trim();
      if (t.startsWith('SELECT id, outcome FROM payment_pool_callbacks')) return [];
      if (t.startsWith('INSERT INTO payment_pool_callbacks')) {
        writes.push(`callback:${String(params?.[8] ?? '')}`);
        return [];
      }
      return [];
    });
    const c = authenticCallback({ secret: 'wrong-secret' });
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: c.fields.paymentId,
      razorpay_payment_link_id: c.fields.paymentLinkId,
      razorpay_payment_link_reference_id: c.fields.referenceId,
      razorpay_payment_link_status: c.fields.status,
      razorpay_signature: c.signature,
    });
    expect(result.outcome).toBe('invalid_signature');
    expect(result.activated).toBe(false);
    expect(writes).toContain('callback:invalid_signature');
  });

  it('rejects a LATE callback whose reservation has expired (never activates a stale payment)', async () => {
    const link = poolRow();
    const res = reservationRow({ status: 'EXPIRED', expires_at: new Date(Date.now() - 5 * 60 * 1000) });
    mock.state.poolRows[1] = link;
    mock.state.reservationRows['pvr-a'] = res;
    mock.state.byReference['CCPOOL-001'] = res;
    mock.state.intentRows['pin-a'] = intentRow();
    mock.setHandler((text) => {
      const t = text.trim();
      if (t.startsWith('SELECT * FROM payment_link_pool')) return [link];
      if (t.startsWith('SELECT * FROM payment_link_reservations WHERE link_reference_id')) return [res];
      if (t.startsWith('SELECT * FROM payment_link_reservations WHERE intent_id')) return [res];
      return [];
    });
    const c = authenticCallback();
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: c.fields.paymentId,
      razorpay_payment_link_id: c.fields.paymentLinkId,
      razorpay_payment_link_reference_id: c.fields.referenceId,
      razorpay_payment_link_status: c.fields.status,
      razorpay_signature: c.signature,
    });
    expect(result.outcome).toBe('reservation_expired');
    expect(result.activated).toBe(false);
  });

  it('replays the same authentic payment_id -> duplicate, no second grant', async () => {
    const link = poolRow();
    const res = reservationRow({ status: 'FULFILLED', payment_id: 'pay_rp_auto1' });
    mock.state.poolRows[1] = link;
    mock.state.reservationRows['pvr-a'] = res;
    mock.state.byReference['CCPOOL-001'] = res;
    mock.state.intentRows['pin-a'] = intentRow();
    mock.setHandler((text) => {
      const t = text.trim();
      if (t.startsWith('SELECT id, outcome FROM payment_pool_callbacks')) return [{ id: 'pcb-a', outcome: 'accepted' }];
      return [];
    });
    const c = authenticCallback();
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: c.fields.paymentId,
      razorpay_payment_link_id: c.fields.paymentLinkId,
      razorpay_payment_link_reference_id: c.fields.referenceId,
      razorpay_payment_link_status: c.fields.status,
      razorpay_signature: c.signature,
    });
    expect(result.outcome).toBe('duplicate');
    expect(result.activated).toBe(false);
  });

  it('verifyCallbackSignature accepts BOTH the authentic and legacy messages with the right secret (compat)', async () => {
    const f = { paymentId: 'pay_rp_auto1', paymentLinkId: 'plink_a', referenceId: 'CCPOOL-001', status: 'paid' };
    const authentic = authenticMessage(f);
    const legacy = `${f.referenceId}:${f.paymentId}`;
    const good = (m: string) => createHmac('sha256', SECRET).update(m).digest('hex');
    expect(verifyCallbackSignature(authentic, good(authentic))).toBe(true);
    expect(verifyCallbackSignature(legacy, good(legacy))).toBe(true);
    expect(verifyCallbackSignature(authentic, good(legacy))).toBe(false);
    expect(verifyCallbackSignature(authentic, createHmac('sha256', 'nope').update(authentic).digest('hex'))).toBe(false);
  });
});