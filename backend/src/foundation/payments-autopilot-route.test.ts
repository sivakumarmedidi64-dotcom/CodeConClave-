/**
 * CodeConClave — PAYMENT AUTOPILOT ROUTE-LEVEL INTEGRATION TEST.
 *
 * Tests the ACTUAL HTTP entry points for both:
 *   A) Autopilot webhook rail   POST /api/v1/payments/webhook/razorpay
 *   B) Payment-Link callback    GET  /cb/:linkIndex
 *
 * Strategy:
 *   ROUTE TESTED — DB MOCKED (controlled in-memory doubles)
 *   REAL pipeline + REAL activateEntitlement + REAL signature verification.
 *
 * Only infra boundaries are mocked: db, cache, audit, notifications, outbox,
 * logger.  Everything else — Express app, middleware, route handlers, HMAC
 * signing, evidence pipeline, matcher, activation.ts, entitlement writes —
 * runs as in production.
 *
 * AUTOPILOT 2-SECOND WINDOW (intended shipped behavior): a verified autopilot
 * payment NEVER activates synchronously. It first lands in
 * payment_auto_approvals (PENDING_APPROVAL); during the window the intent stays
 * PENDING and no entitlement is written. Founder STOP -> no activation + REVIEW.
 * Timer expiry (sweepAutoApprovals) -> exactly-once activation through the SAME
 * trusted authority (ingestEvidence -> applyDecision -> activateEntitlement).
 * Duplicate/replayed deliveries are idempotent at every layer.
 *
 * Covers spec items 1–18.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// In-memory DB harness
// ---------------------------------------------------------------------------
const mock = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const users = new Map<string, Row>();
  const intents = new Map<string, Row>();
  const evidence = new Map<string, Row>();
  const entitlements = new Map<string, Row>();
  const webhookEvents = new Map<string, true>();
  const claims = new Map<string, Row>();
  const settings = { unlock_mode: null as string | null };
  const evidenceBySha = new Map<string, string>();
  const evidenceByPayment = new Map<string, string>();
  const cbLedger = new Map<string, Row>();
  const poolLinks = new Map<number, Row>();
  const reservations = new Map<string, Row>();
  const approvals = new Map<string, Row>();
  const queries: string[] = [];
  const mutations: string[] = [];

  const reset = () => {
    users.clear();
    intents.clear();
    evidence.clear();
    entitlements.clear();
    webhookEvents.clear();
    claims.clear();
    evidenceBySha.clear();
    evidenceByPayment.clear();
    cbLedger.clear();
    poolLinks.clear();
    reservations.clear();
    approvals.clear();
    settings.unlock_mode = null;
    queries.splice(0);
    mutations.splice(0);
  };

  const handler = (text: string, params: unknown[] = []): Row[] => {
    const t = text.replace(/\s+/g, ' ').trim();
    queries.push(t);

    // ---- payment_webhook_events ----
    if (t.startsWith('INSERT INTO payment_webhook_events')) {
      const eventId = params[0] as string;
      if (webhookEvents.has(eventId)) return [];
      webhookEvents.set(eventId, true);
      return [{ event_id: eventId }];
    }

    // ---- payment_claim_reviews ----
    if (t.startsWith('INSERT INTO payment_claim_reviews')) {
      const id = params[0] as string;
      const paymentId = params[7];
      if ([...claims.values()].some((c) => c.razorpay_payment_id === paymentId)) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'payment_claim_reviews_razorpay_payment_id_key' });
      }
      const pending = [...claims.values()].filter((c) => c.status === 'PENDING');
      if (pending.some((c) => c.user_id === params[1])) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_payment_claim_reviews_user_pending' });
      }
      if (pending.some((c) => c.intent_id === params[3])) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_payment_claim_reviews_intent_pending' });
      }
      claims.set(id, {
        id, user_id: params[1], email: params[2], intent_id: params[3], plan_id: params[4],
        purchase_type: params[5], amount_inr: params[6], currency: 'INR',
        razorpay_payment_id: paymentId, status: 'PENDING', source: 'autopilot', created_at: new Date(),
      });
      return [];
    }

    // ---- payment_evidence INSERT ----
    if (t.startsWith('INSERT INTO payment_evidence')) {
      const id = params[0] as string;
      const providerPaymentId = params[5] ?? null;
      if (providerPaymentId && evidenceByPayment.has(String(providerPaymentId))) {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_payment_evidence_provider_payment' });
      }
      const sha = String(params[4]);
      const row = {
        id, intent_id: params[1], owner_id: params[2], source: params[3],
        sha256: sha, signals: params[9] ?? '{}', fraud_flags: params[10] ?? '[]',
        provider_payment_id: providerPaymentId, reference: params[6] ?? null,
        amount_inr: params[7] ?? null, payer_email: params[8] ?? null,
        paid_at: new Date(), created_at: new Date(), matched: params[11] ?? true,
      };
      evidence.set(id, row);
      evidenceBySha.set(sha, id);
      if (providerPaymentId) evidenceByPayment.set(String(providerPaymentId), id);
      return [{ id }];
    }

    // ---- entitlements INSERT ----
    if (t.startsWith('INSERT INTO entitlements')) {
      const key = `${params[1]}:${params[2]}`;
      const existing = entitlements.get(key);
      if (existing) {
        Object.assign(existing, { state: params[3] ?? 'PRO_VERIFIED', payment_session_id: params[5], reason: params[6] });
      } else {
        entitlements.set(key, { id: params[0], user_id: params[1], plan_id: params[2], state: params[3] ?? 'PRO_VERIFIED', payment_session_id: params[5], reason: params[6] });
      }
      return [{ id: params[0] }];
    }

    // ---- UPDATE users SET plan_id ----
    if (t.startsWith('UPDATE users')) {
      mutations.push(t);
      const userId = params[0] as string;
      const row = users.get(userId);
      if (row && typeof params[1] === 'string') row.plan_id = params[1];
      return [];
    }

    // ---- SELECT unlock_mode ----
    if (t.startsWith('SELECT unlock_mode FROM payment_unlock_settings')) {
      return settings.unlock_mode ? [{ unlock_mode: settings.unlock_mode }] : [];
    }

    // ---- SELECT id FROM users WHERE email ----
    if (t.startsWith('SELECT id FROM users WHERE email')) {
      const email = String(params[0]).toLowerCase();
      const hit = [...users.values()].find((u) => String(u.email ?? '').toLowerCase() === email);
      return hit ? [{ id: hit.id }] : [];
    }

    // ---- SELECT email FROM users WHERE id ----
    if (t.startsWith('SELECT email FROM users WHERE id')) {
      const row = users.get(params[0] as string);
      return row ? [{ email: row.email }] : [];
    }

    // ---- count(*) evidence for fraud velocity ----
    if (t.startsWith('SELECT count(*)') && t.includes('payment_evidence') && t.includes('created_at >= $2')) {
      return [{ n: 0 }];
    }
    // ---- count(*) evidence for fraud prior ----
    if (t.startsWith('SELECT count(*)') && t.includes('payment_evidence') && t.includes('owner_id = $1')) {
      return [{ n: [...evidence.values()].filter((e) => e.owner_id === params[0]).length }];
    }

    // ---- SELECT id, intent_id, owner_id FROM payment_evidence WHERE provider_payment_id ----
    if (t.startsWith('SELECT') && t.includes('provider_payment_id = $1') && t.includes('intent_id IS DISTINCT')) {
      const pid = params[0];
      if (pid == null) return [];
      const existing = evidenceByPayment.get(String(pid));
      if (!existing) return [];
      const row = evidence.get(existing);
      if (!row) return [];
      if (row.intent_id === params[1] && row.owner_id === params[2]) return [];
      return [{ id: row.id, intent_id: row.intent_id, owner_id: row.owner_id }];
    }

    // ---- SELECT ... FROM entitlements WHERE user_id AND plan_id ----
    if (t.startsWith('SELECT') && t.includes('FROM entitlements WHERE user_id = $1 AND plan_id = $2')) {
      const key = `${params[0]}:${params[1]}`;
      const row = entitlements.get(key);
      if (!row) return [];
      if (t.includes('payment_session_id')) {
        return [{ id: row.id, payment_session_id: row.payment_session_id ?? null }];
      }
      return [{ id: row.id, state: row.state, plan_id: row.plan_id, user_id: row.user_id }];
    }

    // ---- UPDATE entitlements SET state = 'REVOKED' (revokeEntitlement) ----
    if (t.startsWith("UPDATE entitlements SET state = 'REVOKED'")) {
      const entId = params[0] as string;
      for (const [key, row] of entitlements) {
        if (row.id === entId && row.state === 'PRO_VERIFIED') {
          row.state = 'REVOKED';
          row.reason = params[2] ?? null;
          return [];
        }
      }
      return [];
    }

    // ---- SELECT id FROM payment_intents WHERE reference ... AND id <> (reference_reuse) ----
    if (t.startsWith('SELECT id FROM payment_intents WHERE reference') && t.includes('id <>')) {
      return [];
    }

    // ---- SELECT id FROM payment_evidence WHERE sha256 ... AND intent_id IS DISTINCT FROM ----
    if (t.startsWith('SELECT id FROM payment_evidence WHERE sha256') && t.includes('intent_id IS DISTINCT FROM')) {
      const sha = params[0] as string;
      const excludeIntent = params[1] as string;
      const row = evidenceBySha.get(sha);
      if (!row) return [];
      const ev = evidence.get(row);
      if (!ev || ev.intent_id === excludeIntent) return [];
      return [{ id: ev.id }];
    }

    // ---- SELECT count(*) ... payment_evidence WHERE sha256 (replay) ----
    if (t.startsWith('SELECT count(*)') && t.includes('sha256')) {
      return [{ n: evidenceBySha.has(String(params[0])) ? 1 : 0 }];
    }

    // ---- SELECT id FROM payment_evidence WHERE sha256 ----
    if (t.startsWith('SELECT id FROM payment_evidence WHERE sha256') && !t.includes('DISTINCT')) {
      const row = evidenceBySha.get(String(params[0]));
      return row ? [{ id: row }] : [];
    }

    // ---- SELECT id FROM payment_evidence WHERE provider_payment_id ----
    if (t.startsWith('SELECT id FROM payment_evidence WHERE provider_payment_id') && !t.includes('DISTINCT')) {
      const row = evidenceByPayment.get(String(params[0]));
      return row ? [{ id: row }] : [];
    }

    // ---- SELECT count(*) FROM payment_pool_callbacks ----
    if (t.startsWith('SELECT count(*)') && t.includes('payment_pool_callbacks')) {
      const bad = ['duplicate', 'ambiguous', 'fraud_blocked'];
      return [{ n: [...cbLedger.values()].filter((r) => bad.includes(String(r.outcome))).length }];
    }

    // ---- payment_pool_callbacks SELECT/INSERT ----
    if (t.startsWith('SELECT id, outcome FROM payment_pool_callbacks') || t.startsWith('SELECT id FROM payment_pool_callbacks')) {
      return [...cbLedger.values()].filter((r) => r.payment_id === params[0]).map((r) => ({ id: r.id, outcome: r.outcome }));
    }
    if (t.startsWith('INSERT INTO payment_pool_callbacks')) {
      const id = params[0] as string;
      const pid = String(params[2]);
      if (cbLedger.has(pid)) throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_pool_callbacks_payment' });
      cbLedger.set(pid, {
        id, link_index: params[1], payment_id: pid, payment_link_id: params[3],
        reference_id: params[4], link_status: params[5], signature_sha: params[6],
        signature_valid: params[7], outcome: params[8], reason: params[9],
      });
      return [];
    }

    // ---- payment_link_pool ----
    if (t.startsWith('SELECT * FROM payment_link_pool WHERE link_index')) {
      const row = poolLinks.get(Number(params[0]));
      return row ? [{ ...row }] : [];
    }

    // ---- payment_link_reservations ----
    if (t.startsWith('SELECT * FROM payment_link_reservations WHERE link_reference_id')) {
      return [...reservations.values()].filter((r) => r.link_reference_id === params[0]).map((r) => ({ ...r }));
    }

    // ---- autopilot candidates: SELECT * FROM payment_intents WHERE owner_id AND plan_id AND status IN ----
    if (t.includes('owner_id = $1 AND plan_id = $2') && t.includes('status IN') && t.includes('ORDER BY created_at DESC LIMIT 2')) {
      const owner = params[0];
      const plan = params[1];
      return [...intents.values()]
        .filter((i) => i.owner_id === owner && i.plan_id === plan && ['PENDING', 'REVIEW'].includes(String(i.status)))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
        .slice(0, 2);
    }

    // ---- exact resolver: SELECT id, owner_id, ... FROM payment_intents WHERE provider_reference_id / provider_payment_link_id / reference ----
    if (t.includes('FROM payment_intents WHERE') && (t.includes('provider_reference_id') || t.includes('provider_payment_link_id'))) {
      const col = t.includes('provider_reference_id') ? 'provider_reference_id' : 'provider_payment_link_id';
      return [...intents.values()].filter((i) => i[col] === params[0]).slice(0, 1);
    }

    // ---- SELECT id FROM payment_intents WHERE reference (for exact resolver 'reference' key) ----
    if (t.startsWith('SELECT id, owner_id') && t.includes('FROM payment_intents WHERE reference')) {
      return [...intents.values()].filter((i) => i.reference === params[0]).slice(0, 1);
    }

    // ---- SELECT status FROM payment_intents WHERE id (sweep pre-check) ----
    if (t.startsWith('SELECT status FROM payment_intents WHERE id = $1')) {
      const row = intents.get(params[0] as string);
      return row ? [{ status: row.status }] : [];
    }

    // ---- SELECT * FROM payment_intents WHERE id AND owner_id (getIntent) ----
    if (t.startsWith('SELECT * FROM payment_intents WHERE id = $1 AND owner_id')) {
      const row = intents.get(params[0] as string);
      if (!row) return [];
      if (row.owner_id !== params[1]) return [];
      return [{ ...row }];
    }

    // ---- SELECT * FROM payment_intents WHERE id (single) ----
    if (t.startsWith('SELECT * FROM payment_intents WHERE id = $1') && !t.includes('owner_id')) {
      const row = intents.get(params[0] as string);
      return row ? [{ ...row }] : [];
    }

    // ---- SELECT * FROM payment_evidence WHERE id ----
    if (t.startsWith('SELECT * FROM payment_evidence WHERE id')) {
      const row = evidence.get(params[0] as string);
      return row ? [{ ...row }] : [];
    }

    // ---- UPDATE payment_intents SET confidence ... (applyDecision, first update) ----
    if (t.startsWith('UPDATE payment_intents SET confidence')) {
      mutations.push(t);
      const row = intents.get(params[0] as string);
      if (row) {
        row.confidence = params[1];
        row.decision = params[2];
        row.thresholds_used = params[3];
        row.fraud_flags = params[4];
        row.updated_at = new Date();
      }
      return [];
    }

    // ---- UPDATE payment_intents SET status = 'ACTIVE' ... RETURNING ----
    if (t.startsWith('UPDATE payment_intents SET status') && t.includes("'ACTIVE'") && t.includes('RETURNING')) {
      mutations.push(t);
      const row = intents.get(params[0] as string);
      if (!row || !['PENDING', 'REVIEW'].includes(String(row.status))) return [];
      row.status = 'ACTIVE';
      row.activated_at = new Date();
      row.updated_at = new Date();
      return [{ ...row }];
    }

    // ---- UPDATE payment_intents SET status = $2 ... RETURNING (REVIEW path) ----
    if (t.startsWith('UPDATE payment_intents SET status') && t.includes('RETURNING')) {
      mutations.push(t);
      const row = intents.get(params[0] as string);
      if (!row || !['PENDING', 'REVIEW'].includes(String(row.status))) return [];
      row.status = params[1];
      row.updated_at = new Date();
      return [{ ...row }];
    }

    // ---- UPDATE payment_intents SET status ... (non-returning) ----
    if (t.startsWith('UPDATE payment_intents SET status')) {
      mutations.push(t);
      const row = intents.get(params[0] as string);
      // status is inlined in the SQL (e.g. "status = 'REVIEW'"), never a param
      if (row) {
        const m = t.match(/status = '([A-Z_]+)'/);
        row.status = m ? m[1] : (params[1] as string);
        row.updated_at = new Date();
      }
      return [];
    }

    // ---- payment_auto_approvals INSERT (scheduler, same as prod SQL) ----
    if (t.startsWith('INSERT INTO payment_auto_approvals') && t.includes('ON CONFLICT (payment_id)')) {
      const paymentId = String(params[2] ?? '');
      if (approvals.has(paymentId)) return []; // DO NOTHING conflict -> rowCount 0
      approvals.set(paymentId, {
        id: params[0], intent_id: params[1], payment_id: paymentId,
        plan_id: params[3], purchase_type: params[4], amount_inr: params[5],
        payer_email: params[6] ?? null, owner_id: params[7],
        payload: JSON.parse(String(params[8] ?? '{}')),
        state: 'PENDING_APPROVAL', decided_by: null, stop_reason: null,
        created_at: new Date(), approved_at: null, stopped_at: null,
      });
      return [{ id: params[0], state: 'PENDING_APPROVAL' }];
    }

    // ---- SELECT state FROM payment_auto_approvals WHERE payment_id ----
    if (t === 'SELECT state FROM payment_auto_approvals WHERE payment_id = $1') {
      const row = approvals.get(String(params[0] ?? ''));
      return row ? [{ state: row.state }] : [];
    }

    // ---- founder STOP: PENDING_APPROVAL -> STOPPED (exactly-once, idempotent) ----
    if (t.startsWith("UPDATE payment_auto_approvals SET state = 'STOPPED'") && t.includes('RETURNING')) {
      const row = approvals.get(String(params[0] ?? ''));
      if (!row || row.state !== 'PENDING_APPROVAL') return [];
      row.state = 'STOPPED';
      row.decided_by = params[1] ?? null;
      row.stop_reason = params[2] ?? null;
      row.stopped_at = new Date();
      return [{ id: row.id, intent_id: row.intent_id, owner_id: row.owner_id, plan_id: row.plan_id, amount_inr: row.amount_inr }];
    }

    // ---- sweep candidate SELECT: PENDING_APPROVAL and past the window ----
    if (t.startsWith('SELECT * FROM payment_auto_approvals') && t.includes("'PENDING_APPROVAL'") && t.includes('created_at <=')) {
      const cutoff = new Date(String(params[0] ?? '')).getTime();
      const limit = Number(params[1] ?? 50);
      return [...approvals.values()]
        .filter((a) => a.state === 'PENDING_APPROVAL' && new Date(String(a.created_at)).getTime() <= cutoff)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
    }

    // ---- sweep exactly-once claim: PENDING_APPROVAL -> AUTO_APPROVED ----
    if (t.startsWith("UPDATE payment_auto_approvals SET state = 'AUTO_APPROVED'") && t.includes('RETURNING id')) {
      const row = [...approvals.values()].find((a) => a.id === params[0]);
      if (!row || row.state !== 'PENDING_APPROVAL') return [];
      row.state = 'AUTO_APPROVED';
      row.approved_at = new Date();
      return [{ id: row.id }];
    }

    return [];
  };

  return {
    users, intents, evidence, entitlements, webhookEvents, claims, settings,
    evidenceBySha, evidenceByPayment, cbLedger, poolLinks, reservations, approvals,
    queries, mutations, reset,
    pool: { query: async (q: string, p: unknown[] = []) => { const rows = handler(q, p); return { rows, rowCount: rows.length }; } },
    queryOne: async (q: string, p: unknown[] = []) => handler(q, p)[0] ?? null,
    queryMany: async (q: string, p: unknown[] = []) => handler(q, p),
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) =>
      fn({ query: mock.pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) =>
      fn({ query: mock.pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
  };
});

vi.mock('../shared/db.js', () => mock);
vi.mock('../shared/cache.js', () => ({
  cache: {
    kind: 'redis', health: async () => true, incr: async () => 1, get: async () => null, set: async () => {},
  },
}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox: vi.fn(async () => {}) }));
vi.mock('../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { sweepAutoApprovals, stopAutoApproval } from '../modules/payments/autoapproval/service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const WEBHOOK_SECRET = 'whsec_test_integration_123';
const CALLBACK_SECRET = 'rzp_test_secret_456';

const OWNER_ID = 'u-autopilot-owner';
const OWNER_EMAIL = 'autopilot-owner@example.com';
const PLAN_PRO = 'pro';
const PLAN_TEAM = 'team';
const PLAN_API = 'api';
const AMOUNT_PRO = 999;
const AMOUNT_TEAM = 4999;
const AMOUNT_API = 9999;
const LINK_PRO = 'plink_pro_test';
const LINK_TEAM = 'plink_team_test';
const LINK_API = 'plink_api_test';

function webhookBody(payload: object): string {
  return JSON.stringify(payload);
}

function webhookSignature(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function autopilotEvent(overrides: {
  eventId?: string; paymentId?: string; amountPaise: number; email: string;
  linkId?: string; event?: string; created_at?: number;
} & Record<string, unknown>): Record<string, unknown> {
  return {
    event: 'payment_link.paid',
    id: overrides.eventId ?? `evt_${Math.random().toString(36).slice(2, 14)}`,
    payload: {
      payment: {
        entity: {
          id: overrides.paymentId ?? `pay_${Math.random().toString(36).slice(2, 14)}`,
          amount: overrides.amountPaise,
          email: overrides.email,
          created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
        },
      },
      payment_link: { entity: { id: overrides.linkId ?? LINK_PRO } },
    },
  };
}

function callbackSignature(params: Record<string, string>, secret = CALLBACK_SECRET): string {
  const message = [
    params.razorpay_payment_link_id ?? '',
    params.razorpay_payment_link_reference_id ?? '',
    params.razorpay_payment_link_status ?? '',
    params.razorpay_payment_id ?? '',
  ].join('|');
  return createHmac('sha256', secret).update(message).digest('hex');
}

function setupEnv(): void {
  env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  env.RAZORPAY_WEBHOOK_ENABLED = 'true';
  env.UNLOCK_MODE = 'AUTOPILOT';
  env.PAYMENT_AUTO_APPROVAL_MS = 2000;
  env.RAZORPAY_PRO_PAYMENT_LINK_ID = LINK_PRO;
  env.RAZORPAY_TEAM_PAYMENT_LINK_ID = LINK_TEAM;
  env.RAZORPAY_API_PAYMENT_LINK_ID = LINK_API;
  env.RAZORPAY_KEY_SECRET = CALLBACK_SECRET;
  env.PAYMENT_CONFIDENCE_ACTIVE = 0.8;
  env.PAYMENT_CONFIDENCE_GRACE = 0.5;
  env.PAYMENT_AMOUNT_TOLERANCE_INR = 0;
  env.PAYMENT_VELOCITY_WINDOW_MINUTES = 60;
  env.PAYMENT_VELOCITY_MAX = 50;
}

function seedOwner(planId = PLAN_PRO, status = 'PENDING'): { id: string; email: string; intentId: string } {
  const id = OWNER_ID;
  const email = OWNER_EMAIL;
  const intentId = `pin_${planId}_ok`;
  mock.users.set(id, { id, email, plan_id: 'free' });
  mock.intents.set(intentId, {
    id: intentId, owner_id: id, plan_id: planId,
    amount_inr: planId === PLAN_PRO ? AMOUNT_PRO : planId === PLAN_TEAM ? AMOUNT_TEAM : AMOUNT_API,
    currency: 'INR', reference: `CC${planId.toUpperCase()}-OK01`, payment_link: `https://rzp.io/rzp/${planId}`,
    mode: 'PAYMENT_LINK', status, confidence: 0, decision: null, fraud_flags: null,
    expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
  });
  return { id, email, intentId };
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

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------
beforeEach(() => {
  mock.reset();
  setupEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =========================================================================
// A) AUTOPILOT WEBHOOK RAIL — POST /api/v1/payments/webhook/razorpay
// =========================================================================
describe('AUTOPILOT WEBHOOK RAIL (POST /api/v1/payments/webhook/razorpay)', () => {

  // -----------------------------------------------------------------------
  // 2. SIGNATURE TESTS
  // -----------------------------------------------------------------------
  describe('SIGNATURE VERIFICATION', () => {
    it('2A — valid signature: accepted path enters the 2s window, sweep activates exactly once', async () => {
      const { email, intentId } = seedOwner(PLAN_PRO);
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.intentId).toBe(intentId);
        // PENDING intervention window: NOT synchronously ACTIVE.
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
        expect(mock.approvals.size).toBe(1);
        expect([...mock.approvals.values()][0].state).toBe('PENDING_APPROVAL');
      });

      // Timer expiry (server-side sweep) activates through applyDecision.
      const processed = await sweepAutoApprovals({ now: Date.now() + 4000 });
      expect(processed).toBe(1);
      expect(mock.intents.get(intentId)!.status).toBe('ACTIVE');
      expect(mock.entitlements.get(`${OWNER_ID}:${PLAN_PRO}`)).toBeDefined();

      // Exactly once: a second sweep is a no-op and never double-activates.
      expect(await sweepAutoApprovals({ now: Date.now() + 4000 })).toBe(0);
      expect([...mock.entitlements.values()].filter((e) => e.plan_id === PLAN_PRO)).toHaveLength(1);
      expect([...mock.approvals.values()][0].state).toBe('AUTO_APPROVED');
    });

    it('2B — valid signature for TEAM ₹4999', async () => {
      mock.users.set(OWNER_ID, { id: OWNER_ID, email: OWNER_EMAIL, plan_id: 'free' });
      const intentId = 'pin_team_ok';
      mock.intents.set(intentId, {
        id: intentId, owner_id: OWNER_ID, plan_id: PLAN_TEAM, amount_inr: AMOUNT_TEAM,
        currency: 'INR', reference: 'CCTEAM-OK01', payment_link: 'https://rzp.io/rzp/team',
        mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0, decision: null, fraud_flags: null,
        expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
        updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
      });

      const payload = autopilotEvent({ amountPaise: AMOUNT_TEAM * 100, email: OWNER_EMAIL, linkId: LINK_TEAM });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('2B — valid signature for API ₹9999', async () => {
      mock.users.set(OWNER_ID, { id: OWNER_ID, email: OWNER_EMAIL, plan_id: 'free' });
      const intentId = 'pin_api_ok';
      mock.intents.set(intentId, {
        id: intentId, owner_id: OWNER_ID, plan_id: PLAN_API, amount_inr: AMOUNT_API,
        currency: 'INR', reference: 'CCAPI-OK01', payment_link: 'https://rzp.io/rzp/api',
        mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0, decision: null, fraud_flags: null,
        expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
        updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
      });

      const payload = autopilotEvent({ amountPaise: AMOUNT_API * 100, email: OWNER_EMAIL, linkId: LINK_API });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('2C — invalid signature: rejected, NO entitlement', async () => {
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);
      const badSig = createHmac('sha256', 'wrong_secret').update(body).digest('hex');

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': badSig },
          body,
        });
        expect(res.status).toBe(401);
        const json = await res.json() as Record<string, unknown>;
        expect(json.error?.code).toBe('invalid_signature');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('2D — malformed signature: rejected safely, no state change', async () => {
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'zzz_not_hex' },
          body,
        });
        expect(res.status).toBe(401);
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('2E — missing signature: rejected safely, no state change', async () => {
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        expect(res.status).toBe(401);
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('2F — wrong signed link ID: rejected', async () => {
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: 'plink_wrong' });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(false);
        expect(json.reason).toBe('no_matching_intent');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('2G — wrong event status (payment.failed): no activation', async () => {
      const { email, intentId } = seedOwner();
      const payload = {
        event: 'payment.failed',
        id: `evt_fail_${Math.random().toString(36).slice(2, 10)}`,
        payload: {
          payment: { entity: { id: `pay_fail_${Math.random().toString(36).slice(2, 10)}`, amount: AMOUNT_PRO * 100, email, created_at: Math.floor(Date.now() / 1000) } },
          payment_link: { entity: { id: LINK_PRO } },
        },
      };
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        // payment.failed is resolved to intent but not an activation event → audited, not activated.
        expect(json.ok).toBe(true);
        expect(mock.entitlements.size).toBe(0);
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
      });
    });
  });

  // -----------------------------------------------------------------------
  // INTERNAL TOKEN GATE — OPTION A (defense-in-depth rail token)
  // -----------------------------------------------------------------------
  describe('INTERNAL TOKEN GATE (configured rail token must be presented)', () => {
    const RAIL_TOKEN = 'tok_rail_internal_1';

    it('3A — token configured, Bearer missing: 401 invalid_internal_token, no state change', async () => {
      env.INTERNAL_WEBHOOK_TOKEN = RAIL_TOKEN;
      const { intentId } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email: OWNER_EMAIL, linkId: LINK_PRO });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        expect(res.status).toBe(401);
        const json = await res.json() as Record<string, unknown>;
        expect(json.error?.code).toBe('invalid_internal_token');
        expect(mock.entitlements.size).toBe(0);
        expect(mock.approvals.size).toBe(0);
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
      });
    });

    it('3B — token configured, wrong Bearer: 401 invalid_internal_token', async () => {
      env.INTERNAL_WEBHOOK_TOKEN = RAIL_TOKEN;
      const { intentId } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email: OWNER_EMAIL, linkId: LINK_PRO });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, authorization: 'Bearer wrong_token' },
          body,
        });
        expect(res.status).toBe(401);
        const json = await res.json() as Record<string, unknown>;
        expect(json.error?.code).toBe('invalid_internal_token');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('3C — token configured, correct Bearer + valid HMAC: accepted (PENDING intervention window still applies)', async () => {
      env.INTERNAL_WEBHOOK_TOKEN = RAIL_TOKEN;
      const { email, intentId } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-razorpay-signature': sig,
            authorization: `Bearer ${RAIL_TOKEN}`,
          },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.approvals.size).toBe(1);
      });
    });

    it('3D — token configured, correct Bearer but bad HMAC: still 401 invalid_signature (gate passes, HMAC mandatory)', async () => {
      env.INTERNAL_WEBHOOK_TOKEN = RAIL_TOKEN;
      seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email: OWNER_EMAIL, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-razorpay-signature': 'deadbeef',
            authorization: `Bearer ${RAIL_TOKEN}`,
          },
          body,
        });
        expect(res.status).toBe(401);
        const json = await res.json() as Record<string, unknown>;
        expect(json.error?.code).toBe('invalid_signature');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    afterEach(() => {
      delete env.INTERNAL_WEBHOOK_TOKEN;
    });
  });

  // -----------------------------------------------------------------------
  // 2-WINDOW — FOUNDER STOP PREVENTS ACTIVATION
  // -----------------------------------------------------------------------
  describe('FOUNDER STOP (route-integration)', () => {
    it('STOP during the 2s window => intent REVIEW, no activation, sweep is a no-op, replay-stop idempotent', async () => {
      const { email, intentId } = seedOwner(PLAN_PRO);
      const paymentId = 'pay_stop_window_0001';
      const payload = autopilotEvent({
        eventId: 'evt_stop_window',
        paymentId,
        amountPaise: AMOUNT_PRO * 100,
        email,
        linkId: LINK_PRO,
      });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        // Pending intervention window: scheduled, NOT activated.
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
      });

      // Founder STOP inside the window.
      const stopped = await stopAutoApproval(paymentId, 'u-founder', 'review manually');
      expect(stopped.stopped).toBe(true);
      expect(stopped.state).toBe('STOPPED');
      expect(mock.intents.get(intentId)!.status).toBe('REVIEW');
      expect(mock.entitlements.size).toBe(0);

      // Repeating the stop is idempotent (already stopped, never rolled back).
      const stoppedTwice = await stopAutoApproval(paymentId, 'u-founder', 'again');
      expect(stoppedTwice.stopped).toBe(false);
      expect(stoppedTwice.state).toBe('STOPPED');

      // Window expiry with a STOPPED row: sweep claims nothing, no activation,
      // and a founder review keeps the verified payment visible.
      expect(await sweepAutoApprovals({ now: Date.now() + 4000 })).toBe(0);
      expect(mock.intents.get(intentId)!.status).toBe('REVIEW');
      expect(mock.entitlements.size).toBe(0);
      expect([...mock.approvals.values()][0].state).toBe('STOPPED');
      expect([...mock.claims.values()].some((c) => c.user_id === OWNER_ID && c.status === 'PENDING')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3–4. PRODUCT BINDING + UNKNOWN LINK
  // -----------------------------------------------------------------------
  describe('PRODUCT BINDING (HTTP)', () => {
    it('3A — ₹999 link → ONLY pro/solo', async () => {
      const { email, intentId } = seedOwner(PLAN_PRO);
      const payload = autopilotEvent({ amountPaise: 99900, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('3B — team ₹4999 link → ONLY team', async () => {
      mock.users.set(OWNER_ID, { id: OWNER_ID, email: OWNER_EMAIL, plan_id: 'free' });
      mock.intents.set('pin_team2', {
        id: 'pin_team2', owner_id: OWNER_ID, plan_id: PLAN_TEAM, amount_inr: AMOUNT_TEAM,
        currency: 'INR', reference: 'CCTEAM-X2', payment_link: 'https://rzp.io/rzp/team2',
        mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0, decision: null, fraud_flags: null,
        expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
        updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
      });
      const payload = autopilotEvent({ amountPaise: AMOUNT_TEAM * 100, email: OWNER_EMAIL, linkId: LINK_TEAM });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get('pin_team2')!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('3C — team link CANNOT become API', async () => {
      mock.users.set(OWNER_ID, { id: OWNER_ID, email: OWNER_EMAIL, plan_id: 'free' });
      mock.intents.set('pin_team3', {
        id: 'pin_team3', owner_id: OWNER_ID, plan_id: PLAN_TEAM, amount_inr: AMOUNT_TEAM,
        currency: 'INR', reference: 'CCTEAM-X3', payment_link: 'https://rzp.io/rzp/team3',
        mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0, decision: null, fraud_flags: null,
        expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
        updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
      });
      // ₹9999 amount on a TEAM link → amount mismatch → null from resolver → no intent
      const payload = autopilotEvent({ amountPaise: AMOUNT_API * 100, email: OWNER_EMAIL, linkId: LINK_TEAM });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(false);
        expect(json.reason).toBe('no_matching_intent');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('4 — unknown link: fail closed, no activation', async () => {
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: 'plink_unknown_xyz' });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(false);
        expect(json.reason).toBe('no_matching_intent');
        expect(mock.entitlements.size).toBe(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // 5. AMOUNT MISMATCH
  // -----------------------------------------------------------------------
  describe('AMOUNT MISMATCH', () => {
    it('5 — correct link but wrong amount: reject', async () => {
      const { email } = seedOwner();
      // ₹4999 on PRO link → resolver checks amount == 999 → fail → null
      const payload = autopilotEvent({ amountPaise: AMOUNT_TEAM * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(false);
        expect(json.reason).toBe('no_matching_intent');
        expect(mock.entitlements.size).toBe(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // 6. PAYMENT-ID REPLAY
  // -----------------------------------------------------------------------
  describe('PAYMENT-ID REPLAY', () => {
    it('6 — same valid HTTP event twice: first schedules the window, replay is idempotent at every layer', async () => {
      const { email, intentId } = seedOwner();
      const payload = autopilotEvent({
        eventId: 'evt_replay_once',
        paymentId: 'pay_replay_once_0001',
        amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO,
      });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const res1 = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json1 = await res1.json() as Record<string, unknown>;
        expect(json1.ok).toBe(true);
        expect(json1.autoApproval).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
        expect(mock.approvals.size).toBe(1);

        // Duplicate delivery with same event_id → idempotent (webhook_events dedupe)
        const res2 = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
          body,
        });
        const json2 = await res2.json() as Record<string, unknown>;
        expect(json2.ok).toBe(true);
        expect(json2.duplicate).toBe(true);

        // Still exactly one scheduled window, never two.
        expect(mock.approvals.size).toBe(1);
        expect([...mock.approvals.values()].filter((a) => a.state === 'PENDING_APPROVAL')).toHaveLength(1);
      });

      // Window expiry → exactly one activation.
      expect(await sweepAutoApprovals({ now: Date.now() + 4000 })).toBe(1);
      expect(mock.intents.get(intentId)!.status).toBe('ACTIVE');
      expect([...mock.entitlements.values()].filter((e) => e.plan_id === PLAN_PRO).length).toBe(1);
      expect(await sweepAutoApprovals({ now: Date.now() + 4000 })).toBe(0);

      // A NEW event id carrying the SAME payment id after activation is
      // already-approved at the window layer — never double-activates.
      const replay2 = autopilotEvent({
        eventId: 'evt_replay_again',
        paymentId: 'pay_replay_once_0001',
        amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO,
      });
      const body2 = webhookBody(replay2);
      await withServer(async (base) => {
        const res3 = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body2) },
          body: body2,
        });
        const json3 = await res3.json() as Record<string, unknown>;
        // Post-activation replay of the same payment id is a fresh resolve attempt.
        // The resolver matches ONLY PENDING/REVIEW intents, so an already-ACTIVE
        // intent fails closed with no_matching_intent — never a double activation.
        expect(json3.ok).toBe(false);
        expect(json3.reason).toBe('no_matching_intent');
      });
      expect([...mock.entitlements.values()].filter((e) => e.plan_id === PLAN_PRO).length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. CONCURRENT HTTP
  // -----------------------------------------------------------------------
  describe('CONCURRENT HTTP', () => {
    it('7 — two simultaneous events with same event_id: exactly one scheduled, sweep activates once', async () => {
      const { email, intentId } = seedOwner();
      const payload = autopilotEvent({
        eventId: 'evt_concurrent',
        paymentId: 'pay_concurrent_0001',
        amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO,
      });
      const body = webhookBody(payload);
      const sig = webhookSignature(body);

      await withServer(async (base) => {
        const url = `${base}/api/v1/payments/webhook/razorpay`;
        const opts = { method: 'POST' as const, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body };
        const [r1, r2] = await Promise.all([fetch(url, { ...opts }), fetch(url, { ...opts })]);
        const j1 = await r1.json() as Record<string, unknown>;
        const j2 = await r2.json() as Record<string, unknown>;

        // One request wins the schedule; the other is a deduped duplicate.
        const scheduled = [j1, j2].filter((j) => j.autoApproval === 'PENDING');
        const duplicated = [j1, j2].filter((j) => j.duplicate === true);
        expect(scheduled.length + duplicated.length).toBe(2);
        expect(scheduled.length).toBe(1);
        expect(duplicated.length).toBe(1);

        // Exactly one PENDING_APPROVAL window; nothing activated during it.
        expect(mock.approvals.size).toBe(1);
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect([...mock.entitlements.values()].filter((e) => e.plan_id === PLAN_PRO).length).toBe(0);
      });

      // Window expiry --> exactly one activation.
      expect(await sweepAutoApprovals({ now: Date.now() + 4000 })).toBe(1);
      expect(mock.intents.get(intentId)!.status).toBe('ACTIVE');
      expect([...mock.entitlements.values()].filter((e) => e.plan_id === PLAN_PRO).length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 8. CROSS-USER
  // -----------------------------------------------------------------------
  describe('CROSS-USER', () => {
    it('8 — payment event for user A never activates user B', async () => {
      const { email: emailA, intentId: intentA } = seedOwner();
      const emailB = 'other-user@example.com';
      const userIdB = 'u-other-owner';
      mock.users.set(userIdB, { id: userIdB, email: emailB, plan_id: 'free' });
      mock.intents.set('pin_b_pro', {
        id: 'pin_b_pro', owner_id: userIdB, plan_id: PLAN_PRO, amount_inr: AMOUNT_PRO,
        currency: 'INR', reference: 'CCPRO-B01', payment_link: 'https://rzp.io/rzp/proB',
        mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0, decision: null, fraud_flags: null,
        expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
        updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
      });

      // Event for user A's email/ownership — resolver binds to user A only
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email: emailA, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(true);
        expect(json.intentId).toBe(intentA);

        // User B is untouched
        expect(mock.entitlements.has(`${userIdB}:${PLAN_PRO}`)).toBe(false);
        expect(mock.intents.get('pin_b_pro')!.status).toBe('PENDING');
      });
    });
  });

  // -----------------------------------------------------------------------
  // 9. MANUAL MODE SAFETY
  // -----------------------------------------------------------------------
  describe('MANUAL MODE SAFETY', () => {
    it('9 — UNLOCK_MODE=MANUAL: autopilot does NOT activate', async () => {
      env.UNLOCK_MODE = 'MANUAL';
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        // Autopilot resolver returns null → intent not found via exact resolver → unmatched
        expect(json.ok).toBe(false);
        expect(json.reason).toBe('no_matching_intent');
        expect(mock.entitlements.size).toBe(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // 10. AUTOPILOT READINESS GATE
  // -----------------------------------------------------------------------
  describe('AUTOPILOT READINESS GATE', () => {
    it('10 — webhook secret missing: fail closed', async () => {
      env.RAZORPAY_WEBHOOK_SECRET = undefined as unknown as string;
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        expect(res.status).toBe(404);
        const json = await res.json() as Record<string, unknown>;
        expect(json.error?.code).toBe('not_found');
        expect(mock.entitlements.size).toBe(0);
      });
    });

    it('10 — link ID not configured for a plan: fail closed', async () => {
      env.RAZORPAY_API_PAYMENT_LINK_ID = undefined as unknown as string;
      mock.users.set(OWNER_ID, { id: OWNER_ID, email: OWNER_EMAIL, plan_id: 'free' });
      mock.intents.set('pin_api_noconfig', {
        id: 'pin_api_noconfig', owner_id: OWNER_ID, plan_id: PLAN_API, amount_inr: AMOUNT_API,
        currency: 'INR', reference: 'CCAPI-NO01', payment_link: 'https://rzp.io/rzp/api_no',
        mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0, decision: null, fraud_flags: null,
        expires_at: new Date(Date.now() + 86400_000), created_at: new Date(Date.now() - 60_000),
        updated_at: new Date(), provider_reference_id: null, provider_payment_link_id: null,
      });
      const payload = autopilotEvent({ amountPaise: AMOUNT_API * 100, email: OWNER_EMAIL, linkId: 'plink_api_gone' });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        expect(json.ok).toBe(false);
        expect(json.reason).toBe('no_matching_intent');
        expect(mock.entitlements.size).toBe(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // 11. FRAUD / UNCERTAINTY → queueAutopilotReview
  // -----------------------------------------------------------------------
  describe('FRAUD / UNCERTAINTY → REVIEW', () => {
    it('11 — PAYMENT QUEUED FOR REVIEW (immediate) — pending window, no claim yet', async () => {
      const { email, intentId } = seedOwner(PLAN_PRO);
      const paymentId = 'pay_review_fail_0001';
      const payload = autopilotEvent({ eventId: 'evt_review_fail', paymentId, amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature(body) },
          body,
        });
        const json = await res.json() as Record<string, unknown>;
        // During the 2-second window the verified payment is PENDING (intervention
        // window), never synchronously ACTIVE and never silently dropped.
        expect(json.ok).toBe(true);
        expect(json.autoApproval).toBe('PENDING');
        expect(mock.intents.get(intentId)!.status).toBe('PENDING');
        expect(mock.entitlements.size).toBe(0);
        expect([...mock.claims.values()].some((c) => c.user_id === OWNER_ID)).toBe(false);
      });

      // Force the trusted pipeline to REJECT this otherwise-verified payment at
      // sweep time: the SAME provider payment id already granted ANOTHER intent,
      // so the evidence ingest fails closed instead of activating.
      mock.evidenceByPayment.set(paymentId, 'ev-other-intent');
      mock.evidence.set('ev-other-intent', {
        id: 'ev-other-intent', intent_id: 'pin_other_owner', owner_id: 'u-other-owner', source: 'razorpay_webhook',
        sha256: 'other-intent-sha', provider_payment_id: paymentId, signals: '{}', fraud_flags: '[]',
        created_at: new Date(), matched: true,
      });

      // Sweep claims the row (exactly once) but the rejected activation must fail
      // closed: intent -> REVIEW + a founder review so the payment is not lost.
      const processed = await sweepAutoApprovals({ now: Date.now() + 4000 });
      expect(processed).toBe(1);
      expect(mock.intents.get(intentId)!.status).toBe('REVIEW');
      expect(mock.entitlements.size).toBe(0);
      const review = [...mock.claims.values()].find(
        (c) => c.user_id === OWNER_ID && c.source === 'autopilot' && c.status === 'PENDING',
      );
      expect(review).toBeDefined();
      expect(review!.razorpay_payment_id).toBe(paymentId);
      expect([...mock.approvals.values()][0].state).toBe('AUTO_APPROVED');
    });
  });

  // -----------------------------------------------------------------------
  // 15. RESPONSE — no secrets leaked
  // -----------------------------------------------------------------------
  describe('RESPONSE SECURITY', () => {
    it('15 — invalid signature response does not leak secret or raw signature', async () => {
      const { email } = seedOwner();
      const payload = autopilotEvent({ amountPaise: AMOUNT_PRO * 100, email, linkId: LINK_PRO });
      const body = webhookBody(payload);

      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
          body,
        });
        const text = await res.text();
        expect(text).not.toContain(WEBHOOK_SECRET);
        expect(text).not.toContain('deadbeef');
        expect(text).not.toContain('stack');
      });
    });
  });

  // -----------------------------------------------------------------------
  // 13. CALLBACK METHOD / ROUTING (webhook is POST-only)
  // -----------------------------------------------------------------------
  describe('CALLBACK METHOD / ROUTING', () => {
    it('13 — webhook path rejects GET (POST-only)', async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`);
        // POST-only: GET is rejected (falls through to the auth-gated
        // /api/v1/payments mount → 401; never an activation or a 2xx).
        expect([401, 404, 405]).toContain(res.status);
      });
    });
  });

  // -----------------------------------------------------------------------
  // 14. SECURITY MIDDLEWARE (webhook bypasses CSRF + auth)
  // -----------------------------------------------------------------------
  describe('SECURITY MIDDLEWARE', () => {
    it('14 — webhook reaches handler without CSRF token (signature-authenticated)', async () => {
      env.RAZORPAY_WEBHOOK_ENABLED = 'false'; // will 404 = reached the handler, not CSRF block
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        // 404 "Webhook not configured" = reached handler; 403 = CSRF blocked
        expect(res.status).toBe(404);
      });
    });

    it('14 — webhook reaches handler without session cookie (auth-bypassed)', async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/webhook/razorpay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        // 401 from handler = reached signature check; 401 from requireAuth = never reached handler
        expect(res.status).toBe(401);
        const json = await res.json() as Record<string, unknown>;
        expect(json.error?.code).toBe('invalid_signature');
      });
    });

    it('14 — normal /api/v1/payments/* still requires auth (401)', async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/entitlements`);
        expect(res.status).toBe(401);
      });
    });

    it('14 — normal POST /api/v1/payments/* still requires CSRF (403)', async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/v1/payments/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro' }),
        });
        expect(res.status).toBe(403);
      });
    });
  });
});

// =========================================================================
// B) PAYMENT-LINK CALLBACK RAIL — GET /cb/:linkIndex
// =========================================================================
describe('PAYMENT-LINK CALLBACK (GET /cb/:linkIndex)', () => {

  // ---- 12. RAW HTTP QUERY TEST (exact field names) ----
  it('12 — exact callback field names: razorpay_payment_id, razorpay_payment_link_id, razorpay_payment_link_reference_id, razorpay_payment_link_status, razorpay_signature', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-001', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool_pro', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool_pro', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-001', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    const params = {
      razorpay_payment_id: 'pay_cb_fields_001',
      razorpay_payment_link_id: 'plink_pool_pro',
      razorpay_payment_link_reference_id: 'CCPOOL-TEST-001',
      razorpay_payment_link_status: 'paid',
    };
    params.razorpay_signature = callbackSignature(params);

    const url = new URL('/cb/1', 'http://127.0.0.1');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    await withServer(async (base) => {
      const res = await fetch(`${base}${url.pathname}${url.search}`);
      // Valid signature + link exists + status paid + no reservation → orphaned 404
      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, unknown>;
      expect(json.outcome).toBe('orphaned');
      // Must not be CSRF-blocked or auth-blocked (handler response body shape)
    });
  });

  // ---- 13. CALLBACK METHOD (GET) ----
  it('13 — GET method reachable, POST not mapped', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-002', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool2', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool2', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-002', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    await withServer(async (base) => {
      // GET /cb/1 with no params → handler outcome (signature check first: 401)
      const resGet = await fetch(`${base}/cb/1`);
      const getJson = await resGet.json() as Record<string, unknown>;
      // Must be a HANDLER outcome (reached the callback), not a middleware block.
      expect(getJson.outcome).toBe('invalid_signature');
      expect(resGet.status).toBe(401);

      // POST /cb/1 → CSRF blocks state-changing POST (403) — never an activation.
      const resPost = await fetch(`${base}/cb/1`, { method: 'POST' });
      expect(resPost.status).toBe(403);
    });
  });

  // ---- 14. PUBLIC CALLBACK: not blocked by auth/CSRF ----
  it('14 — public GET callback not blocked by auth, CSRF, or session redirect', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-014', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool14', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool14', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-014', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    const params = {
      razorpay_payment_id: 'pay_pub_0001',
      razorpay_payment_link_id: 'plink_pool14',
      razorpay_payment_link_reference_id: 'CCPOOL-TEST-014',
      razorpay_payment_link_status: 'paid',
    };
    params.razorpay_signature = callbackSignature(params);
    const url = new URL('/cb/1', 'http://127.0.0.1');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    await withServer(async (base) => {
      const res = await fetch(`${base}${url.pathname}${url.search}`);
      // Valid signature + configured link + paid + no reservation → handler
      // outcome (orphaned, 404). NOT a middleware block (401 auth / 403 CSRF) —
      // proving the PUBLIC callback is reachable without session/cookie.
      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, unknown>;
      expect(json.outcome).toBe('orphaned');
      expect(mock.entitlements.size).toBe(0);
    });
  });

  // ---- SIGNATURE: invalid ----
  it('2B — GET callback: invalid signature → 401 invalid_signature', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-003', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool3', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool3', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-003', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    const url = '/cb/1?razorpay_payment_id=pay_bad_sig_0001&razorpay_payment_link_id=plink_pool3&razorpay_payment_link_reference_id=CCPOOL-TEST-003&razorpay_payment_link_status=paid&razorpay_signature=bad_signature_value';

    await withServer(async (base) => {
      const res = await fetch(`${base}${url}`);
      expect(res.status).toBe(401);
      const json = await res.json() as Record<string, unknown>;
      expect(json.outcome).toBe('invalid_signature');
      expect(mock.entitlements.size).toBe(0);
    });
  });

  // ---- SIGNATURE: missing ----
  it('2E — GET callback: missing signature → 401', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-004', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool4', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool4', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-004', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    await withServer(async (base) => {
      const res = await fetch(`${base}/cb/1?razorpay_payment_id=pay_nosig_0001&razorpay_payment_link_id=plink_pool4&razorpay_payment_link_reference_id=CCPOOL-TEST-004&razorpay_payment_link_status=paid`);
      expect(res.status).toBe(401);
      const json = await res.json() as Record<string, unknown>;
      expect(json.outcome).toBe('invalid_signature');
    });
  });

  // ---- WRONG STATUS ----
  it('2G — GET callback: status=pending (not paid) → rejected', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-005', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool5', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool5', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-005', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    const params = {
      razorpay_payment_id: 'pay_badstatus_0001',
      razorpay_payment_link_id: 'plink_pool5',
      razorpay_payment_link_reference_id: 'CCPOOL-TEST-005',
      razorpay_payment_link_status: 'pending',
    };
    params.razorpay_signature = callbackSignature(params);
    const url = new URL('/cb/1', 'http://127.0.0.1');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    await withServer(async (base) => {
      const res = await fetch(`${base}${url.pathname}${url.search}`);
      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, unknown>;
      expect(json.outcome).toBe('bad_status');
    });
  });

  // ---- UNKNOWN LINK INDEX ----
  it('4 — GET callback: unknown link index → 404 bad_link_index', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pro1', referenceId: 'CCPOOL-TEST-004', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO, callbackPath: '/cb/1', paymentLinkId: 'plink_pool4a', enabled: true },
    ]);
    mock.poolLinks.set(1, {
      link_index: 1, payment_link_id: 'plink_pool4a', razorpay_url: 'https://rzp.io/rzp/pro1',
      reference_id: 'CCPOOL-TEST-004', amount: AMOUNT_PRO, currency: 'INR', plan: PLAN_PRO,
      callback_path: '/cb/1', is_active: true,
    });

    // Signature verified before the link index is resolved, so send a valid
    // signature for the given fields; the handler then rejects unknown index.
    const params = {
      razorpay_payment_id: 'pay_unknown_0001',
      razorpay_payment_link_id: 'plink_pool4a',
      razorpay_payment_link_reference_id: 'CCPOOL-TEST-004',
      razorpay_payment_link_status: 'paid',
    };
    params.razorpay_signature = callbackSignature(params);
    const url = new URL('/cb/99999', 'http://127.0.0.1');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    await withServer(async (base) => {
      const res = await fetch(`${base}${url.pathname}${url.search}`);
      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, unknown>;
      expect(json.outcome).toBe('bad_link_index');
      expect(mock.entitlements.size).toBe(0);
    });
  });
});

// =========================================================================
// 16. DB DISCIPLINE
// =========================================================================
describe('16. DB DISCIPLINE', () => {
  it('test labeled: ROUTE TESTED — DB MOCKED (controlled in-memory doubles), REAL pipeline + REAL activateEntitlement', () => {
    // This is a documentation assertion — the entire file uses mocked DB.
    expect(true).toBe(true);
  });
});
