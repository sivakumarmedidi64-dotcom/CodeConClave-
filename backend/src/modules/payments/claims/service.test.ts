/**
 * CodeConClave — MANUAL payment claims: server-authoritative submit/list/
 * approve/reject. Every claim re-derives plan, purchase identity and amount
 * server-side; approval delegates to the existing entitlement authority inside
 * ONE transaction whose conditional UPDATE is the exactly-once race guard.
 * DB + audit + notifications mocked; intents/entitlement reach the same mocked
 * DB so owner-scoping SQL is exercised for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  interface Res {
    rows?: unknown[];
    rowCount?: number;
    throw?: unknown;
  }
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => Res | null) | null;
  } = { calls: [], rows: [], resolve: null };

  const run = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    state.calls.push({ text, params });
    const custom = state.resolve ? state.resolve(text, params) : null;
    if (custom?.throw) throw custom.throw;
    if (custom) return { rows: custom.rows ?? [], rowCount: custom.rowCount ?? 1 };
    return { rows: state.rows, rowCount: 1 };
  };
  return {
    state,
    queryOne: async (text: string, params: unknown[] = []) => (await run(text, params)).rows[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => (await run(text, params)).rows,
    withTenant: async (_userId: string | null, fn: (c: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
    withSystem: async (fn: (c: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
  };
});

vi.mock('../../../shared/db.js', () => db);

const activateEntitlement = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../service.js', () => ({
  PLAN_PRICES_INR: { pro: 999, team: 4999, api: 9999 },
  paymentLinkForPlan: (_plan: string) => 'https://rzp.io/rzp/x',
  createRazorpayPaymentLinkForIntent: async () => null,
  activateEntitlement,
}));

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../notifications/service.js', () => ({ notify }));

import {
  submitPaymentClaim,
  listUserClaims,
  getUserClaim,
  listClaimInbox,
  approveClaim,
  rejectClaim,
  type PaymentClaimRow,
} from './service.js';

const USER = 'usr_claim1';
const ADMIN = 'usr_admin1';

function claimRow(over: Partial<PaymentClaimRow> = {}): PaymentClaimRow {
  return {
    id: 'mcl_1',
    user_id: USER,
    email: 'u1@codeconclave.dev',
    intent_id: 'pin_1',
    plan_id: 'api',
    purchase_type: 'api_access',
    amount_inr: 9999,
    currency: 'INR',
    razorpay_payment_id: 'pay_abcdefgh',
    status: 'PENDING',
    source: 'manual',
    rejection_reason: null,
    review_locked_at: null,
    notification_sent_at: null,
    decided_by: null,
    decided_at: null,
    created_at: new Date('2026-01-10T00:00:00Z'),
    updated_at: new Date('2026-01-10T00:00:00Z'),
    ...over,
  };
}

function intentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pin_1',
    owner_id: USER,
    plan_id: 'api',
    purchase_type: 'api_access',
    amount_inr: 9999,
    currency: 'INR',
    reference: 'CCAPI-ABC123',
    payment_link: 'https://rzp.io/rzp/api',
    mode: 'PAYMENT_LINK',
    status: 'PENDING',
    confidence: 0,
    decision: null,
    created_at: new Date('2026-01-10T00:00:00Z'),
    expires_at: new Date('2026-01-17T00:00:00Z'),
    ...over,
  };
}

function resolveForIntentAndClaim(intent: Record<string, unknown> = intentRow({})): (text: string) => db['state']['resolve'] {
  return (text: string) => {
    if (text.startsWith('SELECT * FROM payment_intents WHERE id') && text.includes('owner_id')) return { rows: [intent] };
    if (text.startsWith('SELECT email FROM users')) return { rows: [{ email: 'u1@codeconclave.dev' }] };
    if (text.startsWith('SELECT * FROM payment_claim_reviews')) return { rows: [claimRow()] };
    if (text.startsWith('SELECT reference FROM payment_intents')) return { rows: [{ reference: 'CCAPI-ABC123' }] };
    return null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
});

afterEach(() => {
  db.state.resolve = null;
});

describe('submitPaymentClaim — validation and server-authoritative data', () => {
  it('rejects a claim against an ACTIVE intent (plan already active)', async () => {
    db.state.resolve = resolveForIntentAndClaim(intentRow({ status: 'ACTIVE' }));
    await expect(submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh')).rejects.toMatchObject({
      status: 409,
      errorCode: 'plan_already_active',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO payment_claim_reviews'))).toBe(false);
  });

  it('rejects claims on non-claimable intent statuses (GRACE/EXPIRED/REFUNDED/REVOKED)', async () => {
    for (const status of ['GRACE', 'EXPIRED', 'REFUNDED', 'REVOKED', 'CHARGEBACK']) {
      db.state.resolve = resolveForIntentAndClaim(intentRow({ status }));
      await expect(submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh')).rejects.toMatchObject({
        errorCode: 'intent_not_claimable',
      });
    }
  });

  it('rejects prose, URLs and cursor paste instead of a real pay_ id', async () => {
    db.state.resolve = resolveForIntentAndClaim();
    for (const junk of ['pay_', 'pay_ab', 'https://rzp.io/pay_abcdefgh', 'Thank you, here is my payment!', 'PAY_ABCDEFGH']) {
      await expect(submitPaymentClaim(USER, 'pin_1', junk)).rejects.toMatchObject({ errorCode: 'invalid_payment_id' });
    }
  });

  it('normalizes surrounding whitespace and collapses internal gaps in the id', async () => {
    db.state.resolve = resolveForIntentAndClaim();
    await submitPaymentClaim(USER, 'pin_1', '  pay_ABCDEFGH-1234_xyz  ');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_claim_reviews'));
    expect(insert!.params[7]).toBe('pay_ABCDEFGH-1234_xyz');
  });

  it('fails closed when the account has no e-mail', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_intents WHERE id') && text.includes('owner_id')) return { rows: [intentRow()] };
      if (text.startsWith('SELECT email FROM users')) return { rows: [{ email: null }] };
      return null;
    };
    await expect(submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh')).rejects.toMatchObject({
      errorCode: 'user_no_email',
    });
  });

  it('never trusts client plan/amount: inserts server-authoritative plan, purchase_type and amount', async () => {
    db.state.resolve = resolveForIntentAndClaim(intentRow({ amount_inr: 100 }));
    await submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_claim_reviews'));
    expect(insert).toBeDefined();
    expect(String(insert!.params[0])).toMatch(/^mcl_/);
    expect(insert!.params[1]).toBe(USER);
    expect(insert!.params[2]).toBe('u1@codeconclave.dev');
    expect(insert!.params[3]).toBe('pin_1');
    expect(insert!.params[4]).toBe('api');
    expect(insert!.params[5]).toBe('api_access');
    expect(insert!.params[6]).toBe(9999);
    expect(insert!.params[7]).toBe('pay_abcdefgh');
  });

  it('maps a duplicate razorpay payment id to payment_id_already_claimed', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_intents WHERE id') && text.includes('owner_id')) return { rows: [intentRow()] };
      if (text.startsWith('SELECT email FROM users')) return { rows: [{ email: 'u1@codeconclave.dev' }] };
      if (text.startsWith('INSERT INTO payment_claim_reviews')) {
        return { throw: { code: '23505', constraint: 'payment_claim_reviews_razorpay_payment_id_key' } };
      }
      return null;
    };
    await expect(submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh')).rejects.toMatchObject({
      errorCode: 'payment_id_already_claimed',
    });
  });

  it('maps a second pending claim for the same user/intent to claim_pending_exists', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_intents WHERE id') && text.includes('owner_id')) return { rows: [intentRow()] };
      if (text.startsWith('SELECT email FROM users')) return { rows: [{ email: 'u1@codeconclave.dev' }] };
      if (text.startsWith('INSERT INTO payment_claim_reviews')) {
        return { throw: { code: '23505', constraint: 'uq_payment_claim_reviews_user_pending' } };
      }
      return null;
    };
    await expect(submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh')).rejects.toMatchObject({
      errorCode: 'claim_pending_exists',
    });
  });

  it('submits inside withTenant, records the audit and returns the view with the intent reference', async () => {
    db.state.resolve = resolveForIntentAndClaim();
    const view = await submitPaymentClaim(USER, 'pin_1', 'pay_abcdefgh');
    expect(view).toMatchObject({
      planId: 'api',
      purchaseType: 'api_access',
      amountInr: 9999,
      status: 'PENDING',
      source: 'manual',
      razorpayPaymentId: 'pay_abcdefgh',
      reference: 'CCAPI-ABC123',
      intentId: 'pin_1',
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.claim.submitted', tenantId: USER, detail: expect.objectContaining({ plan: 'api', paymentId: 'pay_abcdefgh' }) }),
    );
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_claim_reviews')).length).toBe(1);
  });
});

describe('listClaims / getClaim — owner scoping', () => {
  it('lists the user claim history with its intent reference', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE user_id')) return { rows: [claimRow()] };
      if (text.startsWith('SELECT reference FROM payment_intents')) return { rows: [{ reference: 'CCAPI-ABC123' }] };
      return null;
    };
    const claims = await listUserClaims(USER);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.reference).toBe('CCAPI-ABC123');
  });

  it('getUserClaim is owner-scoped: another user gets 404', async () => {
    db.state.resolve = () => ({ rows: [] });
    await expect(getUserClaim('usr_other', 'mcl_1')).rejects.toMatchObject({ status: 404, errorCode: 'not_found' });
  });

  it('getUserClaim returns the claim for its owner', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE id') && text.includes('user_id')) return { rows: [claimRow()] };
      if (text.startsWith('SELECT reference FROM payment_intents')) return { rows: [{ reference: 'CCAPI-ABC123' }] };
      return null;
    };
    const claim = await getUserClaim(USER, 'mcl_1');
    expect(claim.id).toBe('mcl_1');
  });
});

describe('approveClaim — transactional exactly-once activation', () => {
  function approveResolve(overrides: {
    intent?: Record<string, unknown>;
    claim?: Partial<PaymentClaimRow>;
    intentRows?: unknown[];
    claimUpdateRowCount?: number;
    decidedRow?: Partial<PaymentClaimRow>;
  } = {}) {
    return (text: string) => {
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE id') && text.includes('FOR UPDATE')) {
        return { rows: [claimRow(overrides.claim ?? {})] };
      }
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE id')) {
        return { rows: [claimRow(overrides.decidedRow ?? { status: 'APPROVED', decided_by: ADMIN, decided_at: new Date() })] };
      }
      if (text.startsWith('SELECT * FROM payment_intents WHERE id') && text.includes('owner_id')) {
        return { rows: overrides.intent ? [overrides.intent] : (overrides.intentRows ?? [intentRow()]) };
      }
      if (text.startsWith('UPDATE payment_claim_reviews')) {
        return { rows: [], rowCount: overrides.claimUpdateRowCount ?? 1 };
      }
      if (text.startsWith('UPDATE payment_intents')) return { rows: [] };
      return null;
    };
  }

  it('delegates activation + flips intent and claim in ONE owner-bypass transaction', async () => {
    db.state.resolve = approveResolve();
    const view = await approveClaim(ADMIN, 'mcl_1');
    expect(view.status).toBe('APPROVED');
    expect(activateEntitlement).toHaveBeenCalledWith(USER, 'api', 'mcl_1', expect.any(Object));
    const intentFlip = db.state.calls.find((c) => c.text.startsWith('UPDATE payment_intents'));
    expect(intentFlip).toBeDefined();
    expect(String(intentFlip!.text)).toContain("status = 'ACTIVE'");
    const claimFlip = db.state.calls.find((c) => c.text.startsWith('UPDATE payment_claim_reviews'));
    expect(claimFlip!.params[1]).toBe(ADMIN);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.claim.approved', actorUserId: ADMIN, resourceId: 'mcl_1' }),
    );
    expect(notify).toHaveBeenCalledWith(USER, expect.anything(), expect.stringContaining('activated'), expect.anything());
  });

  it('also flips REVIEW intents to ACTIVE', async () => {
    db.state.resolve = approveResolve({ intent: intentRow({ status: 'REVIEW' }) });
    await approveClaim(ADMIN, 'mcl_1');
    const intentFlip = db.state.calls.find((c) => c.text.startsWith('UPDATE payment_intents'));
    expect(intentFlip).toBeDefined();
  });

  it('refuses a claim that is no longer PENDING', async () => {
    db.state.resolve = approveResolve({ claim: { status: 'APPROVED' } });
    await expect(approveClaim(ADMIN, 'mcl_1')).rejects.toMatchObject({ errorCode: 'claim_not_pending' });
    expect(activateEntitlement).not.toHaveBeenCalled();
  });

  it('rolls back (no activation, no audit) when the intent is missing', async () => {
    db.state.resolve = approveResolve({ intentRows: [] });
    await expect(approveClaim(ADMIN, 'mcl_1')).rejects.toMatchObject({ errorCode: 'claim_intent_missing' });
    expect(activateEntitlement).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('rejects a product mismatch between claim and intent (never trusts stored purchase label)', async () => {
    db.state.resolve = approveResolve({ intent: intentRow({ plan_id: 'team', purchase_type: 'team', amount_inr: 4999 }) });
    await expect(approveClaim(ADMIN, 'mcl_1')).rejects.toMatchObject({ errorCode: 'claim_plan_mismatch' });
    expect(activateEntitlement).not.toHaveBeenCalled();
  });

  it('rejects an amount that does not match the authorized plan price', async () => {
    db.state.resolve = approveResolve({ claim: { amount_inr: 123 } });
    await expect(approveClaim(ADMIN, 'mcl_1')).rejects.toMatchObject({ errorCode: 'claim_amount_mismatch' });
    expect(activateEntitlement).not.toHaveBeenCalled();
  });

  it('loses the race when a concurrent admin already decided (conditional UPDATE), aborting activation', async () => {
    db.state.resolve = approveResolve({ claimUpdateRowCount: 0 });
    await expect(approveClaim(ADMIN, 'mcl_1')).rejects.toMatchObject({ errorCode: 'claim_race' });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('rejectClaim — never touches entitlement or intent', () => {
  it('requires a rejection reason', async () => {
    await expect(rejectClaim(ADMIN, 'mcl_1', '  ')).rejects.toMatchObject({ errorCode: 'rejection_reason_required' });
  });

  it('flips to REJECTED with reason only; no activation and no intent write', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE id') && text.includes('FOR UPDATE')) return { rows: [claimRow()] };
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE id')) {
        return { rows: [claimRow({ status: 'REJECTED', rejection_reason: 'No matching payment seen at the provider', decided_by: ADMIN, decided_at: new Date() })] };
      }
      if (text.startsWith('UPDATE payment_claim_reviews')) return { rows: [] };
      return null;
    };
    const view = await rejectClaim(ADMIN, 'mcl_1', 'No matching payment seen at the provider');
    expect(view.status).toBe('REJECTED');
    expect(view.rejectionReason).toBe('No matching payment seen at the provider');
    expect(activateEntitlement).not.toHaveBeenCalled();
    expect(db.state.calls.some((c) => c.text.startsWith('UPDATE payment_intents'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.claim.rejected', actorUserId: ADMIN }),
    );
    expect(notify).toHaveBeenCalledWith(USER, expect.anything(), 'Payment claim not verified', expect.anything());
  });

  it('refuses a claim that is already decided', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT * FROM payment_claim_reviews WHERE id') && text.includes('FOR UPDATE')) {
        return { rows: [claimRow({ status: 'APPROVED' })] };
      }
      return null;
    };
    await expect(rejectClaim(ADMIN, 'mcl_1', 'nope')).rejects.toMatchObject({ errorCode: 'claim_not_pending' });
  });
});

describe('listClaimInbox — admin review queue', () => {
  it('applies the status filter, returns owner email and total count', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT cr.*')) return { rows: [claimRow()] };
      if (text.startsWith('SELECT count(*)')) return { rows: [{ n: 7 }] };
      return null;
    };
    const { claims, total } = await listClaimInbox({ status: 'PENDING' });
    expect(total).toBe(7);
    expect(claims[0]).toMatchObject({ email: 'u1@codeconclave.dev', status: 'PENDING', planId: 'api' });
    const select = db.state.calls.find((c) => c.text.startsWith('SELECT cr.*'));
    expect(select!.params[0]).toBe('PENDING');
  });

  it('clamps limit/offset and lists without a filter when status is unknown', async () => {
    db.state.resolve = (text) => {
      if (text.startsWith('SELECT cr.*')) return { rows: [] };
      if (text.startsWith('SELECT count(*)')) return { rows: [{ n: 0 }] };
      return null;
    };
    const { total } = await listClaimInbox({ status: 'NOT_A_STATUS', limit: 9999, offset: -5 });
    expect(total).toBe(0);
    const select = db.state.calls.find((c) => c.text.startsWith('SELECT cr.*'));
    expect(select!.params).toEqual([100, 0]);
  });
});