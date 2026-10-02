/**
 * CodeConClave — EVIDENCE INGESTION ROUTE TRUST-BOUNDARY TEST.
 *
 * Regression test for a P0 trust bypass: POST /api/v1/payments/intents/:id/evidence
 * forwarded ANY user-supplied `source` into ingestEvidence(). The server-driven
 * sources (razorpay_autopilot / razorpay_callback / razorpay_webhook) anchor the
 * intent's OWN reference inside collect() and score user-supplied paymentId /
 * amount / payerEmail — so an authenticated user could self-assert a paid
 * entitlement (confidence 1.00 → ACTIVE → activateEntitlement) without paying.
 *
 * The route now allowlists user-asserted sources ('ocr', 'manual') only.
 * Server-driven sources are ingested exclusively via their internal callers
 * (signed webhook handler, pool callback, autopilot sweep, IMAP poller,
 * refresh) which call ingestEvidence() directly and are unaffected by the gate.
 *
 * Strategy: ROUTE TESTED — INFRA MOCKED. Real Express app, real auth
 * middleware (session JOIN), real CSRF, real route gate. The mock DB records
 * every statement so the test proves no entitlement/activation SQL runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

const mock = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const sessions = new Map<string, Row>();
  const users = new Map<string, Row>();
  const intents = new Map<string, Row>();
  const queries: string[] = [];

  const reset = () => {
    sessions.clear();
    users.clear();
    intents.clear();
    queries.splice(0);
  };

  const handler = (text: string, params: unknown[] = []): Row[] => {
    const t = text.replace(/\s+/g, ' ').trim();
    queries.push(t);
    if (t.includes('FROM sessions s JOIN users u')) {
      const sess = sessions.get(String(params[0]));
      if (!sess) return [];
      const user = users.get(String(sess.user_id));
      if (!user) return [];
      return [{
        id: sess.id, state: sess.state, expires_at: sess.expires_at,
        user_id: user.id, email: user.email, email_verified: true,
        display_name: null, avatar_url: null, google_sub: null, role: null,
        primary_use_case: null, mfa_enabled: false,
        rbac_role: user.rbac_role, plan_id: user.plan_id, entitlement_state: user.entitlement_state,
      }];
    }
    if (t.startsWith('UPDATE sessions SET last_seen_at')) return [];
    if (t.startsWith('SELECT * FROM payment_intents WHERE id = $1 AND owner_id')) {
      const it = intents.get(String(params[0]));
      if (!it || it.owner_id !== params[1]) return [];
      return [{ ...it }];
    }
    return [];
  };

  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      const rows = handler(text, params);
      return { rows, rowCount: rows.length };
    },
  };
  return {
    sessions, users, intents, queries, reset,
    pool,
    query: pool.query,
    queryOne: async (text: string, params: unknown[] = []) => handler(text, params)[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => handler(text, params),
    withTenant: async (_userId: string | null, fn: (q: { query: typeof pool.query }) => Promise<unknown>) => fn({ query: pool.query }),
    withSystem: async (fn: (q: { query: typeof pool.query }) => Promise<unknown>) => fn({ query: pool.query }),
  };
});

vi.mock('../shared/db.js', () => mock);
vi.mock('../shared/cache.js', () => ({
  cache: {
    kind: 'memory', health: async () => true, incr: async () => 1, get: async () => null, set: async () => {},
  },
}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox: vi.fn(async () => {}) }));
vi.mock('../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { sha256Hex } from '../shared/crypto.js';
import { isUserAssertableEvidenceSource } from '../modules/payments/pipeline.js';

const USER = 'usr-evidence';
const CSRF = 'evidence-csrf-token';

function setupEnv(): void {
  env.RAZORPAY_WEBHOOK_ENABLED = 'true';
  env.RAZORPAY_WEBHOOK_SECRET = 'whsec_evidence_test';
  env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  env.RAZORPAY_KEY_ID = 'rzp_test_key';
}

function seed(): string {
  mock.sessions.set(sha256Hex('tok-e'), {
    id: 'sess-evidence', state: 'ACTIVE', expires_at: new Date(Date.now() + 3_600_000), user_id: USER,
  });
  mock.users.set(USER, {
    id: USER, email: `${USER}@codeconclave.test`, email_verified: true,
    rbac_role: 'member', plan_id: 'free', entitlement_state: 'FREE',
  });
  const intentId = 'pin_evidence_pro';
  mock.intents.set(intentId, {
    id: intentId, owner_id: USER, plan_id: 'pro', amount_inr: 999, currency: 'INR',
    reference: 'CCPRO-EVID01', mode: 'PAYMENT_LINK', status: 'PENDING',
    confidence: 0, decision: null, fraud_flags: null,
    expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
    purchase_type: 'solo',
  });
  return intentId;
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postEvidence(base: string, intentId: string, body: unknown): Promise<{ status: number; data: { error?: { code?: string } } & Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/payments/intents/${intentId}/evidence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `codeconclave_csrf=${CSRF}; cc_session=tok-e`,
      'X-CSRF-Token': CSRF,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as never };
}

function activationSqlRan(): string[] {
  return mock.queries.filter(
    (q) => q.includes('entitlements') || q.includes('UPDATE payment_intents') || q.includes('INSERT INTO payment_evidence'),
  );
}

beforeEach(() => {
  mock.reset();
  setupEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evidence source allowlist (unit)', () => {
  it('admits only user-asserted sources', () => {
    expect(isUserAssertableEvidenceSource('ocr')).toBe(true);
    expect(isUserAssertableEvidenceSource('manual')).toBe(true);
    for (const s of ['razorpay_webhook', 'razorpay_callback', 'razorpay_autopilot', 'gmail', 'gmail_imap', 'razorpay_api', '', 'MANUAL']) {
      expect(isUserAssertableEvidenceSource(s)).toBe(false);
    }
  });
});

describe('POST /api/v1/payments/intents/:id/evidence (trust boundary)', () => {
  it('rejects a forged razorpay_autopilot payload (403) and runs no activation SQL', async () => {
    const intentId = seed();
    await withServer(async (base) => {
      const { status, data } = await postEvidence(base, intentId, {
        source: 'razorpay_autopilot',
        payload: {
          paymentId: 'pay_forged_autopilot_001',
          amountInr: 999,
          payerEmail: `${USER}@codeconclave.test`,
          paidAt: new Date().toISOString(),
        },
      });
      expect(status).toBe(403);
      expect(data.error?.code).toBe('evidence_source_not_user_assertable');
      expect(activationSqlRan()).toEqual([]);
    });
  });

  it('rejects forged razorpay_callback / razorpay_webhook / gmail payloads (403)', async () => {
    const intentId = seed();
    await withServer(async (base) => {
      for (const source of ['razorpay_callback', 'razorpay_webhook', 'gmail', 'gmail_imap', 'razorpay_api']) {
        const { status, data } = await postEvidence(base, intentId, {
          source,
          payload: { paymentId: 'pay_forged_x', amountInr: 999 },
        });
        expect(status).toBe(403);
        expect(data.error?.code).toBe('evidence_source_not_user_assertable');
      }
      expect(activationSqlRan()).toEqual([]);
    });
  });

  it('rejects unknown/missing sources without reaching the pipeline', async () => {
    const intentId = seed();
    await withServer(async (base) => {
      for (const body of [{ source: 'provider_receipt' }, {}]) {
        const { status, data } = await postEvidence(base, intentId, body);
        expect(status).toBe(403);
        expect(data.error?.code).toBe('evidence_source_not_user_assertable');
      }
      expect(activationSqlRan()).toEqual([]);
    });
  });

  it('still accepts user-asserted manual evidence (passes the gate into the pipeline)', async () => {
    const intentId = seed();
    await withServer(async (base) => {
      const { status, data } = await postEvidence(base, intentId, { source: 'manual', payload: {} });
      // Empty manual payload reaches the service and fails there (no usable
      // signals) — the point is it is NOT rejected by the trust gate.
      expect(data.error?.code).not.toBe('evidence_source_not_user_assertable');
      expect(status).not.toBe(403);
    });
  });
});
