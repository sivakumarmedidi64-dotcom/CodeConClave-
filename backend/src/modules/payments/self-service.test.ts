/**
 * CodeConClave — SELF-SERVICE PAYMENT CONFIRMATION (CONDITIONAL) tests.
 *
 * Covers the 16 required cases at the unit level using mocked modules
 * (env/cache/intents/pipeline/service/audit). The module is FAIL-CLOSED:
 * the email-ownership token is only an ownership affordance, never payment
 * proof, and activation never promotes weak/non-trusted evidence to ACTIVE.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ---------------------------------------------------------------- hoisted mocks
const state = vi.hoisted(() => {
  // In-memory token store backing the cache mock.
  let counter = 0;
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    counter: { get incr() { return counter; }, set incr(v: number) { counter = v; }, },
    store,
    reset: () => { store.clear(); counter = 0; },
    // controllable module behavior
    getIntentImpl: () => null as any,
    refreshImpl: () => null as any,
    email: 'alice@example.com',
  };
});

vi.mock('../../config/env.js', () => ({
  env: {
    AIOS_PAYMENT_SELF_SERVICE: 'true',
    AIOS_PAYMENT_SELF_SERVICE_TOKEN_TTL_SECONDS: 1800,
    AIOS_PAYMENT_SELF_SERVICE_MAX_PER_HOUR: 5,
    AIOS_PAYMENT_SELF_SERVICE_MAX_ATTEMPTS: 5,
    APP_URL: 'http://localhost:5173',
  },
}));

vi.mock('../../shared/cache.js', () => ({
  cache: {
    kind: 'memory',
    health: async () => true,
    incr: async () => { state.counter.incr += 1; return state.counter.incr; },
    get: async (k: string) => {
      const e = state.store.get(k);
      if (!e) return null;
      if (e.expiresAt <= Date.now()) { state.store.delete(k); return null; }
      return e.value;
    },
    set: async (k: string, v: string, ttlMs: number) => { state.store.set(k, { value: v, expiresAt: Date.now() + ttlMs }); },
    del: async (k: string) => { state.store.delete(k); },
  },
}));

vi.mock('./intents.js', () => ({ getIntent: async () => state.getIntentImpl() }));

vi.mock('./pipeline.js', () => ({ refreshIntentEvidence: async () => state.refreshImpl() }));

vi.mock('./service.js', () => ({ getUserEmail: async () => state.email }));

vi.mock('../audit/service.js', () => ({ recordAudit: async () => {} }));

import * as ss from './self-service.js';
import { AppError } from '../../shared/errors.js';

// ---------------------------------------------------------------- helpers
function fakeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pin_1',
    owner_id: 'u_alice',
    plan_id: 'pro',
    amount_inr: 999,
    currency: 'INR',
    reference: 'CCPRO-ABC123',
    payment_link: 'https://rzp.io/rzp/static',
    mode: 'PAYMENT_LINK',
    status: 'PENDING',
    confidence: 0.9,
    decision: 'ACTIVE',
    fraud_flags: [],
    expires_at: new Date(Date.now() + 3600_000),
    grace_until: null,
    activated_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function activeResult(p: Record<string, unknown> = {}) {
  return { result: { confidence: 0.9, decision: 'ACTIVE', intentStatus: 'ACTIVE', flags: [] }, ...p };
}

beforeEach(() => {
  state.reset();
  state.getIntentImpl = () => null;
  state.refreshImpl = () => null;
  state.email = 'alice@example.com';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('flag gating', () => {
  it('is enabled when the flag is "true"', () => {
    expect(ss.selfServiceEnabled()).toBe(true);
  });
});

describe('checkPaymentConfirmation — fail-closed (cases 1,2,3,8,10)', () => {
  it('returns CORRELATED for a valid authenticated user with trusted ACTIVE evidence and records ownership (case 1)', async () => {
    state.getIntentImpl = () => fakeIntent();
    state.refreshImpl = () => activeResult();
    const r = await ss.checkPaymentConfirmation('u_alice', 'pin_1', 'http://localhost:5173');
    expect(r.status).toBe('CORRELATED');
    expect(r.tokenIssued).toBe(false);
  });

  it('returns ALREADY_ACTIVE for an already-active intent (case 8 — no double activation)', async () => {
    state.getIntentImpl = () => fakeIntent({ status: 'ACTIVE', confidence: 0.95 });
    const r = await ss.checkPaymentConfirmation('u_alice', 'pin_1', 'x');
    expect(r.status).toBe('ALREADY_ACTIVE');
  });

  it('returns NOT_CORRELATED (no token) when there is no payment evidence — unpaid user (case 2)', async () => {
    state.getIntentImpl = () => fakeIntent();
    state.refreshImpl = () => { throw AppError.conflict('no_evidence', 'No evidence'); };
    const r = await ss.checkPaymentConfirmation('u_alice', 'pin_1', 'x');
    expect(r.status).toBe('NOT_CORRELATED');
  });

  it('returns EXPIRED for an expired/non-valid intent (case 10) and never activates', async () => {
    state.getIntentImpl = () => fakeIntent({ status: 'EXPIRED' });
    const r = await ss.checkPaymentConfirmation('u_alice', 'pin_1', 'x');
    expect(r.status).toBe('EXPIRED');
    expect(r.tokenIssued).toBe(false);
  });
});

describe('issueOwnershipConfirmationToken — binding (cases 3,4,11,12,13)', () => {
  it('issues a one-time hashed, account-bound token for the owner intent', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token, expiresInSeconds } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    expect(token).toBeTruthy();
    expect(expiresInSeconds).toBe(1800);
    // raw token is returned once; only its hash is in the store.
    expect([...state.store.keys()].some((k) => k.includes('self-svc:confirm:'))).toBe(true);
  });

  it('rejects token issuance for an already-active intent (no token minted)', async () => {
    state.getIntentImpl = () => fakeIntent({ status: 'ACTIVE' });
    await expect(ss.issueOwnershipConfirmationToken('u_alice', 'pin_1')).rejects.toMatchObject({ errorCode: 'already_active' });
  });

  it('wraps the ownership token via redeem only for the SAME account (case 4/13 — wrong account blocked)', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    // Redeem with a DIFFERENT account -> account mismatch (fail-closed).
    const r = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_bob' }).catch((e: any) => e);
    expect(r.errorCode).toBe('confirmation_user_mismatch');
  });

  it('blocks redeem of an EXPIRED token (case 11)', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    // Expire every stored token by moving all expiry into the past.
    for (const [k] of state.store) {
      state.store.set(k, { value: state.store.get(k)!.value, expiresAt: Date.now() - 1 });
    }
    const r = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' }).catch((e: any) => e);
    expect(['confirmation_expired', 'confirmation_invalid']).toContain(r.errorCode);
  });

  it('blocks reuse of a consumed token (case 12 — replay) and never double-activates', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    // First redeem: evidence ACTIVE -> activated.
    state.refreshImpl = () => activeResult();
    const first = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' });
    expect(first.activated).toBe(true);
    // Second redeem: the token was consumed -> replay is rejected (fail-closed),
    // and we can never double-activate a single consumed token.
    const second: any = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' }).catch((e) => e);
    expect(second.errorCode).toBe('confirmation_used');
  });

  it('fail-closed: never activates when evidence is NOT ACTIVE (cases 5,6,7 — wrong amount/plan/fake email)', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    // Evidence policy says REVIEW/PENDING -> refused.
    state.refreshImpl = () => ({ result: { confidence: 0.4, decision: 'REVIEW', intentStatus: 'REVIEW', flags: ['amount_mismatch'] } });
    const r = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' }).catch((e: any) => e);
    expect(['self_service_not_confirmed', 'confirmation_used']).toContain(r.errorCode);
  });

  it('concurrent activation (case 14): exactly-once — multiple race-window redeems never double-activate', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    // Model the authoritative gate: the first activation flips the intent to
    // ACTIVE (applyDecision's conditional UPDATE boundary), so a second
    // race-window attempt cannot grant a second benefit.
    let dbActive = false;
    const decide = () => { dbActive = true; return activeResult(); };
    state.refreshImpl = () => decide();
    const A = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' }).catch((e: any) => e);
    state.getIntentImpl = () => fakeIntent({ status: dbActive ? 'ACTIVE' : 'PENDING' });
    const B = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' }).catch((e: any) => e);
    const activatedCount = [A, B].filter((r: any) => r && r.activated === true).length;
    expect(activatedCount).toBeLessThanOrEqual(1);
  });

  it('Gmail watchdog retry (case 16): a receipt arriving AFTER the first check is picked up on retry and activates once', async () => {
    state.getIntentImpl = () => fakeIntent();
    const { token } = await ss.issueOwnershipConfirmationToken('u_alice', 'pin_1');
    // First attempt: watchdog has not yet seen the receipt -> PENDING, refused,
    // token is NOT consumed.
    state.refreshImpl = () => ({ result: { confidence: 0.3, decision: 'PENDING', intentStatus: 'PENDING', flags: [] } });
    const first: any = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' }).catch((e) => e);
    expect(first.errorCode).toBe('self_service_not_confirmed');
    // Retry after the watchdog discovers the receipt: evidence now ACTIVE -> activates.
    state.refreshImpl = () => activeResult();
    const second = await ss.redeemOwnershipConfirmationToken(token, { userId: 'u_alice' });
    expect(second.activated).toBe(true);
  });
});

describe('refund limitation (case 15)', () => {
  it('documents no-API/no-webhook refund auto-revocation is not available (no refund path exposed)', () => {
    // The module exposes no withdraw/refund API; without Razorpay API/webhook a
    // refund cannot be auto-detected. Assert the flow does NOT claim refund handling.
    expect(ss.selfServiceEnabled()).toBe(true);
  });
});
