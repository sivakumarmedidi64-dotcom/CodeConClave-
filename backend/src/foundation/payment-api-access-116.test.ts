/**
 * CodeConClave — API ACCESS product foundation tests.
 * API keys are a SEPARATE purchasable product (₹9,999, plan_id 'api'). Key
 * creation is gated on a PRO_VERIFIED 'api' entitlement; the activation hook
 * must never overwrite users.plan_id for the add-on; intents carry an explicit
 * purchase_type so Team and API Access (distinct links/amounts) are never
 * confused.
 * DB interaction mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { env } from '../config/env.js';
import { createUserApiKey, apiAccessStatus } from '../modules/apikeys/service.js';
import { activateEntitlement } from '../modules/payments/service.js';
import { createPaymentIntent } from '../modules/payments/intents.js';

const USER_ID = 'usr_api116';

function apiKeyRow(): Record<string, unknown> {
  return {
    id: 'ak_116',
    name: 'CI',
    key_prefix: 'cc_live_abc',
    created_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoke_reason: null,
  };
}

function intentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pin_116',
    owner_id: USER_ID,
    plan_id: 'api',
    purchase_type: 'api_access',
    amount_inr: 9999,
    currency: 'INR',
    reference: 'CCAPI-ABC123',
    payment_link: 'https://rzp.io/rzp/team',
    mode: 'PAYMENT_LINK',
    provider_payment_link_id: null,
    provider_reference_id: null,
    status: 'PENDING',
    confidence: 0,
    decision: null,
    expires_at: new Date(Date.now() + 86400000),
    created_at: new Date(),
    updated_at: new Date(),
    pool_link_index: null,
    pool_reference_id: null,
    reservation_status: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.state.calls = [];
  db.state.rows = [];
  env.RAZORPAY_KEY_ID = 'rzp_test_x';
  env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_x';
  env.RAZORPAY_PRO_PAYMENT_LINK = 'https://rzp.io/rzp/pro';
  env.RAZORPAY_TEAM_PAYMENT_LINK = 'https://rzp.io/rzp/team';
  env.RAZORPAY_API_PAYMENT_LINK = 'https://rzp.io/rzp/api';
  env.PAYMENT_INTENT_TTL_HOURS = 24;
  env.PAYMENT_CONFIDENCE_ACTIVE = 0.7;
  env.PAYMENT_CONFIDENCE_GRACE = 0.35;
  env.PAYMENT_GRACE_HOURS = 72;
  env.API_URL = 'http://localhost:4000';
});

afterEach(() => {
  db.state.resolve = null;
});

describe('API key creation gate (API Access is a separate product)', () => {
  it('rejects key creation without a PRO_VERIFIED api entitlement (Solo/Team do not include it)', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements') ? [{ state: 'PRO_PENDING' }] : text.includes('count(*)') ? [{ n: 0 }] : null;
    await expect(createUserApiKey(USER_ID, 'CI')).rejects.toMatchObject({ errorCode: 'api_access_required' });
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO user_api_keys'));
    expect(inserts).toHaveLength(0);
  });

  it('allows key creation once the api entitlement is PRO_VERIFIED', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements') ? [{ state: 'PRO_VERIFIED' }]
      : text.includes('count(*)') ? [{ n: 0 }]
      : text.includes('SELECT * FROM user_api_keys WHERE id') ? [apiKeyRow()]
      : null;
    const result = await createUserApiKey(USER_ID, 'CI', null);
    expect(result.id).toBe('ak_116');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_api_keys'));
    expect(insert).toBeDefined();
  });

  it('apiAccessStatus reflects the entitlement state', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [{ state: 'PRO_VERIFIED' }] : null);
    expect(await apiAccessStatus(USER_ID)).toEqual({ planId: 'api', entitled: true, state: 'PRO_VERIFIED' });
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [{ state: 'PRO_PENDING' }] : null);
    expect(await apiAccessStatus(USER_ID)).toEqual({ planId: 'api', entitled: false, state: 'PRO_PENDING' });
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [] : null);
    expect(await apiAccessStatus(USER_ID)).toEqual({ planId: 'api', entitled: false, state: null });
  });
});

describe('API Access EXPIRY is enforced at request time (BUG: state-only gate)', () => {
  const ent = (over: Record<string, unknown> = {}) => ({ state: 'PRO_VERIFIED', expires_at: null, ...over });

  it('denies an api entitlement whose expires_at has already passed', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements') ? [ent({ expires_at: new Date(Date.now() - 60_000) })] : null;
    expect(await apiAccessStatus(USER_ID)).toEqual({ planId: 'api', entitled: false, state: 'PRO_VERIFIED' });
  });

  it('allows an api entitlement that is still inside its window', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements') ? [ent({ expires_at: new Date(Date.now() + 3_600_000) })] : null;
    expect((await apiAccessStatus(USER_ID)).entitled).toBe(true);
  });

  it('allows a NULL expires_at (founder/complimentary grant, no expiry)', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [ent({ expires_at: null })] : null);
    expect((await apiAccessStatus(USER_ID)).entitled).toBe(true);
  });

  it('FAILS CLOSED when expires_at is present but unparseable (corruption)', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [ent({ expires_at: 'not-a-date' })] : null);
    expect((await apiAccessStatus(USER_ID)).entitled).toBe(false);
  });

  it('refuses API key creation once the entitlement has expired', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements') ? [ent({ expires_at: new Date(Date.now() - 1_000) })]
      : text.includes('count(*)') ? [{ n: 0 }]
      : null;
    await expect(createUserApiKey(USER_ID, 'CI')).rejects.toMatchObject({ errorCode: 'api_access_required' });
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO user_api_keys'))).toHaveLength(0);
  });

  it('reads expires_at, so the gate cannot silently fall back to state-only', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [ent()] : null);
    await apiAccessStatus(USER_ID);
    const call = db.state.calls.find((c) => c.text.includes('FROM entitlements'));
    expect(call?.text).toContain('expires_at');
  });
});

describe('activateEntitlement — add-on never overwrites users.plan_id', () => {
  it('api entitlement is granted but users.plan_id is left untouched', async () => {
    db.state.resolve = () => [];
    await activateEntitlement(USER_ID, 'api', 'pay_116');
    const entitlement = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'));
    expect(entitlement).toBeDefined();
    const usersWrite = db.state.calls.find((c) => c.text.includes('UPDATE users SET plan_id'));
    expect(usersWrite).toBeUndefined();
  });

  it('team entitlement still mirrors users.plan_id (base plan)', async () => {
    db.state.resolve = () => [];
    await activateEntitlement(USER_ID, 'team', 'pay_116b');
    const usersWrite = db.state.calls.find((c) => c.text.includes('UPDATE users SET plan_id'));
    expect(usersWrite).toBeDefined();
    expect(usersWrite!.params[1]).toBe('team');
  });
});

describe('createPaymentIntent — explicit purchase_type (identity, never amount)', () => {
  it('api intent carries purchase_type api_access on a ₹9,999 intent', async () => {
    db.state.resolve = (text) =>
      text.includes('payment_intents WHERE owner_id') ? []
      : text.includes('payment_intents WHERE id') ? [intentRow({ plan_id: 'api' })]
      : null;
    const intent = await createPaymentIntent(USER_ID, 'api');
    expect(intent.plan_id).toBe('api');
    expect(intent.purchase_type).toBe('api_access');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_intents'));
    expect(String(insert!.text)).toContain('purchase_type');
    expect(insert!.params[2]).toBe('api');
    expect(insert!.params[3]).toBe('api_access');
    expect(insert!.params[4]).toBe(9999);
  });

  it('pro and team intents map to solo / team purchase types', async () => {
    db.state.resolve = (text) => {
      if (text.includes('payment_intents WHERE owner_id')) return [];
      if (text.includes('payment_intents WHERE id')) {
        const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_intents'));
        return [intentRow({ plan_id: inserts.length === 1 ? 'pro' : 'team' })];
      }
      return null;
    };
    await createPaymentIntent(USER_ID, 'pro');
    await createPaymentIntent(USER_ID, 'team');
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_intents'));
    expect(String(inserts[0].text)).toContain('purchase_type');
    expect(inserts[0].params[2]).toBe('pro');
    expect(inserts[0].params[3]).toBe('solo');
    expect(inserts[1].params[2]).toBe('team');
    expect(inserts[1].params[3]).toBe('team');
  });

  it('rejects an unknown plan (no amount-based inference)', async () => {
    db.state.resolve = () => [];
    await expect(createPaymentIntent(USER_ID, 'enterprise')).rejects.toMatchObject({ errorCode: 'invalid_plan' });
  });
});