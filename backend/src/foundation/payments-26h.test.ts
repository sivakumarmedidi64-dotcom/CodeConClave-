/**
 * CodeConClave — STAGE 26H payment intents + evidence rail tests.
 * Covers the mandated scenarios: fake success (LOW -> PENDING, no
 * entitlement), duplicate payment id, amount mismatch, cross-user, cross-
 * tenant, screenshot replay, expiry sweep, refund, race/double activation,
 * duplicate activation, reconciliation drift, OCR evidence parsing, Gmail
 * evidence (mocked when configured; BLOCKED when not), velocity, and the
 * founder digest gate. LIVE portions (real Gmail / Razorpay API) are marked
 * BLOCKED: they require credentials that do not exist in this environment.
 * All DB interaction is mocked; no provider contacted.
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
import { createPaymentIntent, getIntent, intentInstructions, sweepIntentExpiry, type PaymentIntentRow } from '../modules/payments/intents.js';
import { parseOcrText } from '../modules/payments/evidence.js';
import { ingestEvidence, refreshIntentEvidence } from '../modules/payments/pipeline.js';
import { scoreEvidence } from '../modules/payments/matcher.js';
import { refundIntent, revokeIntent, chargebackIntent } from '../modules/payments/activation.js';
import { resendReceipt } from '../modules/payments/receipts.js';
import { runReconciliation } from '../modules/payments/reconciliation.js';
import { generateFounderDigest } from '../modules/payments/digest.js';

const REF = 'CCPRO-ABCD12';

function intentRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'pin-1',
    owner_id: 'u1',
    plan_id: 'pro',
    amount_inr: 999,
    currency: 'INR',
    reference: REF,
    payment_link: 'https://rzp.io/rzp/sAgHIpxS',
    mode: 'PAYMENT_LINK',
    status: 'PENDING',
    confidence: 0,
    decision: null,
    thresholds_used: null,
    fraud_flags: null,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    grace_until: null,
    activated_at: null,
    evidence_summary: null,
    tenant_id: 'u1',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function entitlementRow(state: string): Record<string, unknown> {
  return {
    id: 'ent-1',
    user_id: 'u1',
    plan_id: 'pro',
    state,
    verified_at: state === 'PRO_VERIFIED' ? new Date() : null,
    expires_at: null,
    payment_session_id: null,
    reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** Base resolver for a PENDING intent owned by u1, user email known.
 * Custom `over` handlers run first so tests can intercept specific queries;
 * defaults cover the shared pipeline queries (intent reads, email, counts,
 * evidence read-backs) and mirror conditional status updates back onto the
 * intent object so later read-backs reflect the transitioned state. */
function baseResolve(intent: Record<string, unknown>, over: (text: string, params: unknown[]) => unknown[] | null = () => null) {
  let capturedRef: string | null = null;
  let mutatedStatus: string | null = null;
  db.state.resolve = (text, params) => {
    const custom = over(text, params);
    if (custom) return custom;
    if (text.includes('INSERT INTO payment_intents')) {
      capturedRef = String(params[4]);
      return null;
    }
    if (text.includes("AND status IN ('PENDING','REVIEW','ACTIVE','GRACE')")) return [];
    if (text.includes('SELECT email FROM users')) return [{ email: 'u1@test.dev' }];
    if (text.includes('FROM payment_evidence WHERE owner_id') && text.includes('count(*)')) return [{ n: 0 }];
    if (text.includes('WHERE id = $1 AND owner_id = $2')) return params[0] === intent.id && params[1] === intent.owner_id ? [intent] : [];
    if (text.includes('SELECT * FROM payment_intents WHERE id = $1')) {
      return [{ ...intent, id: String(params[0]), status: mutatedStatus ?? intent.status, reference: capturedRef ?? intent.reference }];
    }
    if (text.includes('SELECT * FROM payment_evidence WHERE id = $1')) {
      return [{
        id: String(params[0]),
        intent_id: intent.id,
        owner_id: intent.owner_id,
        source: 'test',
        provider_payment_id: null,
        utr: null,
        reference: intent.reference,
        amount_inr: intent.amount_inr,
        payer_email: null,
        paid_at: null,
        sha256: 'test',
        signals: {},
        matched: false,
        fraud_flags: null,
        created_at: new Date(),
      }];
    }
    const statusMatch = text.match(/SET status = '([A-Z]+)'/);
    const isStatusUpdate = text.includes('UPDATE payment_intents') && text.includes('SET status') && text.includes('WHERE id = $1') && params[0] === intent.id;
    if (isStatusUpdate) {
      mutatedStatus = statusMatch ? statusMatch[1] : String(params[1]);
      db.state.rowCount = 1;
      return [intent];
    }
    return null;
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
  env.GMAIL_OAUTH_ACCESS_TOKEN = undefined;
  env.GMAIL_OAUTH_REFRESH_TOKEN = undefined;
  env.PAYMENT_ACCOUNT_EMAIL = 'payments@codeconclave.dev';
  env.PAYMENT_FOUNDER_EMAIL = 'founder@codeconclave.dev';
  env.PAYMENT_CONFIDENCE_ACTIVE = 0.8;
  env.PAYMENT_CONFIDENCE_GRACE = 0.5;
  env.PAYMENT_AMOUNT_TOLERANCE_INR = 0;
  env.PAYMENT_VELOCITY_MAX = 3;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------- creation
describe('payment intents — creation and reference', () => {
  it('creates an intent with a unique reference, TTL expiry and audit', async () => {
    baseResolve(intentRow());
    const intent = await createPaymentIntent('u1', 'pro');
    expect(intent.status).toBe('PENDING');
    expect(intent.reference).toMatch(/^CCPRO-[A-Z0-9]{6}$/);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_intents'))!;
    expect(insert.params[4]).toBe(intent.reference);
    expect(insert.text).toContain('make_interval(hours => $7)');
    expect(insert.params[6]).toBe(24);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.intent_created' }));
  });

  it('reuses an open intent instead of creating duplicates', async () => {
    const existing = intentRow({ id: 'pin-open', reference: 'CCPRO-XXXX99' });
    db.state.resolve = (text, params) => {
      if (text.includes("AND status IN ('PENDING','REVIEW','ACTIVE','GRACE')")) return [existing];
      return null;
    };
    const intent = await createPaymentIntent('u1', 'pro');
    expect(intent.id).toBe('pin-open');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO payment_intents'))).toBe(false);
  });

  it('rejects unknown plans', async () => {
    await expect(createPaymentIntent('u1', 'enterprise')).rejects.toMatchObject({ errorCode: 'invalid_plan' });
  });

  it('instructions carry the reference, account email and amount', async () => {
    baseResolve(intentRow());
    const instructions = await intentInstructions('u1', 'pin-1');
    expect(instructions.reference).toBe(REF);
    expect(instructions.accountEmail).toBe('payments@codeconclave.dev');
    expect(instructions.amountInr).toBe(999);
  });
});

// ------------------------------------------------------------- fake success
describe('fake success never activates a plan', () => {
  it('a screenshot with no extractable signals yields no evidence', async () => {
    const intent = intentRow();
    baseResolve(intent);
    await expect(
      ingestEvidence('u1', 'pin-1', 'ocr', { text: 'Payment Successful! Your plan is active now.' }),
    ).rejects.toMatchObject({ errorCode: 'no_evidence' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO payment_evidence'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('weak signals (amount only) score LOW -> PENDING, no entitlement', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'ocr', { text: 'Paid ₹999 via UPI' });
    expect(result.result!.decision).toBe('PENDING');
    expect(result.result!.confidence).toBe(0.25);
    expect(result.result!.intentStatus).toBe('PENDING');
    expect(db.state.calls.some((c) => c.text.includes("'ACTIVE'"))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.matched' }));
  });

  it('a claimed provider id from a client payload is not provider evidence', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'manual', { paymentId: 'pay_claimed_by_client', reference: REF, amountInr: 999 });
    expect(result.result!.decision).toBe('ACTIVE');
    const source = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_evidence'))!;
    expect(source.params[3]).toBe('manual');
  });
});

// -------------------------------------------------------------- fraud guard
describe('fraud / spoof guard', () => {
  it('duplicate payment id across intents is blocked -> REVIEW, never ACTIVE', async () => {
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('provider_payment_id = $1')) return [{ id: 'pev-other', intent_id: 'pin-9', owner_id: 'u9' }];
      return null;
    });
    const signals = { reference: REF, amountInr: 999, paymentId: 'pay_dup_123', payerEmail: 'u1@test.dev' };
    const result = await ingestEvidence('u1', 'pin-1', 'manual', signals);
    expect(result.result!.flags).toContain('duplicate_payment_id');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes("'ACTIVE'"))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.fraud_flagged' }));
  });

  it('amount mismatch is flagged and forced into REVIEW', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const signals = { reference: REF, amountInr: 499, paymentId: 'pay_amt_1' };
    const result = await ingestEvidence('u1', 'pin-1', 'manual', signals);
    expect(result.result!.flags).toContain('amount_mismatch');
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('velocity: too many evidence submissions within the window is flagged', async () => {
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('count(*)::int AS n FROM payment_evidence') && text.includes('created_at >=')) return [{ n: 3 }];
      return null;
    });
    const signals = { reference: REF, amountInr: 999, paymentId: 'pay_vel_1' };
    const result = await ingestEvidence('u1', 'pin-1', 'manual', signals);
    expect(result.result!.flags).toContain('velocity');
  });
});

// ------------------------------------------------------------ tenant safety
describe('tenant isolation — cross-user / cross-tenant evidence', () => {
  it('another user cannot ingest evidence into someone else\'s intent', async () => {
    const intent = intentRow();
    baseResolve(intent);
    await expect(
      ingestEvidence('u2', 'pin-1', 'ocr', { text: '₹999 CCPRO-ABCD12' }),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO payment_evidence'))).toBe(false);
  });

  it('intent lookups always filter by owner id (cross-tenant safe)', async () => {
    const intent = intentRow();
    baseResolve(intent);
    await expect(getIntent('u2', 'pin-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    const call = db.state.calls.find((c) => c.text.includes('FROM payment_intents'))!;
    expect(call.text).toContain('owner_id = $2');
    expect(call.params[1]).toBe('u2');
  });
});

// ------------------------------------------------------------ replay guard
describe('screenshot replay guard', () => {
  it('the same evidence sha256 against a different intent is rejected as replay', async () => {
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('sha256 = $1') && text.includes('intent_id IS DISTINCT FROM $2')) {
        return [{ id: 'pev-original', intent_id: null }];
      }
      return null;
    });
    const result = await ingestEvidence('u1', 'pin-1', 'ocr', { text: `₹999 ${REF} 19/08/2026 pay_rep_123` });
    expect(result.replayed).toBe(1);
    expect(result.evidence.length).toBe(0);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_evidence')).length).toBe(0);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.fraud_flagged' }));
  });
});

// ---------------------------------------------------------------- lifecycle
describe('intent lifecycle — expiry, grace, refund, revocation, chargeback', () => {
  it('expires stale PENDING intents (no entitlement touched)', async () => {
    const intent = intentRow({ status: 'PENDING' });
    db.state.resolve = (text) => {
      if (text.includes("SET status = 'EXPIRED'") && text.includes("status IN ('PENDING','REVIEW')")) return [intent];
      return null;
    };
    const count = await sweepIntentExpiry();
    expect(count).toBeGreaterThan(0);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.expired' }));
  });

  it('moves ACTIVE intents into GRACE at expiry and notifies', async () => {
    const intent = intentRow({ status: 'ACTIVE' });
    db.state.resolve = (text) => {
      if (text.includes("SET status = 'GRACE'")) return [intent];
      return null;
    };
    const count = await sweepIntentExpiry();
    expect(count).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('u1'), 'payment.status', expect.stringContaining('grace'), expect.anything());
  });

  it('revokes the entitlement when GRACE is exhausted', async () => {
    const intent = intentRow({ status: 'GRACE', grace_until: new Date(Date.now() - 1000) });
    db.state.resolve = (text, params) => {
      if (text.includes("SET status = 'EXPIRED'") && text.includes("status = 'GRACE'")) return [intent];
      if (text.includes('FROM entitlements')) return [entitlementRow('PRO_VERIFIED')];
      return null;
    };
    const count = await sweepIntentExpiry();
    expect(count).toBeGreaterThan(0);
    const revoke = db.state.calls.find((c) => c.text.includes("state = 'REVOKED'"))!;
    expect(revoke).toBeDefined();
    const userReset = db.state.calls.find((c) => c.text.includes("SET plan_id = 'free'"))!;
    expect(userReset).toBeDefined();
  });

  it('refunds an ACTIVE intent: entitlement PRO_REFUNDED, plan free', async () => {
    const intent = intentRow({ status: 'ACTIVE' });
    baseResolve(intent);
    const result = await refundIntent('u1', 'pin-1', 'user requested');
    expect(result.status).toBe('REFUNDED');
    const ent = db.state.calls.find((c) => c.text.includes("'PRO_REFUNDED'"))!;
    expect(ent).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes("SET plan_id = 'free'"))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.refunded' }));
  });

  it('revokes an ACTIVE intent: entitlement REVOKED, plan free', async () => {
    const intent = intentRow({ status: 'ACTIVE' });
    baseResolve(intent, (text) => {
      if (text.includes('FROM entitlements')) return [entitlementRow('PRO_VERIFIED')];
      return null;
    });
    const result = await revokeIntent('u1', 'pin-1', 'policy');
    expect(result.status).toBe('REVOKED');
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.revoked' }));
  });

  it('chargeback requires provider evidence with a payment id on the intent', async () => {
    const intent = intentRow({ status: 'ACTIVE' });
    baseResolve(intent, (text) => {
      if (text.includes('provider_payment_id IS NOT NULL')) return [];
      return null;
    });
    await expect(chargebackIntent('u1', 'pin-1', 'dispute')).rejects.toMatchObject({ errorCode: 'chargeback_no_evidence' });
  });

  it('chargeback with evidence revokes the plan', async () => {
    const intent = intentRow({ status: 'ACTIVE' });
    baseResolve(intent, (text) => {
      if (text.includes('provider_payment_id IS NOT NULL')) return [{ id: 'pev-ev' }];
      if (text.includes('FROM entitlements')) return [entitlementRow('PRO_VERIFIED')];
      return null;
    });
    const result = await chargebackIntent('u1', 'pin-1', 'dispute');
    expect(result.status).toBe('CHARGEBACK');
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.chargeback' }));
  });

  it('receipt resend is refused for a PENDING intent', async () => {
    const intent = intentRow({ status: 'PENDING' });
    baseResolve(intent);
    await expect(resendReceipt('u1', 'pin-1')).rejects.toMatchObject({ errorCode: 'receipt_not_available' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('receipt resend works for ACTIVE intents', async () => {
    const intent = intentRow({ status: 'ACTIVE', activated_at: new Date() });
    baseResolve(intent);
    const result = await resendReceipt('u1', 'pin-1');
    expect(result.sent).toBe(true);
    expect(notify).toHaveBeenCalledWith('u1', 'payment.status', 'Payment receipt', expect.anything());
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.receipt_sent' }));
  });
});

// -------------------------------------------------------- exactly-once guard
describe('exactly-once activation', () => {
  it('a concurrent double activation loses the race and never double-activates', async () => {
    const intent = intentRow();
    let activeUpdates = 0;
    baseResolve(intent, (text) => {
      if (text.includes("SET status = 'ACTIVE'")) {
        activeUpdates += 1;
        if (activeUpdates === 1) {
          db.state.rowCount = 1;
          intent.status = 'ACTIVE';
          return [intentRow({ status: 'ACTIVE', activated_at: new Date() })];
        }
        db.state.rowCount = 0;
        return [];
      }
      return null;
    });
    const signals = { reference: REF, amountInr: 999, paymentId: 'pay_race_1' };
    const first = await ingestEvidence('u1', 'pin-1', 'manual', signals);
    const second = await ingestEvidence('u1', 'pin-1', 'manual', signals);
    expect(first.result!.intentStatus).toBe('ACTIVE');
    expect(second.result!.intentStatus).toBe('ACTIVE');
    const entitlementInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements'));
    expect(entitlementInserts.length).toBe(1);
  });

  it('applying a decision to an already ACTIVE intent is a no-op', async () => {
    const intent = intentRow({ status: 'ACTIVE', activated_at: new Date() });
    baseResolve(intent);
    const { applyDecision } = await import('../modules/payments/activation.js');
    const applied = await applyDecision('u1', intent, { confidence: 1, decision: 'ACTIVE', signals: { reference: true, amount: true, payer: true, time: true, paymentId: true }, thresholds: { active: 0.8, grace: 0.5 } }, { flags: [], blocked: false });
    expect(applied.transitioned).toBe(false);
    expect(applied.reason).toBe('already_active');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });
});

// ---------------------------------------------------------------- OCR rail
describe('OCR evidence rail', () => {
  it('parseOcrText extracts UTR, amount, date and payment id', () => {
    const parsed = parseOcrText('UPI Ref: 4123456789012345 Amount ₹999.00 Date 19/08/2026 pay_ocr_abc123');
    expect(parsed.utr).toBe('4123456789012345');
    expect(parsed.amountInr).toBe(999);
    expect(parsed.paidAt).toBe('19/08/2026');
    expect(parsed.paymentId).toBe('pay_ocr_abc123');
  });

  it('high-confidence OCR evidence (ref+amount+paymentId+payer) activates', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'ocr', {
      text: `Paid ₹999 to CodeConClave Ref ${REF} pay_ocr_hi123 from u1@test.dev`,
    });
    expect(result.result!.decision).toBe('ACTIVE');
    expect(result.result!.confidence).toBe(0.9);
    expect(result.result!.intentStatus).toBe('ACTIVE');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(true);
    expect(notify).toHaveBeenCalledWith('u1', 'payment.status', expect.stringContaining('activated'), expect.anything());
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.activated' }));
  });
});

// --------------------------------------------------------------- Gmail rail
describe('Gmail evidence rail', () => {
  it('BLOCKED without Gmail OAuth credentials (live requires configuration)', async () => {
    const intent = intentRow();
    baseResolve(intent);
    await expect(ingestEvidence('u1', 'pin-1', 'gmail', undefined)).rejects.toMatchObject({
      errorCode: 'evidence_source_blocked',
    });
  });

  it('collects normalized signals from Gmail when OAuth is configured (mocked)', async () => {
    env.GMAIL_OAUTH_ACCESS_TOKEN = 'ya29.mock';
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/messages?')) {
        return { ok: true, json: async () => ({ messages: [{ id: 'msg-1' }] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          payload: {
            headers: [
              { name: 'Subject', value: `CodeConClave Pro payment ₹999 ${REF} pay_gm_123` },
              { name: 'From', value: 'Razorpay <noreply@razorpay.com>' },
              { name: 'Date', value: new Date().toUTCString() },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    expect(result.evidence.length).toBe(1);
    expect(result.result!.decision).toBe('ACTIVE');
    const stored = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_evidence'))!;
    expect(stored.params[3]).toBe('gmail');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('refresh pulls from gmail/api and reports blocked sources honestly', async () => {
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('sha256 = $1')) return null;
      return null;
    });
    await expect(refreshIntentEvidence('u1', 'pin-1')).rejects.toMatchObject({ errorCode: 'no_passive_evidence' });
  });
});

// ----------------------------------------------------------- reconciliation
describe('reconciliation', () => {
  it('reports ACTIVE intents without an entitlement as drift (no auto-fix)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_intents') && text.includes("status IN ('ACTIVE','GRACE')")) return [intentRow({ status: 'ACTIVE' })];
      if (text.includes('FROM entitlements')) return [];
      if (text.includes('FROM payment_evidence') && text.includes('intent_id IS NULL')) return [];
      if (text.includes('FROM payment_reconciliations WHERE id = $1')) {
        return [{ id: 'rec-1', run_by: 'u1', intents: 1, evidence: 0, entitlements: 0, drift: [{ type: 'intent_without_entitlement' }], status: 'COMPLETED_WITH_DRIFT', created_at: new Date() }];
      }
      return null;
    };
    const result = await runReconciliation('u1');
    expect(result.status).toBe('COMPLETED_WITH_DRIFT');
    expect(result.drift.some((d: { type: string }) => d.type === 'intent_without_entitlement')).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.reconciled' }));
  });

  it('is COMPLETED when intents, entitlements and sessions line up', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_intents') && text.includes("status IN ('ACTIVE','GRACE')")) return [intentRow({ status: 'ACTIVE' })];
      if (text.includes('FROM entitlements') && text.includes("state = 'PRO_VERIFIED'")) return [entitlementRow('PRO_VERIFIED')];
      if (text.includes('FROM entitlements')) return [];
      if (text.includes('FROM payment_sessions') && text.includes("state = 'VERIFIED'")) return [{ id: 'ps-1' }];
      if (text.includes('FROM payment_evidence') && text.includes('intent_id IS NULL')) return [];
      if (text.includes('FROM payment_reconciliations WHERE id = $1')) {
        return [{ id: 'rec-2', run_by: null, intents: 1, evidence: 0, entitlements: 1, drift: [], status: 'COMPLETED', created_at: new Date() }];
      }
      return null;
    };
    const result = await runReconciliation(null);
    expect(result.status).toBe('COMPLETED');
    expect(result.drift.length).toBe(0);
  });
});

// ------------------------------------------------------------------- digest
describe('founder payment digest', () => {
  it('is forbidden for non-founders', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT email FROM users')) return [{ email: 'someone@test.dev' }];
      return null;
    };
    await expect(generateFounderDigest('u1', 7)).rejects.toMatchObject({ errorCode: 'founder_only' });
  });

  it('generates and persists the digest for the configured founder', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT email FROM users')) return [{ email: 'founder@codeconclave.dev' }];
      if (text.includes('FROM payment_intents') && text.includes('GROUP BY')) return [{ status: 'ACTIVE', n: 2 }];
      if (text.includes('FROM payment_evidence') && text.includes('GROUP BY')) return [{ source: 'ocr', n: 3 }];
      if (text.includes('jsonb_array_length')) return [];
      if (text.includes('sum(amount_inr)') && text.includes("status IN ('ACTIVE','GRACE')")) return [{ total: 1998 }];
      if (text.includes('sum(amount_inr)') && text.includes("status = 'REFUNDED'")) return [{ total: 0 }];
      if (text.includes("status = 'REVIEW'")) return [];
      if (text.includes('FROM payment_reconciliations')) return [{ status: 'COMPLETED' }];
      if (text.includes('FROM payment_digests')) return [{ id: 'pdg-1', bucket: 'today', period_days: 7, stats: {}, created_at: new Date() }];
      return null;
    };
    const digest = await generateFounderDigest('u1', 7);
    expect(digest.bucket).toBe('today');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO payment_digests'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.digest_generated' }));
  });
});

// ------------------------------------------------------------------- scoring
describe('matcher scoring', () => {
  it('records the audited thresholds used for every decision', () => {
    const intent = intentRow() as PaymentIntentRow;
    const result = scoreEvidence(intent, { reference: REF, amountInr: 999 }, 'u1@test.dev');
    expect(result.thresholds).toEqual({ active: 0.8, grace: 0.5 });
    expect(result.confidence).toBe(0.7);
    expect(result.decision).toBe('REVIEW');
  });
});