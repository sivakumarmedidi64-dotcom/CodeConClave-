/**
 * CodeConClave — Gmail claim rail hardening tests.
 *
 * Exercises the two service-level guards added on top of the existing
 * pure-signature suite:
 *   1. Defensive payload shape guard — requestGmailClaim fails closed with a
 *      clean bad request (errorCode invalid_payload) instead of crashing when
 *      called with a malformed request (route can't produce it, but a direct
 *      caller can).
 *   2. Plan-consistency guard — the claimed plan must equal the resolved
 *      intent's plan. Without it, a claim whose amount check is skipped
 *      (no amount in payload) or whose amount coincidentally matches the
 *      *claimed* plan's price could target a different-plan intent.
 *
 * A happy-path sanity test verifies the harness wiring (DB-mocked claim
 * creation + claim email enqueue).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock DB (matches repo convention: vi.hoisted mock of ../../shared/db.js)
// ---------------------------------------------------------------------------
const mock = vi.hoisted(() => {
  const state: {
    intentByRef: Record<string, Record<string, unknown>>;
  } = { intentByRef: {} };
  const reset = () => {
    state.intentByRef = {};
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

vi.mock('../../shared/db.js', () => mock);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));
const enqueueOutbox = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../modules/outbox/service.js', () => ({ enqueueOutbox }));
vi.mock('../../modules/email/brand.js', () => ({ wrapEmailHtml: () => '' }));

// Enable the rail by overriding the env singleton (config/env is snapshotted
// once at import, so override via the module mock, keeping all real defaults).
vi.mock('../../config/env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config/env.js')>();
  return {
    env: {
      ...real.env,
      GMAIL_CLAIM_ENABLED: 'true',
      GMAIL_CLAIM_HMAC_SECRET: 'test-secret-key-for-hmac-signing-32bytes!',
    },
  };
});

import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { requestGmailClaim } from './gmail-claim.js';

const SECRET = 'test-secret-key-for-hmac-signing-32bytes!';

function signedPayload(payload: Record<string, unknown>, timestamp = Math.floor(Date.now() / 1000)): {
  payload: Record<string, unknown>;
  timestamp: number;
  signature: string;
} {
  const message = `${timestamp}:${JSON.stringify(payload)}`;
  const signature = createHmac('sha256', SECRET).update(message).digest('hex');
  return { payload, timestamp, signature };
}

function bindDefaultHandler(): void {
  mock.setHandler((text, params) => {
    const t = text.trim();
    if (t.startsWith('SELECT id FROM payment_claims')) return [];
    if (t.startsWith('SELECT id, owner_id, plan_id')) {
      const intent = mock.state.intentByRef[params[0] as string];
      return intent ? [{ ...intent }] : [];
    }
    return [];
  });
}

beforeEach(() => {
  mock.reset();
  recordAudit.mockClear();
  notify.mockClear();
  enqueueOutbox.mockClear();
  bindDefaultHandler();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestGmailClaim hardening: malformed payload fails closed (no crash, clean 400)', () => {
  it('rejects a null request with invalid_payload', async () => {
    await expect(requestGmailClaim(null as never)).rejects.toMatchObject({
      status: 400,
      errorCode: 'invalid_payload',
    });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('rejects a request whose payload is not an object', async () => {
    await expect(
      requestGmailClaim({ payload: 'not-an-object' as never, timestamp: 1, signature: 'x' }),
    ).rejects.toMatchObject({ status: 400, errorCode: 'invalid_payload' });
  });
});

describe('requestGmailClaim hardening: plan consistency between claim and resolved intent', () => {
  it('blocks a TEAM claim whose reference resolves to a PRO intent — even when the amount matches the claimed (TEAM) price', async () => {
    mock.state.intentByRef['CCPRO-123456'] = {
      id: 'int_pro_1',
      owner_id: 'u-001',
      plan_id: 'pro',
      amount_inr: 999,
      reference: 'CCPRO-123456',
      status: 'PENDING',
    };

    // amount 4999 passes the amount check (TEAM price) — the mismatch must
    // still be caught at the plan-consistency guard.
    const req = signedPayload({
      paymentId: 'pay_999',
      amount: null, // even with the amount check skipped, the plan guard must hold
      plan: 'team',
      payerEmail: 'payer@example.com',
      paidAt: '2026-08-31T11:00:00Z',
      reference: 'CCPRO-123456',
    });

    await expect(requestGmailClaim(req as never)).rejects.toMatchObject({
      status: 400,
      errorCode: 'plan_mismatch',
    });
    // No claim token must be minted and no claim email queued.
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.gmail_claim_plan_mismatch' }),
    );
  });
});

describe('requestGmailClaim happy-path sanity (harness wiring)', () => {
  it('creates a claim and enqueues the claim email for a matching pro/pro claim', async () => {
    mock.state.intentByRef['CCPRO-123456'] = {
      id: 'int_pro_1',
      owner_id: 'u-001',
      plan_id: 'pro',
      amount_inr: 999,
      reference: 'CCPRO-123456',
      status: 'PENDING',
    };

    const req = signedPayload({
      paymentId: 'pay_happy',
      amount: 999,
      plan: 'pro',
      payerEmail: 'payer@example.com',
      paidAt: '2026-08-31T11:00:00Z',
      reference: 'CCPRO-123456',
    });

    const result = await requestGmailClaim(req as never);
    expect(result.status).toBe('pending');
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.gmail_claim_created', resourceType: 'payment_claim' }),
    );
  });
});