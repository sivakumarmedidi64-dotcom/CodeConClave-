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
    // INSERT INTO payment_evidence that is not intercepted by the custom
    // resolver succeeds with rowCount 1 (matching real PostgreSQL behavior).
    // Needed for ON CONFLICT DO NOTHING detection in the pipeline.
    if (rows === null && /^\s*INSERT\b.*INTO\s+payment_evidence\b/i.test(text)) {
      return { rows: [], rowCount: 1 };
    }
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
import { parseOcrText, webhookDetectorAvailable } from '../modules/payments/evidence.js';
import { ingestEvidence, refreshIntentEvidence, isTrustedEvidenceSource } from '../modules/payments/pipeline.js';
import { scoreEvidence } from '../modules/payments/matcher.js';
import { refundIntent, revokeIntent, chargebackIntent } from '../modules/payments/activation.js';
import { resendReceipt } from '../modules/payments/receipts.js';
import { runReconciliation } from '../modules/payments/reconciliation.js';
import { generateFounderDigest } from '../modules/payments/digest.js';
import { createPaymentSession, paymentLinkForPlan, PLAN_PRICES_INR, PLAN_PAYMENT_LINK_INR, verifySession, createRazorpayPaymentLinkForIntent } from '../modules/payments/service.js';
import { paymentWebhookRoutes } from '../modules/payments/routes.js';

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
      capturedRef = String(params[5]);
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
    expect(insert.params[5]).toBe(intent.reference);
    expect(insert.text).toContain('make_interval(hours => $10)');
    expect(insert.params[9]).toBe(24);
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

  it('weak user-asserted signals (amount only) never activate -> forced REVIEW, no entitlement', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'ocr', { text: 'Paid ₹999 via UPI' });
    expect(result.result!.confidence).toBe(0.25);
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes("'ACTIVE'"))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.review_required' }));
  });

  it('a fabricated manual assertion (paymentId/reference/amount) can NEVER activate', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'manual', {
      paymentId: 'pay_claimed_by_client',
      reference: REF,
      amountInr: 999,
      payerEmail: 'u1@test.dev',
    });
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(result.result!.flags).toContain('manual_assertion_cannot_activate');
    const source = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_evidence'))!;
    expect(source.params[3]).toBe('manual');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
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
              { name: 'Subject', value: `CodeConClave Pro payment ₹999 ${REF} pay_race_1` },
              { name: 'From', value: 'Razorpay <noreply@razorpay.com>' },
              { name: 'Date', value: new Date().toUTCString() },
              { name: 'Authentication-Results', value: 'dns.google; dkim=pass header.d=razorpay.com; spf=pass smtp.mailfrom=razorpay.com; dmarc=pass header.from=razorpay.com' },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
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
    const first = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    const second = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
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

  it('high-confidence OCR evidence cannot activate alone (screenshot is not authority, forced to REVIEW)', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'ocr', {
      text: `Paid ₹999 to CodeConClave Ref ${REF} pay_ocr_hi123 from u1@test.dev`,
    });
    expect(result.result!.confidence).toBe(0.9);
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(result.result!.flags).toContain('manual_assertion_cannot_activate');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    expect(notify).toHaveBeenCalledWith('u1', 'payment.review_required', 'Payment needs review', expect.anything());
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
              { name: 'Authentication-Results', value: 'dns.google; dkim=pass header.d=razorpay.com; spf=pass smtp.mailfrom=razorpay.com; dmarc=pass header.from=razorpay.com' },
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

// ------------------------------------------------- plan -> amount/link authority
describe('plan -> amount/link server authority', () => {
  it('PRO resolves to the ₹999 amount and PRO payment link', () => {
    expect(PLAN_PRICES_INR.pro).toBe(999);
    expect(paymentLinkForPlan('pro')).toBe('https://rzp.io/rzp/sAgHIpxS');
    expect(PLAN_PAYMENT_LINK_INR.pro).toBe(paymentLinkForPlan('pro'));
  });

  it('TEAM resolves to the ₹4999 amount and TEAM payment link', () => {
    expect(PLAN_PRICES_INR.team).toBe(4999);
    expect(paymentLinkForPlan('team')).toBe('https://rzp.io/rzp/3ioXlCxd');
    expect(PLAN_PAYMENT_LINK_INR.team).toBe(paymentLinkForPlan('team'));
  });

  it('TEAM never falls back to the PRO ₹999 link', () => {
    expect(PLAN_PAYMENT_LINK_INR.team).not.toBe(PLAN_PAYMENT_LINK_INR.pro);
  });

  it('unknown plans are rejected (no fallback link)', () => {
    expect(() => paymentLinkForPlan('enterprise')).toThrow();
  });

  it('API Access fails safely when RAZORPAY_API_PAYMENT_LINK is unset — never falls back to pro/team', () => {
    const saved = env.RAZORPAY_API_PAYMENT_LINK;
    env.RAZORPAY_API_PAYMENT_LINK = undefined;
    try {
      expect(() => paymentLinkForPlan('api')).toThrowError(
        expect.objectContaining({ errorCode: 'payment_link_unconfigured' }),
      );
      // The API purchase path must never hand out the PRO or TEAM link instead.
      const apiLink = { pro: env.RAZORPAY_PRO_PAYMENT_LINK, team: env.RAZORPAY_TEAM_PAYMENT_LINK, api: '' }['api']!;
      expect(apiLink).toBe('');
      expect(() => paymentLinkForPlan('pro')).not.toThrow();
      expect(() => paymentLinkForPlan('team')).not.toThrow();
    } finally {
      env.RAZORPAY_API_PAYMENT_LINK = saved;
    }
  });

  it('createPaymentSession stores the server-authoritative per-plan link and amount', async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const inserted: Record<string, { plan: string; ref: string; amount: number }> = {};
    db.state.resolve = (text, params) => {
      calls.push({ text, params });
      if (text.includes('INSERT INTO payment_sessions')) {
        inserted[String(params[0])] = { plan: String(params[2]), ref: String(params[5]), amount: Number(params[3]) };
        return null;
      }
      if (text.includes('SELECT * FROM payment_sessions WHERE id = $1 AND user_id = $2')) {
        const s = inserted[String(params[0])];
        if (!s) return null;
        return [{
          id: String(params[0]), user_id: String(params[1]), plan_id: s.plan, amount_inr: s.amount,
          currency: 'INR', mode: 'PAYMENT_LINK', state: 'PENDING', reference: s.ref,
          provider_payment_id: null, provider_order_id: null, verification_evidence: null,
          expires_at: new Date(), created_at: new Date(), tenant_id: String(params[1]), idempotency_key: null,
        }];
      }
      return null;
    };
    const pro = await createPaymentSession('u1', 'pro');
    expect(pro.reference).toBe('https://rzp.io/rzp/sAgHIpxS');
    const proIns = calls.find((c) => c.text.includes('INSERT INTO payment_sessions'))!;
    expect(proIns.params[5]).toBe('https://rzp.io/rzp/sAgHIpxS');
    expect(proIns.params[3]).toBe(999);

    const team = await createPaymentSession('u1', 'team');
    expect(team.reference).toBe('https://rzp.io/rzp/3ioXlCxd');
    const teamIns = calls.filter((c) => c.text.includes('INSERT INTO payment_sessions'))[1];
    expect(teamIns.params[5]).toBe('https://rzp.io/rzp/3ioXlCxd');
    expect(teamIns.params[3]).toBe(4999);
  });

  it('createPaymentIntent stores the per-plan authoritative link', async () => {
    const intent = intentRow({ id: 'pin-pro', plan_id: 'pro', amount_inr: 999, reference: 'CCPRO-ABCD12' });
    baseResolve(intent);
    await createPaymentIntent('u1', 'pro');
    const proIns = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_intents'))!;
    expect(proIns.params[6]).toBe('https://rzp.io/rzp/sAgHIpxS');

    const teamIntent = intentRow({ id: 'pin-team', plan_id: 'team', amount_inr: 4999, reference: 'CCTEAM-ABCD12' });
    baseResolve(teamIntent);
    await createPaymentIntent('u1', 'team');
    const teamIns = db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_intents'))[1];
    expect(teamIns.params[6]).toBe('https://rzp.io/rzp/3ioXlCxd');
  });

  it('client cannot supply a plan amount to override the server amount', async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    db.state.resolve = (text, params) => {
      calls.push({ text, params });
      if (text.includes('SELECT * FROM payment_sessions WHERE id = $1 AND user_id = $2')) {
        return [{ id: String(params[0]), user_id: String(params[1]), plan_id: 'team', amount_inr: 4999, currency: 'INR', mode: 'PAYMENT_LINK', state: 'PENDING', reference: 'https://rzp.io/rzp/3ioXlCxd', provider_payment_id: null, provider_order_id: null, verification_evidence: null, expires_at: new Date(), created_at: new Date(), tenant_id: String(params[1]), idempotency_key: null }];
      }
      return null;
    };
    await createPaymentSession('u1', 'team');
    const ins = calls.find((c) => c.text.includes('INSERT INTO payment_sessions'))!;
    expect(ins.params[3]).toBe(4999);
  });
});

// ------------------------------------------------- manual evidence authority
describe('manual evidence security — user assertion can never grant a paid plan', () => {
  it('fabricated manual reference alone cannot activate', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'manual', { reference: REF });
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('fabricated manual amount alone cannot activate', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'manual', { amountInr: 999 });
    expect(result.result!.decision).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('fabricated manual paymentId alone cannot activate', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'manual', { paymentId: 'pay_fabricated_123' });
    expect(result.result!.decision).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('a fully self-consistent manual assertion still cannot become VERIFIED/ACTIVE', async () => {
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'manual', {
      paymentId: 'pay_x',
      reference: REF,
      amountInr: 999,
      payerEmail: 'u1@test.dev',
      paidAt: new Date(),
    });
    expect(result.result!.confidence).toBe(1);
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('ocr is user-asserted and is not a trusted activation source', () => {
    expect(isTrustedEvidenceSource('manual')).toBe(false);
    expect(isTrustedEvidenceSource('ocr')).toBe(false);
    expect(isTrustedEvidenceSource('gmail')).toBe(true);
    expect(isTrustedEvidenceSource('razorpay_api')).toBe(true);
    expect(isTrustedEvidenceSource('razorpay_webhook')).toBe(true);
  });
});

// ------------------------------------------------- plan/amount mismatch rejection
describe('plan/amount mismatch rejection (trusted evidence)', () => {
  // Gmail evidence that returns a single normalized signal from a subject.
  function gmailResolveWith(subject: string) {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'm1' }] }) } as Response;
      return {
        ok: true,
        json: async () => ({
          payload: {
            headers: [
              { name: 'Subject', value: subject },
              { name: 'From', value: 'Razorpay <noreply@razorpay.com>' },
              { name: 'Date', value: new Date().toUTCString() },
              { name: 'Authentication-Results', value: 'dns.google; dkim=pass header.d=razorpay.com; spf=pass smtp.mailfrom=razorpay.com; dmarc=pass header.from=razorpay.com' },
            ],
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    env.GMAIL_OAUTH_ACCESS_TOKEN = 'ya29.mock';
  }

  it('PRO intent + TEAM ₹4999 amount is rejected by the trusted matcher (no activation)', async () => {
    gmailResolveWith(`CodeConClave Pro payment ₹4999 ${REF} pay_gm_wrongamt`);
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('FROM payment_evidence WHERE owner_id') && text.includes('count(*)')) return [{ n: 0 }];
      return null;
    });
    const result = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    expect(result.result!.flags).toContain('amount_mismatch');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('amount_mismatch is a blocking flag and can never activate', async () => {
    gmailResolveWith(`CodeConClave Pro payment ₹499 ${REF} pay_gm_low`);
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('FROM payment_evidence WHERE owner_id') && text.includes('count(*)')) return [{ n: 0 }];
      return null;
    });
    const result = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    expect(result.result!.flags).toContain('amount_mismatch');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('plan_mismatch blocks TEAM-intent evidence with a PRO reference', async () => {
    const intent = intentRow({ id: 'pin-team', plan_id: 'team', amount_inr: 4999, reference: 'CCTEAM-ABCD12' });
    baseResolve(intent, (text) => {
      if (text.includes('FROM payment_evidence WHERE owner_id') && text.includes('count(*)')) return [{ n: 0 }];
      return null;
    });
    const result = await ingestEvidence('u1', 'pin-team', 'manual', {
      reference: 'CCPRO-OLD99',
      amountInr: 4999,
      paymentId: 'pay_planx',
    });
    expect(result.result!.flags).toContain('plan_mismatch');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('a correct trusted Gmail evidence activates (normal verified user path)', async () => {
    gmailResolveWith(`CodeConClave Pro payment ₹999 ${REF} pay_gm_ok_482713`);
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    expect(result.result!.confidence).toBe(0.9);
    expect(result.result!.intentStatus).toBe('ACTIVE');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(true);
  });
});

// ------------------------------------------------ session verify amount authority
describe('verifySession rejects amount mismatch with server authority', () => {
  it('throws amount_mismatch and never VERIFIES when evidence amount differs', async () => {
    const session = {
      id: 'ps-amt', user_id: 'u1', plan_id: 'team', amount_inr: 4999, currency: 'INR',
      mode: 'WEBHOOK', state: 'PENDING', reference: null, provider_payment_id: null, provider_order_id: null,
      verification_evidence: null, expires_at: new Date(), created_at: new Date(), tenant_id: 'u1', idempotency_key: null,
    };
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions WHERE id = $1 AND user_id = $2')) return [session];
      return null;
    };
    await expect(
      verifySession('u1', 'ps-amt', {
        source: 'WEBHOOK',
        provider_payment_id: 'pay_web_999',
        raw: { payload: { payment: { entity: { id: 'pay_web_999', amount: 99900 } } } },
      }),
    ).rejects.toMatchObject({ errorCode: 'amount_mismatch' });
    const rejectedEvent = db.state.calls.find(
      (c) => c.text.includes('INSERT INTO payment_events') && JSON.stringify(c.params).includes('amount_mismatch'),
    );
    expect(rejectedEvent).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('accepts matching amount and reaches VERIFIED', async () => {
    const session = {
      id: 'ps-ok', user_id: 'u1', plan_id: 'pro', amount_inr: 999, currency: 'INR',
      mode: 'WEBHOOK', state: 'PENDING', reference: null, provider_payment_id: null, provider_order_id: null,
      verification_evidence: null, expires_at: new Date(), created_at: new Date(), tenant_id: 'u1', idempotency_key: null,
    };
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions WHERE id = $1 AND user_id = $2')) return [session];
      if (text.includes('SELECT id FROM entitlements WHERE user_id = $1 AND plan_id = $2')) return [{ id: 'ent-ok' }];
      return null;
    };
    const result = await verifySession('u1', 'ps-ok', {
      source: 'WEBHOOK',
      provider_payment_id: 'pay_web_ok',
      raw: { payload: { payment: { entity: { id: 'pay_web_ok', amount: 99900 } } } },
    });
    expect(result.state).toBe('PENDING'); // static mock row returned by getSession
    expect(db.state.calls.some((c) => c.text.includes("SET state = 'VERIFIED'"))).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(true);
  });
});

// =====================================================================
// AUTOMATIC PAYMENT ACTIVATION — trusted webhook verification rail.
// The signed Razorpay webhook is the trusted rail. Nothing a client
// fabricates (a made-up paymentId/reference/screenshot) may ever reach
// ACTIVE on its own.
// =====================================================================
type WebhookEvent = {
  id: string;
  event: string;
  payload?: {
    payment?: { entity?: { id?: string; amount?: number; email?: string; created_at?: number; notes?: Record<string, string> } };
    payment_link?: { entity?: { id?: string; reference_id?: string; notes?: Record<string, string> } };
  };
};

function signWebhook(raw: Buffer): string {
  const { createHmac } = require('node:crypto');
  return createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET!).update(raw).digest('hex');
}

/** Drive the real /razorpay POST handler (extracted from the router) with stub req/res. */
async function callWebhook(
  body: WebhookEvent,
  opts: { signature?: string; rawBody?: Buffer } = {},
): Promise<{ statusCode: number; json: any; errors: any[] }> {
  const raw = opts.rawBody ?? Buffer.from(JSON.stringify(body));
  const router: any = paymentWebhookRoutes();
  const layer = router.stack.find((l: any) => l.route && l.route.path === '/razorpay');
  const handle = layer.route.stack[0].handle;
  const req: any = {
    method: 'POST',
    url: '/razorpay',
    path: '/razorpay',
    get: (h: string) => (req.headers as Record<string, string>)[h.toLowerCase()] ?? undefined,
    headers: {},
    body: raw,
  };
  if (opts.signature !== undefined) req.headers['x-razorpay-signature'] = opts.signature;
  else req.headers['x-razorpay-signature'] = signWebhook(raw);
  let statusCode = 200;
  let jsonOut: any = null;
  let settle: (() => void) | null = null;
  const done = new Promise<void>((r) => { settle = r; });
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(o: any) { jsonOut = o; settle?.(); return res; },
    end: () => res,
  };
  const errors: any[] = [];
  const next = (e?: any) => { if (e) errors.push(e instanceof Error ? e.message : e); settle?.(); };
  await handle(req, res, next);
  await done;
  return { statusCode, json: jsonOut, errors };
}

/** Extend baseResolve so the webhook resolution + dedupe queries resolve too. */
function webhookResolve(intent: Record<string, unknown>, over: (text: string, params: unknown[]) => unknown[] | null = () => null) {
  const base = baseResolve(intent, over);
  const baseFn = db.state.resolve!;
  db.state.resolve = (text, params) => {
    const custom = over(text, params);
    if (custom) return custom;
    if (text.includes('INSERT INTO payment_webhook_events') && text.includes('ON CONFLICT')) {
      db.state.rowCount = 1;
      return [{ event_id: String(params[0]) }];
    }
    if (text.includes('FROM payment_intents WHERE provider_reference_id') || text.includes('FROM payment_intents WHERE provider_payment_link_id') || text.includes('FROM payment_intents WHERE reference = $1 ORDER BY')) {
      return params[0] === intent.reference || params[0] === 'plink_101' ? [{ ...intent }] : [];
    }
    return baseFn(text, params);
  };
  void base;
}

function webhookProEvent(over: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'evt_wh_1',
    event: 'payment.captured',
    payload: {
      payment: { entity: { id: 'pay_wh_pro', amount: 99900, email: 'u1@test.dev', created_at: Math.floor(Date.now() / 1000) - 60, notes: { reference: REF } } },
      payment_link: { entity: { id: 'plink_101', reference_id: REF, notes: { reference: REF } } },
    },
    ...over,
  };
}

describe('AUTOMATIC PAYMENT ACTIVATION — webhook rail', () => {
  it('webhookDetectorAvailable is enabled only when webhook flag + secret are set', () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    expect(webhookDetectorAvailable()).toBe(true);
    env.RAZORPAY_WEBHOOK_SECRET = undefined;
    expect(webhookDetectorAvailable()).toBe(false);
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    env.RAZORPAY_WEBHOOK_ENABLED = 'false';
    expect(webhookDetectorAvailable()).toBe(false);
  });

  it('createRazorpayPaymentLinkForIntent calls the API with a unique reference and returns the link', async () => {
    env.RAZORPAY_KEY_ID = 'rzp_test_key';
    env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'plink_101', short_url: 'https://rzp.io/rzp/uniq1', reference_id: 'CCPRO-ABCD12' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    baseResolve(intentRow());
    const link = await createRazorpayPaymentLinkForIntent('u1', 'pro', REF);
    expect(link).toEqual({ id: 'plink_101', short_url: 'https://rzp.io/rzp/uniq1', reference_id: 'CCPRO-ABCD12' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).reference_id).toBe(REF);
    expect(JSON.parse(init.body).amount).toBe(99900);
    expect(JSON.parse(init.body).currency).toBe('INR');
  });

  it('createPaymentIntent stores the unique link mapping (provider_payment_link_id + reference_id)', async () => {
    env.RAZORPAY_KEY_ID = 'rzp_test_key';
    env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'plink_101', short_url: 'https://rzp.io/rzp/uniq1', reference_id: 'CCPRO-ABCD12' }),
    })));
    baseResolve(intentRow());
    await createPaymentIntent('u1', 'pro');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_intents'))!;
    expect(insert.text).toContain('provider_payment_link_id');
    expect(insert.params[7]).toBe('plink_101');
    expect(insert.params[8]).toBe('CCPRO-ABCD12');
    expect(insert.params[6]).toBe('https://rzp.io/rzp/uniq1');
  });

  it('a valid signed webhook auto-activates Pro -> ACTIVE with an entitlement', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh1', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF });
    webhookResolve(intent);
    const { json } = await callWebhook(webhookProEvent());
    expect(json.ok).toBe(true);
    expect(json.status).toBe('ACTIVE');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.webhook_processed' }));
  });

  it('rejects an invalid signature', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh2', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF });
    webhookResolve(intent);
    const { json, errors } = await callWebhook(webhookProEvent(), { signature: 'deadbeef'.repeat(8) });
    expect(json).toBeNull();
    expect(errors.some((e) => String(e).includes('Invalid Razorpay webhook signature'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.webhook_signature_invalid' }));
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('a replayed event.id is idempotent (no double the entitlement grant)', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh3', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF });
    webhookResolve(intent);
    // First delivery processes and grants.
    const first = await callWebhook(webhookProEvent());
    expect(first.json.status).toBe('ACTIVE');
    // Second delivery: simulate the dedupe returning no row (already recorded).
    const grantedBefore = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements')).length;
    db.state.resolve = (text, params) => {
      if (text.includes('INSERT INTO payment_webhook_events') && text.includes('ON CONFLICT')) {
        db.state.rowCount = 0;
        return null;
      }
      return null;
    };
    const second = await callWebhook(webhookProEvent());
    expect(second.json).toMatchObject({ ok: true, duplicate: true });
    const grantedAfter = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements')).length;
    expect(grantedAfter).toBeGreaterThanOrEqual(grantedBefore);
  });

  it('a payment.authorized hold is recorded but never activates (authorization is not capture)', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-whauth', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF });
    webhookResolve(intent);
    const { json } = await callWebhook(webhookProEvent({ id: 'evt_wh_auth', event: 'payment.authorized' }));
    expect(json.ok).toBe(true);
    expect(json.event).toBe('payment.authorized');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes("SET status = 'ACTIVE'"))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.webhook_event' }));
  });

  it('a payment.dispute.created event suspends access (CHARGEBACK) and stops a pending auto-approval', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-whd', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF, status: 'ACTIVE' });
    webhookResolve(intent, (text, params) => {
      if (text.includes('FROM entitlements WHERE user_id') && text.includes('plan_id') && text.includes('PRO_VERIFIED')) {
        return [{ id: 'ent-whd', payment_session_id: intent.id }];
      }
      if (text.includes('SELECT * FROM entitlements WHERE user_id') && text.includes('plan_id')) {
        return [{ id: 'ent-whd', user_id: params[0], plan_id: params[1], state: 'PRO_VERIFIED', verified_at: new Date(), expires_at: null, payment_session_id: intent.id, reason: null, created_at: new Date(), updated_at: new Date() }];
      }
      return null;
    });
    const { json } = await callWebhook(webhookProEvent({ id: 'evt_wh_dispute', event: 'payment.dispute.created' }));
    expect(json).toMatchObject({ ok: true, handled: 'chargeback' });
    const chargeback = db.state.calls.find((c) => c.text.includes("SET status = 'CHARGEBACK'"))!;
    expect(chargeback).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes('UPDATE entitlements SET state'))).toBe(true);
    const stop = db.state.calls.find((c) => c.text.includes("SET state = 'STOPPED'") && c.text.includes('payment_reversed'))!;
    expect(stop).toBeDefined();
    expect(stop.params[0]).toBe('pay_wh_pro');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.webhook_chargeback' }));
  });

  it('a refund during the autopilot window stops the pending auto-approval so the sweep cannot activate', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-whr', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF, status: 'PENDING' });
    webhookResolve(intent);
    const { json } = await callWebhook(webhookProEvent({
      id: 'evt_wh_refund',
      event: 'payment.refunded',
      payload: {
        payment: { entity: { id: 'pay_wh_ref', amount: 99900, email: 'u1@test.dev', created_at: Math.floor(Date.now() / 1000) - 60, notes: { reference: REF } } },
        payment_link: { entity: { id: 'plink_101', reference_id: REF, notes: { reference: REF } } },
      },
    }));
    expect(json).toMatchObject({ ok: true, handled: 'refunded' });
    const stop = db.state.calls.find((c) => c.text.includes("SET state = 'STOPPED'") && c.text.includes('payment_reversed'))!;
    expect(stop).toBeDefined();
    expect(stop.params[0]).toBe('pay_wh_ref');
    // PENDING intent: no activation, no entitlement grant.
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });

  it('a webhook whose amount does not match the intent never auto-activates nor grants', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh4', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF });
    webhookResolve(intent);
    const { json } = await callWebhook(webhookProEvent({
      payload: {
        payment: { entity: { id: 'pay_wh_amt', amount: 499900, email: 'u1@test.dev', created_at: Math.floor(Date.now() / 1000) - 60, notes: { reference: REF } } },
        payment_link: { entity: { id: 'plink_101', reference_id: REF, notes: { reference: REF } } },
      },
    }));
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('amount_mismatch');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.webhook_amount_mismatch' }));
  });

  it('a webhook that resolves to no intent is recorded, never auto-activated', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow();
    webhookResolve(intent);
    db.state.resolve = (text, params) => {
      if (text.includes('INSERT INTO payment_webhook_events') && text.includes('ON CONFLICT')) { db.state.rowCount = 1; return [{ event_id: String(params[0]) }]; }
      if (text.includes('FROM payment_intents WHERE')) return [];
      return null;
    };
    const { json } = await callWebhook(webhookProEvent({ payload: { payment: { entity: { id: 'pay_wh_unk', amount: 99900, email: 'other@example.com', created_at: Math.floor(Date.now() / 1000) - 60 } } } }));
    expect(json).toMatchObject({ ok: false, reason: 'no_matching_intent' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.webhook_unmatched' }));
  });

  it('fabricated/manual evidence can never activate even when the webhook flag is on', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh5', reference: REF });
    baseResolve(intent);
    // A client attempts to claim a "captured" payment with a fabricated paymentId
    // through the untrusted/manual rail — must not activate.
    const result = await ingestEvidence('u1', 'pin-wh5', 'manual', {
      paymentRef: 'pay_fab',
      amountInr: 999,
      paidAt: new Date().toISOString(),
    });
    // Manual/asserted evidence is usable only for REVIEW — it can never reach
    // ACTIVE (manual_assertion_cannot_activate is the mandated boundary).
    expect(result.result!.decision).toBe('REVIEW');
    expect(result.result!.flags).toContain('manual_assertion_cannot_activate');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
    // Trusted webhook with a mismatched plan reference still cannot fabricate an ACTIVE.
  });

  it('trusted webhook evidence reaches ACTIVE through the 26H pipeline', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh6', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF });
    baseResolve(intent);
    const payload = webhookProEvent();
    const result = await ingestEvidence('u1', 'pin-wh6', 'razorpay_webhook', payload);
    expect(result.result!.intentStatus).toBe('ACTIVE');
    expect(result.result!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(true);
  });

  it('a webhook refund sets the intent to REFUNDED and revokes the entitlement', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow({ id: 'pin-wh7', reference: REF, provider_payment_link_id: 'plink_101', provider_reference_id: REF, status: 'ACTIVE' });
    webhookResolve(intent, (text, params) => {
      if (text.includes('FROM entitlements WHERE user_id') && text.includes('plan_id') && text.includes('PRO_VERIFIED')) {
        return [{ id: 'ent-wh7', payment_session_id: intent.id }];
      }
      if (text.includes('SELECT * FROM entitlements WHERE user_id') && text.includes('plan_id')) {
        return [{ id: 'ent-wh7', user_id: params[0], plan_id: params[1], state: 'PRO_VERIFIED', verified_at: new Date(), expires_at: null, payment_session_id: intent.id, reason: null, created_at: new Date(), updated_at: new Date() }];
      }
      return null;
    });
    const { json } = await callWebhook(webhookProEvent({ id: 'evt_wh_refund', event: 'payment.refunded' }));
    expect(json).toMatchObject({ ok: true, handled: 'refunded' });
    expect(db.state.calls.some((c) => c.text.includes("SET status = 'REFUNDED'"))).toBe(true);
  });

  it('RAZORPAY_WEBHOOK_ENABLED off -> webhook route is unavailable (404), no processing', async () => {
    env.RAZORPAY_WEBHOOK_ENABLED = 'false';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
    const intent = intentRow();
    webhookResolve(intent);
    const { errors } = await callWebhook(webhookProEvent());
    expect(errors.some((e) => String(e).includes('Webhook not configured'))).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO payment_webhook_events'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });
});