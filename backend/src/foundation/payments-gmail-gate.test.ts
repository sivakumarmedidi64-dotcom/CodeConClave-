/**
 * CodeConClave — authenticated-mailbox gate + zero-admin sweep tests.
 *
 * Verifies the "safest possible automation" for the payment-link-only
 * environment:
 *  - emails are only trusted after AUTHENTICATED-origin verification
 *    (dkim/spf/dmarc pass for razorpay.com + sender domain razorpay.com);
 *  - reference-less static-link receipts can NEVER auto-activate;
 *  - a receipt carrying another user's reference is dropped (tenant-safe);
 *  - the watchdog mailbox sweep reuses the existing 26H pipeline, is bounded,
 *    backoff rate-limited and idempotent, and is a no-op when unconfigured.
 * No provider is contacted; Gmail API and DB are mocked.
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

import { env } from '../config/env.js';
import { isAuthenticRazorpayMail } from '../modules/payments/evidence.js';
import { ingestEvidence } from '../modules/payments/pipeline.js';
import { sweepPendingIntentEvidence } from '../modules/payments/service.js';
import type { PaymentIntentRow } from '../modules/payments/intents.js';

const REF = 'CCPRO-ABCD12';
const AUTH_OK =
  'dns.google; dkim=pass header.d=razorpay.com; spf=pass smtp.mailfrom=razorpay.com; dmarc=pass header.from=razorpay.com';

function intentRow(over: Partial<Record<string, unknown>> = {}): PaymentIntentRow {
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
    provider_payment_link_id: null,
    provider_reference_id: null,
    ...over,
  } as unknown as PaymentIntentRow;
}

function baseResolve(intent: PaymentIntentRow, over: (text: string, params: unknown[]) => unknown[] | null = () => null) {
  let mutatedStatus: string | null = null;
  db.state.resolve = (text, params) => {
    const custom = over(text, params);
    if (custom) return custom;
    if (text.includes("AND status IN ('PENDING','REVIEW','ACTIVE','GRACE')")) return [];
    if (text.includes('SELECT email FROM users')) return [{ email: params[0] === 'u2' ? 'u2@test.dev' : 'u1@test.dev' }];
    if (text.includes('FROM payment_evidence WHERE owner_id') && text.includes('count(*)')) return [{ n: 0 }];
    if (text.includes('SHOW search_path')) return [];
    if (text.includes('WHERE id = $1 AND owner_id = $2')) return params[0] === intent.id && params[1] === intent.owner_id ? [intent] : [];
    if (text.includes('SELECT * FROM payment_intents WHERE id = $1')) {
      return [{ ...intent, id: String(params[0]), status: mutatedStatus ?? intent.status }];
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
    const isStatusUpdate =
      text.includes('UPDATE payment_intents') && text.includes('SET status') && text.includes('WHERE id = $1') && params[0] === intent.id;
    if (isStatusUpdate) {
      const m = text.match(/SET status = '([A-Z]+)'/);
      mutatedStatus = m ? m[1] : String(params[1]);
      db.state.rowCount = 1;
      return [intent];
    }
    return null;
  };
}

/** Seed a mocked Gmail API returning one receipt message with the given headers. */
function seedGmail(subject: string, opts: { auth?: string | null; from?: string } = {}) {
  const auth = opts.auth === undefined ? AUTH_OK : opts.auth;
  const from = opts.from ?? 'Razorpay <noreply@razorpay.com>';
  const headers: Array<{ name: string; value: string }> = [
    { name: 'Subject', value: subject },
    { name: 'From', value: from },
    { name: 'Date', value: new Date().toUTCString() },
  ];
  if (auth) headers.push({ name: 'Authentication-Results', value: auth });
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'm1' }] }) } as Response;
    return { ok: true, json: async () => ({ payload: { headers } }) } as Response;
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  env.GMAIL_OAUTH_ACCESS_TOKEN = 'ya29.mock';
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

// -------------------------------------------------- authenticated-origin gate
describe('authenticated-origin gate (isAuthenticRazorpayMail)', () => {
  it('accepts a dkim+spf+dmarc pass from razorpay.com', () => {
    const msg = { payload: { headers: [{ name: 'From', value: 'Razorpay <noreply@razorpay.com>' }, { name: 'Authentication-Results', value: AUTH_OK }] } };
    expect(isAuthenticRazorpayMail(msg)).toBe(true);
  });

  it('rejects a message with no authentication results (spoofed "Razorpay" text)', () => {
    const msg = { payload: { headers: [{ name: 'From', value: 'Razorpay <noreply@razorpay.com>' }] } };
    expect(isAuthenticRazorpayMail(msg)).toBe(false);
  });

  it('rejects DKIM pass for an attacker domain even when From says Razorpay', () => {
    const msg = {
      payload: {
        headers: [
          { name: 'From', value: 'Razorpay <noreply@razorpay.com>' },
          { name: 'Authentication-Results', value: 'dns.google; dkim=pass header.d=attacker.net; spf=pass smtp.mailfrom=attacker.net' },
        ],
      },
    };
    expect(isAuthenticRazorpayMail(msg)).toBe(false);
  });

  it('rejects a razorpay-domain dkim pass on a non-Razorpay From address', () => {
    const msg = {
      payload: {
        headers: [
          { name: 'From', value: 'Support <noreply@codeconclave.dev>' },
          { name: 'Authentication-Results', value: 'dns.google; dkim=pass header.d=razorpay.com' },
        ],
      },
    };
    expect(isAuthenticRazorpayMail(msg)).toBe(false);
  });
});

// --------------------------------------------- trusted reference-bound receipt
describe('authenticated receipt → automatic activation (no admin)', () => {
  it('a verified reference-bound Razorpay receipt activates the entitlement', async () => {
    seedGmail(`CodeConClave Pro payment ₹999 ${REF} pay_gm_authed`);
    const intent = intentRow();
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    expect(result.result!.intentStatus).toBe('ACTIVE');
    expect(result.result!.decision).toBe('ACTIVE');
    const ent = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements'));
    expect(ent.length).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.activated' }));
  });

  it('Team ₹4999 authenticated receipt activates the correct TEAM entitlement', async () => {
    seedGmail(`CodeConClave Team payment ₹4999 CCTEAM-MNOP78 pay_gm_team`);
    const intent = intentRow({ id: 'pin-team', plan_id: 'team', amount_inr: 4999, reference: 'CCTEAM-MNOP78' });
    baseResolve(intent);
    const result = await ingestEvidence('u1', 'pin-team', 'gmail', undefined);
    expect(result.result!.intentStatus).toBe('ACTIVE');
    const ent = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    expect(ent.params[2]).toBe('team');
  });

  it('TEAM receipt with a PRO (₹999) amount is rejected on the trusted rail', async () => {
    seedGmail(`CodeConClave Team payment ₹999 CCTEAM-MNOP78 pay_gm_teamlow`);
    const intent = intentRow({ id: 'pin-team', plan_id: 'team', amount_inr: 4999, reference: 'CCTEAM-MNOP78' });
    baseResolve(intent, (text) => {
      if (text.includes('FROM payment_evidence WHERE owner_id') && text.includes('count(*)')) return [{ n: 0 }];
      return null;
    });
    const result = await ingestEvidence('u1', 'pin-team', 'gmail', undefined);
    expect(result.result!.flags).toContain('amount_mismatch');
    expect(result.result!.intentStatus).toBe('REVIEW');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });
});

// --------------------------------- static-link + un-correlatable receipts
describe('static-link receipts (no unique reference) can never activate', () => {
  async function expectNoEvidence(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({ errorCode: 'no_evidence' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  }

  it('a reference-less authentic receipt stays PENDING (never auto-activates)', async () => {
    seedGmail('Payment received by CodeConClave ₹999 (UPI txn 4182…9133)');
    const intent = intentRow();
    baseResolve(intent);
    await expectNoEvidence(ingestEvidence('u1', 'pin-1', 'gmail', undefined));
    expect(intent.status).toBe('PENDING');
  });

  it('a spoofed (unauthenticated) receipt with a reference is dropped', async () => {
    seedGmail(`CodeConClave Pro payment ₹999 ${REF} pay_gm_spoof`, { auth: null });
    const intent = intentRow();
    baseResolve(intent);
    await expectNoEvidence(ingestEvidence('u1', 'pin-1', 'gmail', undefined));
  });

  it('a receipt carrying another USER reference cannot activate a different account (tenant isolation)', async () => {
    seedGmail(`CodeConClave Pro payment ₹999 ${REF} pay_gm_tenant`);
    const other = intentRow({ id: 'pin-2', owner_id: 'u2', reference: 'CCPRO-DEF456' });
    baseResolve(other);
    await expectNoEvidence(ingestEvidence('u2', 'pin-2', 'gmail', undefined));
  });

  it('a fabricated reference string cannot activate (gate requires exact intent match)', async () => {
    seedGmail('CodeConClave Pro payment ₹999 CCPRO-FABRIC');
    const intent = intentRow();
    baseResolve(intent);
    await expectNoEvidence(ingestEvidence('u1', 'pin-1', 'gmail', undefined));
  });

  it('an amount-plus-payer-only authentic receipt cannot activate a shared-link payment', async () => {
    seedGmail('CodeConClave Pro payment ₹999 from u1@test.dev');
    const intent = intentRow();
    baseResolve(intent);
    await expectNoEvidence(ingestEvidence('u1', 'pin-1', 'gmail', undefined));
  });
});

// --------------------------------------------------------- replay/idempotency
describe('replay and idempotency across the mailbox rail', () => {
  it('a repeated ingestion of the same tax receipt yields exactly ONE entitlement', async () => {
    seedGmail(`CodeConClave Pro payment ₹999 ${REF} pay_gm_again`);
    const intent = intentRow();
    // Model the real guarded exactly-once UPDATE: the first pass wins the race
    // (rowCount 1); any later pass sees 0 affected rows and never re-activates.
    let activeUpdates = 0;
    baseResolve(intent, (text) => {
      if (text.includes("SET status = 'ACTIVE'")) {
        activeUpdates += 1;
        db.state.rowCount = 1;
        return [intent];
      }
      if (text.includes('SELECT * FROM payment_intents WHERE id = $1')) {
        return [{ ...intent, status: activeUpdates >= 1 ? 'ACTIVE' : 'PENDING' }];
      }
      return null;
    });
    const first = await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    expect(first.result!.intentStatus).toBe('ACTIVE');
    await ingestEvidence('u1', 'pin-1', 'gmail', undefined);
    const ents = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements'));
    expect(ents.length).toBe(1);
  });
});

// ------------------------------------------------------------ watchdog sweep
describe('watchdog mailbox sweep (bounded, backoff, reuse pipeline)', () => {
  it('throws evidence_source_blocked when the Gmail rail is not configured (contained by watchdog)', async () => {
    await expect(sweepPendingIntentEvidence()).rejects.toMatchObject({ errorCode: 'evidence_source_blocked' });
    expect(db.state.calls.some((c) => c.text.includes('FROM payment_intents WHERE status IN'))).toBe(false);
  });

  it('automatically verifies and activates a pending intent from an authentic receipt', async () => {
    seedGmail(`CodeConClave Pro payment ₹999 ${REF} pay_gm_sweep`);
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('FROM payment_intents WHERE status IN')) return [{ id: 'pin-1', owner_id: 'u1' }];
      return null;
    });
    const out = await sweepPendingIntentEvidence();
    expect(out.checked).toBeGreaterThanOrEqual(1);
    expect(out.activated).toBeGreaterThanOrEqual(1);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(true);
    // Rate-limit: an immediate second sweep is skipped by the per-intent backoff.
    const again = await sweepPendingIntentEvidence();
    expect(again.checked).toBe(0);
    expect(again.activated).toBe(0);
  });

  it('does not activate an ambiguous reference-less receipt found during a sweep', async () => {
    seedGmail('Payment received by CodeConClave ₹999');
    const intent = intentRow();
    baseResolve(intent, (text) => {
      if (text.includes('FROM payment_intents WHERE status IN')) return [{ id: 'pin-1', owner_id: 'u1' }];
      return null;
    });
    const out = await sweepPendingIntentEvidence();
    expect(out).toEqual({ checked: 0, activated: 0 });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);
  });
});