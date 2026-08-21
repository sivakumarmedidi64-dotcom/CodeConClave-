/**
 * CodeConClave — PHASE 4D payments + entitlements hardening tests.
 * Covers: honest capability detection (Mode A link only; B/C disabled without
 * credentials), client claims never activate Pro, evidence validation,
 * idempotency, the DETECTED -> VERIFYING -> VERIFIED pipeline, exactly-one
 * entitlement activation, revocation, tenant isolation, plan authorization,
 * and the approval-gated admin payment actions (approval can never bypass
 * payment verification). All DB interaction is mocked; no provider contacted.
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
import { evidenceProviders } from '../modules/payments/evidence.js';
import {
  paymentCapability,
  createPaymentSession,
  handleReturn,
  verifySession,
  getSession,
  entitlementFor,
  revokeEntitlement,
  adminPaymentAction,
  systemAdminPaymentAction,
  logPaymentAudit,
} from '../modules/payments/service.js';
import { registerPaymentTools } from '../modules/payments/tools.js';
import { runRegisteredTool } from '../modules/execution/toolcalls.js';

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
    tenant_id: 'u1',
    idempotency_key: null,
  };
}

function entitlement(id: string, planId: string, entState: string): Record<string, unknown> {
  return {
    id,
    user_id: 'u1',
    plan_id: planId,
    state: entState,
    verified_at: entState === 'PRO_VERIFIED' ? new Date() : null,
    expires_at: null,
    payment_session_id: 's1',
    reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function approvedApproval(id: string): Record<string, unknown> {
  return {
    id,
    owner_id: 'u1',
    status: 'APPROVED',
    action_type: 'payment_op',
    expires_at: new Date(Date.now() + 60_000),
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
  registerPaymentTools();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ capability
describe('evidence providers — capability detection is honest', () => {
  it('reports link enabled and API/webhook disabled without credentials', () => {
    const providers = evidenceProviders();
    expect(providers.link.enabled).toBe(true);
    expect(providers.api.enabled).toBe(false);
    expect(providers.api.reason).toContain('RAZORPAY_KEY_ID');
    expect(providers.webhook.enabled).toBe(false);
    expect(providers.webhook.reason).toContain('RAZORPAY_WEBHOOK_SECRET');
    expect(paymentCapability().evidence).toEqual(providers);
  });

  it('enables the API detector only when key AND secret are both set', () => {
    expect(evidenceProviders().api.enabled).toBe(false);
    env.RAZORPAY_KEY_ID = 'rzp_test_x';
    expect(evidenceProviders().api.enabled).toBe(false);
    env.RAZORPAY_KEY_SECRET = 'secret';
    expect(evidenceProviders().api.enabled).toBe(true);
    expect(evidenceProviders().api.reason).toBeNull();
  });

  it('enables the webhook detector only when secret AND webhook mode are set', () => {
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_token';
    expect(evidenceProviders().webhook.enabled).toBe(false);
    env.RAZORPAY_MODE = 'webhook';
    expect(evidenceProviders().webhook.enabled).toBe(true);
    env.RAZORPAY_MODE = 'payment_link';
    expect(evidenceProviders().webhook.enabled).toBe(false);
  });
});

// -------------------------------------------------- idempotency + state machine
describe('payment sessions — idempotency and honest state machine', () => {
  it('creates a PENDING session carrying tenant_id and an idempotency key', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('idempotency_key = $2') || text.includes("state = 'PENDING'")) return [];
      if (text.includes('FROM payment_sessions')) return [session(String(params[0]), 'PENDING')];
      return null;
    };
    const created = await createPaymentSession('u1', 'pro', 'ik_abc');
    expect(created.state).toBe('PENDING');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_sessions'))!;
    expect(insert.text).toContain('tenant_id');
    expect(insert.text).toContain('idempotency_key');
    expect(insert.params[6]).toBe('u1');
    expect(insert.params[7]).toBe('ik_abc');
  });

  it('resolves the same session for the same idempotency key (no duplicates)', async () => {
    let calls = 0;
    db.state.resolve = (text) => {
      if (text.includes('idempotency_key = $2')) {
        calls += 1;
        return calls === 1 ? [] : [session('s_keyed', 'PENDING')];
      }
      if (text.includes('plan_id = $2')) return [];
      if (text.includes('FROM payment_sessions')) return [session('s_keyed', 'PENDING')];
      return null;
    };
    const first = await createPaymentSession('u1', 'pro', 'ik_dup');
    const second = await createPaymentSession('u1', 'pro', 'ik_dup');
    expect(first.id).toBe(second.id);
    expect(first.id).toBe('s_keyed');
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO payment_sessions'));
    expect(inserts.length).toBe(1);
  });

  it('browser return with paid/status URL parameters never activates Pro', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("'CANCELLED'")) sessionState = 'CANCELLED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    const viaPaid = await handleReturn('u1', 's1', '1');
    const viaStatus = await handleReturn('u1', 's1', 'paid');
    expect(viaPaid.state).toBe('PENDING');
    expect(viaStatus.state).toBe('PENDING');
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------ client claims rejected
describe('client claims can never activate Pro', () => {
  it('rejects a client-style claim (source LINK) as invalid evidence', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions')) return [session('s1', 'PENDING')];
      return null;
    };
    await expect(
      verifySession('u1', 's1', { source: 'LINK' as 'API', provider_payment_id: 'pay_claimed', raw: { payment_success: true } }),
    ).rejects.toMatchObject({ errorCode: 'invalid_evidence' });
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
  });

  it('rejects a screenshot/OCR payload without a provider payment id', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions')) return [session('s1', 'PENDING')];
      return null;
    };
    await expect(
      verifySession('u1', 's1', {
        source: 'WEBHOOK',
        raw: { screenshot: 'data:image/png;base64,AAAA', ocrText: 'payment successful' },
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid_evidence' });
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
  });

  it('rejects a user-entered payment id with whitespace (never treated as provider evidence)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions')) return [session('s1', 'PENDING')];
      return null;
    };
    await expect(
      verifySession('u1', 's1', { source: 'WEBHOOK', provider_payment_id: 'pay_1 typed by user', raw: {} }),
    ).rejects.toMatchObject({ errorCode: 'invalid_evidence' });
    expect(db.state.calls.some((c) => c.text.includes("state = 'VERIFIED'"))).toBe(false);
  });

  it('rejects evidence with a non-object raw payload', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions')) return [session('s1', 'PENDING')];
      return null;
    };
    await expect(
      verifySession('u1', 's1', { source: 'WEBHOOK', provider_payment_id: 'pay_1', raw: 'captured' }),
    ).rejects.toMatchObject({ errorCode: 'invalid_evidence' });
  });
});

// -------------------------------------------------------- verified pipeline 4D
describe('verified pipeline — DETECTED -> VERIFYING -> VERIFIED, exactly once', () => {
  it('walks DETECTED/VERIFYING, verifies, and completes the capture record', async () => {
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("SET state = 'VERIFIED'")) sessionState = 'VERIFIED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    const result = await verifySession('u1', 's1', {
      source: 'WEBHOOK',
      provider_payment_id: 'pay_1',
      provider_order_id: 'order_1',
      raw: { event: 'payment.captured' },
    });
    expect(result.state).toBe('VERIFIED');
    const states = db.state.calls
      .filter((c) => c.text.includes('UPDATE payment_sessions') && c.text.includes("SET state = '"))
      .map((c) => c.text.match(/SET state = '([A-Z_]+)'/)![1]);
    expect(states).toEqual(['DETECTED', 'VERIFYING', 'VERIFIED']);
    const detected = db.state.calls.find((c) => c.text.includes("'payment.detected'"))!;
    expect(detected).toBeDefined();
    const completed = db.state.calls.find((c) => c.text.includes("SET status = 'COMPLETED'"))!;
    expect(completed.text).toContain('entitlement_id');
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements')).length).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.verified' }));
  });

  it('does not walk the pipeline for non-pending states (state machine enforced)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM payment_sessions')) return [session('s1', 'REFUNDED')];
      return null;
    };
    await expect(
      verifySession('u1', 's1', { source: 'WEBHOOK', provider_payment_id: 'pay_1', raw: {} }),
    ).rejects.toMatchObject({ errorCode: 'session_not_pending' });
    expect(db.state.calls.some((c) => c.text.includes("state = 'DETECTED'"))).toBe(false);
  });

  it('duplicate provider evidence after verification stays idempotent', async () => {
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("SET state = 'VERIFIED'")) sessionState = 'VERIFIED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    const evidence = { source: 'WEBHOOK' as const, provider_payment_id: 'pay_1', raw: {} };
    await verifySession('u1', 's1', evidence);
    await verifySession('u1', 's1', evidence);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO payments')).length).toBe(1);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements')).length).toBe(1);
  });
});

// --------------------------------------------------------------- entitlements
describe('entitlements — activation, revocation, isolation, plan authorization', () => {
  it('unverified payment never activates the plan entitlement', async () => {
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("'CANCELLED'")) sessionState = 'CANCELLED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      if (text.includes('FROM entitlements')) return [entitlement('ent1', 'pro', 'PRO_PENDING')];
      return null;
    };
    await handleReturn('u1', 's1', '1');
    const ent = await entitlementFor('u1', 'pro');
    expect(ent!.state).toBe('PRO_PENDING');
    expect(db.state.calls.some((c) => c.text.includes("'PRO_VERIFIED'"))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE users SET plan_id'))).toBe(false);
  });

  it('verified payment activates exactly one entitlement for the session plan', async () => {
    let sessionState = 'PENDING';
    db.state.resolve = (text) => {
      if (text.includes("SET state = 'VERIFIED'")) sessionState = 'VERIFIED';
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      return null;
    };
    await verifySession('u1', 's1', { source: 'WEBHOOK', provider_payment_id: 'pay_1', raw: {} });
    const entitlementInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO entitlements'));
    expect(entitlementInserts.length).toBe(1);
    expect(entitlementInserts[0].text).toContain("'PRO_VERIFIED'");
    expect(entitlementInserts[0].params[2]).toBe('pro');
  });

  it('revokes an active entitlement and resets the mirrored plan', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM entitlements')) return [entitlement('ent1', 'pro', 'PRO_VERIFIED')];
      return null;
    };
    const revoked = await revokeEntitlement('u1', 'pro', 'admin test');
    expect(revoked.state).toBe('PRO_VERIFIED');
    const update = db.state.calls.find((c) => c.text.includes("state = 'REVOKED'"))!;
    expect(update.text).toContain("state = 'PRO_VERIFIED'");
    const userReset = db.state.calls.find((c) => c.text.includes("SET plan_id = 'free'"))!;
    expect(userReset.text).toContain('plan_id = $2');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'entitlement.changed',
        detail: expect.objectContaining({ plan: 'pro', state: 'REVOKED' }),
      }),
    );
  });

  it('cannot revoke an entitlement that is not active', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM entitlements')) return [entitlement('ent1', 'pro', 'PRO_PENDING')];
      return null;
    };
    await expect(revokeEntitlement('u1', 'pro', 'test')).rejects.toMatchObject({ errorCode: 'entitlement_not_active' });
  });

  it('tenant isolation: entitlement lookups always filter by user id', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM entitlements')) return [entitlement(String(params[0]), 'pro', 'PRO_VERIFIED')];
      return null;
    };
    const result = await entitlementFor('u2', 'pro');
    expect(result!.id).toBe('u2');
    const call = db.state.calls.find((c) => c.text.includes('FROM entitlements'))!;
    expect(call.text).toContain('user_id = $1');
    expect(call.params[0]).toBe('u2');
  });
});

// -------------------------------------------------- approval-gated admin actions
describe('approval-gated admin payment actions', () => {
  it('requires an approved payment_op approval', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM approvals')) {
        return String(params[0]) === 'app_missing' ? [] : [{ id: String(params[0]), status: 'PENDING', action_type: 'payment_op', expires_at: new Date(Date.now() + 60_000) }];
      }
      if (text.includes('FROM payment_sessions')) return [session('s1', 'VERIFIED')];
      return null;
    };
    await expect(adminPaymentAction('u1', 's1', 'revoke', 'app_missing')).rejects.toMatchObject({
      errorCode: 'approval_required',
    });
    await expect(adminPaymentAction('u1', 's1', 'revoke', 'app_pending')).rejects.toMatchObject({
      errorCode: 'approval_not_approved',
    });
  });

  it('rejects a non-payment-op approval for payment actions', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [{ ...approvedApproval('app_x'), action_type: 'file_write' }];
      if (text.includes('FROM payment_sessions')) return [session('s1', 'VERIFIED')];
      return null;
    };
    await expect(adminPaymentAction('u1', 's1', 'revoke', 'app_x')).rejects.toMatchObject({
      errorCode: 'approval_action_mismatch',
    });
  });

  it('an APPROVED approval can never verify an unverified payment', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvedApproval('app_ok')];
      if (text.includes('FROM payment_sessions')) return [session('s1', 'PENDING')];
      return null;
    };
    await expect(adminPaymentAction('u1', 's1', 'revoke', 'app_ok')).rejects.toMatchObject({
      errorCode: 'payment_not_verified',
    });
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(false);
  });

  it('executing the payment_admin tool also cannot bypass payment verification', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvedApproval('app_ok')];
      if (text.includes('FROM payment_sessions')) return [session('s1', 'PENDING')];
      return null;
    };
    await expect(
      runRegisteredTool('payment_admin', { sessionId: 's1', action: 'revoke', approvalId: 'app_ok' }),
    ).rejects.toMatchObject({ errorCode: 'payment_not_verified' });
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(false);
  });

  it('approved admin revoke succeeds on a VERIFIED payment and audits it', async () => {
    let sessionState = 'VERIFIED';
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvedApproval('app_ok')];
      if (text.includes('FROM payment_sessions')) return [session('s1', sessionState)];
      if (text.includes('FROM entitlements')) return [entitlement('ent1', 'pro', 'PRO_VERIFIED')];
      return null;
    };
    const result = await adminPaymentAction('u1', 's1', 'revoke', 'app_ok');
    expect(result.state).toBe('VERIFIED');
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(true);
    const audit = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_audit'))!;
    expect(audit.params[3]).toBe('admin.revoke');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.admin_action' }));
  });

  it('approved mark_refunded refunds the session and entitlement', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvedApproval('app_ok')];
      if (text.includes('FROM payment_sessions')) return [session('s1', 'VERIFIED')];
      return null;
    };
    const result = await adminPaymentAction('u1', 's1', 'mark_refunded', 'app_ok');
    expect(result.state).toBe('VERIFIED');
    const refund = db.state.calls.find((c) => c.text.includes("state = 'REFUNDED'"))!;
    expect(refund.text).toContain("state = 'VERIFIED'");
    const ent = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    expect(ent.params[3]).toBe('PRO_REFUNDED');
  });

  it('rejects unknown admin actions', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvedApproval('app_ok')];
      if (text.includes('FROM payment_sessions')) return [session('s1', 'VERIFIED')];
      return null;
    };
    await expect(adminPaymentAction('u1', 's1', 'forgive' as 'revoke', 'app_ok')).rejects.toMatchObject({
      errorCode: 'invalid_action',
    });
  });

  it('system-scoped tool path refuses an expired approval', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) {
        return [{ ...approvedApproval('app_old'), expires_at: new Date(Date.now() - 60_000) }];
      }
      if (text.includes('FROM payment_sessions')) return [session('s1', 'VERIFIED')];
      return null;
    };
    await expect(systemAdminPaymentAction('s1', 'revoke', 'app_old')).rejects.toMatchObject({
      errorCode: 'approval_expired',
    });
  });
});

// ------------------------------------------------------------------ audit log
describe('payment audit linkage', () => {
  it('writes audit rows for admin actions via logPaymentAudit', async () => {
    await logPaymentAudit('s1', 'u1', 'admin.revoke', { approvalId: 'app_ok' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_audit'))!;
    expect(insert).toBeDefined();
    expect(insert.params[2]).toBe('u1');
    expect(insert.params[3]).toBe('admin.revoke');
  });
});

// ------------------------------------------------------------------ getSession
describe('getSession tenant isolation (Phase 4D)', () => {
  it('always filters sessions by user id', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM payment_sessions')) return [{ ...session(String(params[0]), 'PENDING') }];
      return null;
    };
    await getSession('u2', 's1');
    const call = db.state.calls.find((c) => c.text.includes('FROM payment_sessions'))!;
    expect(call.text).toContain('user_id = $2');
    expect(call.params[1]).toBe('u2');
  });
});