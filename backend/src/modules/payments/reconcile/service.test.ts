/**
 * CodeConClave — RAZORPAY API RECONCILIATION FALLBACK tests.
 *
 * Proves the mandated safety matrix against the LIVE decision logic (no real
 * payment is ever made here):
 *   A webhook-first            -> already_processed, never a second grant
 *   B API-first / webhook-later -> dedupe via consumed ids + approval states
 *   C authorized-only          -> NO activation
 *   D failed                   -> NO activation
 *   E wrong amount             -> NO activation
 *   F wrong currency           -> NO activation
 *   G wrong/unknown link       -> NO activation (fail closed)
 *   H captured + exact match   -> existing autopilot pipeline (requestAutoApproval)
 *   I refunded                 -> NO activation
 * plus: ambiguous payers -> REVIEW, backoff/exhaustion -> REVIEW + founder queue,
 * auth errors -> cooldown, mode/credentials kill switches, secret-safe reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  type Resolver = (text: string, params: unknown[]) => Array<Record<string, unknown>> | null;
  const state: { calls: { text: string; params: unknown[] }[]; resolve: Resolver | null } = { calls: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? (state.resolve(text, params) ?? []) : [];
    return { rows, rowCount: rows.length };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  const queryOne = async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null;
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../../../shared/db.js', () => db);
vi.mock('../../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const razorpay = vi.hoisted(() => {
  const state: { payments: Array<Record<string, unknown>>; configured: boolean; throwError?: unknown } = {
    payments: [],
    configured: true,
  };
  return {
    state,
    fetchLinkPayments: vi.fn(async () => state.payments),
    probe: vi.fn(async () => 'VALID' as const),
  };
});
vi.mock('../razorpay/api.js', async (importActual) => {
  const actual = await importActual<typeof import('../razorpay/api.js')>();
  return {
    ...actual,
    razorpayApiConfigured: () => razorpay.state.configured,
    fetchLinkPayments: razorpay.fetchLinkPayments,
    probeRazorpayCredentials: razorpay.probe,
  };
});

const autopilot = vi.hoisted(() => ({
  linkIdForPlan: 'link_pro',
  mode: 'AUTOPILOT' as 'AUTOPILOT' | 'MANUAL',
  queueAutopilotReview: vi.fn(async () => ({ queued: true })),
  staticLinkIdForPlan: vi.fn((plan: string) => (plan === 'pro' ? autopilot.linkIdForPlan : plan === 'team' ? 'link_team' : plan === 'api' ? 'link_api' : null)),
  getEffectiveUnlockMode: vi.fn(async () => autopilot.mode),
}));
vi.mock('../autopilot/service.js', () => autopilot);

const autoapproval = vi.hoisted(() => ({
  planned: 'PENDING',
  requestAutoApproval: vi.fn(async () => ({ planned: autoapproval.planned })),
}));
vi.mock('../autoapproval/service.js', () => ({ requestAutoApproval: autoapproval.requestAutoApproval }));
vi.mock('../service.js', () => ({ PLAN_PRICES_INR: { pro: 999, team: 4999, api: 9999 } }));

import { reconcileIntent, reconcilePaymentSweep, redactPaymentId, verifyPaymentWithRazorpay, listReconcileRows } from './service.js';
import { recordAudit } from '../../audit/service.js';
import { RazorpayApiError } from '../razorpay/api.js';

function authUser(){ return { id: 'u_admin4', rbacRole: 'admin' as const }; }

function intentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pin_alice',
    owner_id: 'u1',
    plan_id: 'pro',
    amount_inr: 999,
    status: 'PENDING',
    created_at: new Date('2026-09-25T00:00:00Z').toISOString(),
    ...over,
  };
}

function pay(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'captured',
    captured: true,
    amount: 99900,
    currency: 'INR',
    email: 'alice@example.com',
    created_at: 1_760_000_000,
    refund_status: '',
    amount_refunded: 0,
    method: 'upi',
    ...over,
  };
}

function defaultResolver(intent: Record<string, unknown> = intentRow(), over: { reconcile?: Array<Record<string, unknown>>; approvals?: Array<Record<string, unknown>>; evidence?: Array<Record<string, unknown>>; emailOwner?: Array<Record<string, unknown>> } = {}) {
  db.state.resolve = (text) => {
    if (text.includes('LEFT JOIN payment_reconciliation') && text.includes('FROM payment_intents i')) {
      return [{ id: intent.id }];
    }
    if (text.includes('FROM payment_intents') && text.includes('WHERE id')) {
      return [intent];
    }
    if (text.includes('FROM payment_reconciliation')) {
      if (over.reconcile && over.reconcile.length > 0) return over.reconcile;
      return [];
    }
    if (text.includes('lower(email)')) {
      if (over.emailOwner && over.emailOwner.length > 0) return over.emailOwner;
      return [{ id: 'u1' }];
    }
    if (text.includes('email FROM users')) return [{ email: 'alice@example.com' }];
    if (text.includes('FROM payment_auto_approvals')) {
      if (over.approvals && over.approvals.length > 0) return over.approvals;
      return [];
    }
    if (text.includes('FROM payment_evidence')) {
      if (over.evidence && over.evidence.length > 0) return over.evidence;
      return [];
    }
    if (text.includes('FROM users')) return [{ id: 'u1' }];
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  razorpay.state.payments = [];
  razorpay.state.configured = true;
  razorpay.state.throwError = undefined;
  razorpay.fetchLinkPayments.mockClear();
  autopilot.staticLinkIdForPlan.mockClear();
  autopilot.mode = 'AUTOPILOT';
  autopilot.linkIdForPlan = 'link_pro';
  autopilot.queueAutopilotReview.mockClear();
  autoapproval.requestAutoApproval.mockClear();
  autoapproval.planned = 'PENDING';
  (recordAudit as unknown as ReturnType<typeof vi.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// Secret safety + presence
// ---------------------------------------------------------------------------
describe('reconcile safe helpers', () => {
  it('redacts provider payment ids for logs', () => {
    expect(redactPaymentId('pay_abcdefgh1234')).toBe('pay_…1234');
    expect(redactPaymentId(null)).toBeNull();
    expect(redactPaymentId('short')).toBe('pay_####');
  });
});

// ---------------------------------------------------------------------------
// A — webhook first; fallback sees already-processed (no second grant)
// ---------------------------------------------------------------------------
describe('A — webhook-first (existing entitlement preserved)', () => {
  it('returns already_processed for an ACTIVE/GRACE intent and never re-activates', async () => {
    defaultResolver(intentRow({ status: 'ACTIVE' }));
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('already_processed');
    expect(razorpay.fetchLinkPayments).not.toHaveBeenCalled();
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('returns already_processed for a GRACE intent (existing real ₹999 payment case)', async () => {
    defaultResolver(intentRow({ status: 'GRACE' }));
    expect((await reconcileIntent('pin_alice')).status).toBe('already_processed');
  });
});

// ---------------------------------------------------------------------------
// B — API first; webhook later must not double-activate
// ---------------------------------------------------------------------------
describe('B — API-first / webhook-later race protection', () => {
  it('treats a payment already on the approval rail as processed (dedupe)', async () => {
    razorpay.state.payments = [pay('pay_consumed')];
    defaultResolver(intentRow(), { approvals: [{ payment_id: 'pay_consumed' }] });
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('already_approved');
    expect(out.reason).toBe('already_consumed');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('treats a payment already recorded in evidence as processed (dedupe)', async () => {
    razorpay.state.payments = [pay('pay_evidenced')];
    defaultResolver(intentRow(), { evidence: [{ provider_payment_id: 'pay_evidenced' }] });
    expect((await reconcileIntent('pin_alice')).status).toBe('already_approved');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('maps an already-scheduled approval to already_pending from a later reconcile', async () => {
    razorpay.state.payments = [pay('pay_map1')];
    defaultResolver(intentRow());
    autoapproval.planned = 'ALREADY_PENDING';
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('already_pending');
    expect(autoapproval.requestAutoApproval).toHaveBeenCalledWith(
      expect.objectContaining({ intent: expect.objectContaining({ id: 'pin_alice' }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// C/D/E/F/I — nothing but a captured exact match may activate
// ---------------------------------------------------------------------------
describe('C/D/E/F/I — authorized / failed / amount / currency / refunded never activate', () => {
  it('C: authorized-only is never activated', async () => {
    razorpay.state.payments = [pay('pay_authorized', { status: 'authorized', captured: false })];
    defaultResolver(intentRow());
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('no_captured_payment');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('D: failed payments are never activated', async () => {
    razorpay.state.payments = [pay('pay_failed', { status: 'failed', captured: false })];
    defaultResolver(intentRow());
    expect((await reconcileIntent('pin_alice')).status).toBe('no_captured_payment');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('E: wrong amount is never activated', async () => {
    razorpay.state.payments = [pay('pay_wrongamount', { amount: 59_900 })];
    defaultResolver(intentRow());
    expect((await reconcileIntent('pin_alice')).status).toBe('no_captured_payment');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('F: wrong currency is never activated', async () => {
    razorpay.state.payments = [pay('pay_wrongccy', { currency: 'USD' })];
    defaultResolver(intentRow());
    expect((await reconcileIntent('pin_alice')).status).toBe('no_captured_payment');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('I: refunded payments are never activated', async () => {
    razorpay.state.payments = [pay('pay_refunded', { status: 'refunded', captured: true, refund_status: 'full' })];
    defaultResolver(intentRow());
    expect((await reconcileIntent('pin_alice')).status).toBe('no_captured_payment');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });

  it('G: an unknown/unconfigured payment link fails closed', async () => {
    defaultResolver(intentRow());
    autopilot.linkIdForPlan = '';
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('no_link_id');
    expect(razorpay.fetchLinkPayments).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// H — captured + exact match funnels through the EXISTING pipeline
// ---------------------------------------------------------------------------
describe('H — captured + exact match activates via the existing autopilot rail', () => {
  it('schedules the verified payment into requestAutoApproval (2s window)', async () => {
    razorpay.state.payments = [pay('pay_good')];
    defaultResolver(intentRow());
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('scheduled');
    expect(out.paymentId).toBe('pay_good');
    expect(autoapproval.requestAutoApproval).toHaveBeenCalledTimes(1);
    const args = autoapproval.requestAutoApproval.mock.calls[0]![0] as { intent: Record<string, unknown>; signal: Record<string, unknown> };
    expect(args.signal).toMatchObject({ paymentId: 'pay_good', amountInr: 999, payerEmail: 'alice@example.com' });
    expect(args.intent.id).toBe('pin_alice');
    const reconcileWrite = db.state.calls.find((c) => c.text.startsWith('INSERT INTO payment_reconciliation'));
    expect(reconcileWrite).toBeDefined();
    expect(reconcileWrite!.params[2] as string).toBe('VERIFIED');
    expect(reconcileWrite!.params[3] as string | null).toBe('pay_good');
  });

  it('binds the payment ONLY to the intent owner, never a stranger-provided id', async () => {
    razorpay.state.payments = [pay('pay_stranger', { email: 'someone@example.com' })];
    defaultResolver(intentRow(), { emailOwner: [{ id: 'u_other' }] });
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('wrong_binding');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ambiguity + bounded backoff/exhaustion
// ---------------------------------------------------------------------------
describe('ambiguous + backoff/exhaustion fail closed to REVIEW', () => {
  it('never arbitrarily picks when two unconsumed captured payments match', async () => {
    razorpay.state.payments = [pay('pay_duplicate01'), pay('pay_duplicate02', { created_at: 1_760_000_100 })];
    defaultResolver(intentRow());
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('ambiguous');
    expect(autoapproval.requestAutoApproval).not.toHaveBeenCalled();
    const reviewWrite = db.state.calls.find((c) => c.text.includes('UPDATE payment_intents SET status'));
    expect(reviewWrite).toBeDefined();
    expect(autopilot.queueAutopilotReview).toHaveBeenCalled();
  });

  it('schedules a retry for the first no-match attempt, then exhausts to REVIEW', async () => {
    razorpay.state.payments = [];
    defaultResolver(intentRow());
    const first = await reconcileIntent('pin_alice');
    expect(first.status).toBe('no_captured_payment');
    let row = db.state.calls.find((c) => c.text.startsWith('INSERT INTO payment_reconciliation'));
    expect(row!.params[1] as number).toBe(1); // attempt 1
    expect(row!.params[2]).toBe('SCHEDULED');

    // attempt 5 already recorded -> next reconcile is the 6th -> exhausted
    defaultResolver(intentRow(), { reconcile: [{ attempt: 5 }] });
    const exhausted = await reconcileIntent('pin_alice');
    expect(exhausted.status).toBe('error');
    expect(exhausted.reason).toContain('exhausted');
    const exhaustedWrite = db.state.calls.filter((c) => c.text.startsWith('INSERT INTO payment_reconciliation')).at(-1)!;
    expect(exhaustedWrite!.params[2] as string).toBe('EXHAUSTED');
    const reviewWrite = db.state.calls.find((c) => c.text.includes('UPDATE payment_intents SET status'));
    expect(reviewWrite).toBeDefined();
  });

  it('cooldowns on Razorpay API auth errors without hammering', async () => {
    defaultResolver(intentRow());
    razorpay.fetchLinkPayments.mockRejectedValueOnce(new RazorpayApiError('auth_error', 401));
    const out = await reconcileIntent('pin_alice');
    expect(out.status).toBe('auth_error');
    const row = db.state.calls.find((c) => c.text.startsWith('INSERT INTO payment_reconciliation'));
    expect(row!.params[2]).toBe('SCHEDULED');
    expect(row!.params[5]).toBe('razorpay_auth_error');
  });
});

// ---------------------------------------------------------------------------
// Founder action + control-center read path
// ---------------------------------------------------------------------------
describe('founder verify action reuse + secret-safe reads', () => {
  it('verifyPaymentWithRazorpay runs the SAME verifier and audits the founder action', async () => {
    razorpay.state.payments = [pay('pay_founder')];
    defaultResolver(intentRow());
    const out = await verifyPaymentWithRazorpay('pin_alice', authUser().id);
    expect(out.status).toBe('scheduled');
    expect((recordAudit as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0]?.action === 'payment.reconcile_founder_verify')).toBe(true);
  });

  it('listReconcileRows redacts verified payment ids', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_reconciliation')) {
        return [
          { intent_id: 'pin_alice', intent_status: 'VERIFIED', plan_id: 'pro', attempt: 2, state: 'VERIFIED', verified_payment_id: 'pay_supersecret123', last_attempt_at: null, next_attempt_at: null, last_error: null },
        ];
      }
      return null;
    };
    const rows = await listReconcileRows();
    expect(rows[0]!.verifiedPaymentId).toBe('pay_…t123');
    expect(JSON.stringify(rows)).not.toContain('supersecret');
  });
});

// ---------------------------------------------------------------------------
// Sweep gating: optional creds + AUTOPILOT kill switch
// ---------------------------------------------------------------------------
describe('reconcilePaymentSweep bounds + kill switches', () => {
  it('is a no-op when API credentials are absent (webhook path unaffected)', async () => {
    razorpay.state.configured = false;
    defaultResolver(intentRow());
    const out = await reconcilePaymentSweep();
    expect(out).toEqual({ scanned: 0, actionable: 0 });
    expect(razorpay.fetchLinkPayments).not.toHaveBeenCalled();
  });

  it('is a no-op under the MANUAL kill switch', async () => {
    autopilot.mode = 'MANUAL';
    defaultResolver(intentRow());
    expect(await reconcilePaymentSweep()).toEqual({ scanned: 0, actionable: 0 });
    expect(razorpay.fetchLinkPayments).not.toHaveBeenCalled();
  });

  it('scans only due PENDING intents through the same verifier', async () => {
    razorpay.state.payments = [];
    defaultResolver(intentRow());
    const out = await reconcilePaymentSweep();
    expect(out.scanned).toBe(1);
    const autoApprovalCalls = autoapproval.requestAutoApproval.mock.calls.length;
    expect(autoApprovalCalls).toBe(0); // no captured payment yet
    const insert = db.state.calls.find((c) => c.text.startsWith('INSERT INTO payment_reconciliation'));
    expect(insert).toBeDefined();
  });
});