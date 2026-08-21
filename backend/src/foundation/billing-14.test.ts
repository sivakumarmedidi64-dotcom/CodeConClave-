/**
 * CodeConClave — PHASE 14 billing UX tests.
 * Covers: entitlement JSON visibility contract (frontend-facing fields),
 * plan cancellation request flow (eligibility, admin approval proposal,
 * audit), and the client-authoritative-entitlement guard (frontend may only
 * reflect server state; PENDING is never Pro).
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
    return { rows: rows ?? state.rows, rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return (result.rows[0] as Record<string, unknown>) ?? null;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const proposeApproval = vi.hoisted(() => vi.fn(async () => ({ approval: { id: 'ap1', status: 'PENDING', action_type: 'PAYMENT_OP' } })));
vi.mock('../modules/execution/approvals.js', () => ({ proposeApproval }));

import { env } from '../config/env.js';
import {
  paymentCapability,
  toEntitlementJson,
  requestPlanCancellation,
  getEntitlements,
} from '../modules/payments/service.js';
import { effectivePlan, limitsFor, type PlanId } from '../modules/entitlements/service.js';

const originalEnv: Record<string, unknown> = {};
beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  proposeApproval.mockClear();
  for (const key of ['RAZORPAY_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
    originalEnv[key] = env[key as keyof typeof env];
  }
  env.RAZORPAY_MODE = 'payment_link';
});

afterEach(() => {
  for (const key of ['RAZORPAY_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
    (env as Record<string, unknown>)[key] = originalEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('billing capability (server-driven pricing)', () => {
  it('reports payment-link-only capability with the plan catalog', () => {
    const cap = paymentCapability();
    expect(cap.mode).toBe('payment_link');
    expect(cap.link).toBe(true);
    expect(cap.api).toBe(false);
    expect(cap.webhook).toBe(false);
    expect(cap.plans).toEqual(expect.objectContaining({ pro: 999, team: 4999 }));
  });

  it('reports full capability when API + webhook are configured', () => {
    env.RAZORPAY_MODE = 'webhook';
    env.RAZORPAY_KEY_ID = 'rzp_x';
    env.RAZORPAY_KEY_SECRET = 'rzp_y';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_z';
    const cap = paymentCapability();
    expect(cap.api).toBe(true);
    expect(cap.webhook).toBe(true);
  });
});

describe('entitlement visibility contract', () => {
  it('maps server rows to the frontend-facing JSON contract', () => {
    const json = toEntitlementJson({
      id: 'ent1',
      user_id: 'u1',
      plan_id: 'pro',
      state: 'PRO_VERIFIED',
      verified_at: '2026-08-01T10:00:00.000Z',
      expires_at: null,
      reason: null,
      payment_session_id: 'ps1',
      created_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
    });
    expect(json).toEqual({
      id: 'ent1',
      planId: 'pro',
      state: 'PRO_VERIFIED',
      activatedAt: '2026-08-01T10:00:00.000Z',
      expiresAt: null,
      reason: null,
      sessionId: 'ps1',
    });
  });

  it('exposes all states to the frontend honestly', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements')
        ? [
            { id: 'e1', user_id: 'u1', plan_id: 'pro', state: 'PRO_VERIFIED', verified_at: null, expires_at: null, reason: null, payment_session_id: 'p1', created_at: new Date(), updated_at: new Date() },
            { id: 'e2', user_id: 'u1', plan_id: 'pro', state: 'PRO_PENDING', verified_at: null, expires_at: null, reason: null, payment_session_id: 'p2', created_at: new Date(), updated_at: new Date() },
          ]
        : null;
    const rows = await getEntitlements('u1');
    expect(rows.map((r) => r.state).sort()).toEqual(['PRO_PENDING', 'PRO_VERIFIED']);
  });

  it('never grants full access from PENDING state (server-authoritative)', async () => {
    const entFor = (state: string) => (text: string) =>
      text.includes('FROM entitlements') ? [{ state }] : null;
    db.state.resolve = (text) =>
      text.includes('FROM users') ? [{ plan_id: 'pro' }] : entFor('PRO_PENDING')(text);
    await expect(effectivePlan('u1')).resolves.toBe('free');
    db.state.resolve = (text) =>
      text.includes('FROM users') ? [{ plan_id: 'pro' }] : entFor('PRO_VERIFIED')(text);
    await expect(effectivePlan('u1')).resolves.toBe('pro');
    db.state.resolve = (text) =>
      text.includes('FROM users') ? [{ plan_id: 'pro' }] : entFor('REVOKED')(text);
    await expect(effectivePlan('u1')).resolves.toBe('free');
  });

  it('maps verified plans to the right limits', () => {
    expect(limitsFor('pro').DAILY_MESSAGES).toBe(200);
    expect(limitsFor('free').MAX_PROJECTS).toBe(1);
  });
});

describe('plan cancellation request', () => {
  it('requests cancellation for a PENDING session and proposes an admin approval', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM payment_sessions')
        ? [{ id: 'ps1', user_id: 'u1', plan_id: 'pro', state: 'PENDING', status_url: 'https://rzp.link/x', error_code: null, error_message: null, created_at: new Date(), updated_at: new Date() }]
        : null;
    const result = await requestPlanCancellation('u1', 'ps1', 'no longer needed');
    expect(result.approval.id).toBe('ap1');
    expect(proposeApproval).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ actionType: 'payment_op', riskLevel: 'HIGH' }),
    );
    const auditInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO payment_audit'))!;
    expect(auditInsert).toBeDefined();
    expect(String(auditInsert.params[3])).toContain('cancel_requested');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plan.cancellation_requested' }));
  });

  it('rejects cancellation for non-cancellable sessions', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM payment_sessions')
        ? [{ id: 'ps1', user_id: 'u1', plan_id: 'pro', state: 'EXPIRED', status_url: null, error_code: null, error_message: null, created_at: new Date(), updated_at: new Date() }]
        : null;
    await expect(requestPlanCancellation('u1', 'ps1')).rejects.toThrow(/only PENDING or VERIFIED/);
    expect(proposeApproval).not.toHaveBeenCalled();
  });

  it('rejects cancellation when the session belongs to another user', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM payment_sessions') && params[1] === 'u1') return [];
      return null;
    };
    await expect(requestPlanCancellation('u1', 'ps1')).rejects.toThrow(/Payment session/);
    expect(proposeApproval).not.toHaveBeenCalled();
  });
});