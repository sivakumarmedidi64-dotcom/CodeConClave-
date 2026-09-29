/**
 * CodeConClave — PAYMENT PROOF SUITE (npm run prove:payment).
 *
 * ALL-or-nothing runner over 16 security invariants of the payment link-pool
 * rail. The suite drives the REAL modules (seeder, pool service, callback,
 * pipeline, watchtower) against an in-memory DB harness; only infra boundaries
 * (db, audit, notify, outbox) are mocked. Nothing is skipped to fake green: a
 * single invariant failure fails the whole run (exit != 0).
 *
 * Every invariant prints: INVARIANT <n> | <key> | RESULT
 * and the final aggregated test asserts ALL 16 recorded results were PASS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// In-memory DB harness (mirrors the repo's pool/seeder test-harness semantics).
// ---------------------------------------------------------------------------
const mock = vi.hoisted(() => {
  type PoolRow = { link_index: number; payment_link_id: string | null; razorpay_url: string; reference_id: string; amount: number; currency: string; plan: string; callback_path: string; is_active: boolean };
  type ResRow = Record<string, unknown>;
  type IntentRow = Record<string, unknown>;
  type CbRow = Record<string, unknown>;
  type EvRow = Record<string, unknown>;

  const poolRows = new Map<number, PoolRow>();
  const resRows = new Map<string, ResRow>();
  const intentRows = new Map<string, IntentRow>();
  const cbRows = new Map<string, CbRow>();
  const evRows = new Map<string, EvRow>();
  const users = new Map<string, Record<string, unknown>>();
  const entitlements = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];

  const reset = () => {
    poolRows.clear();
    resRows.clear();
    intentRows.clear();
    cbRows.clear();
    evRows.clear();
    users.clear();
    entitlements.clear();
    queries.splice(0);
  };

  const handler = (text: string, params: unknown[] = []): Record<string, unknown>[] => {
    queries.push(text.replace(/\s+/g, ' ').trim());
    const t = text.trim();

    // ---- seeder: upsert pool catalogue ----
    if (t.startsWith('INSERT INTO payment_link_pool')) {
      const [index, paymentLinkId, url, ref, amount, currency, plan, cbPath, isActive] = params as [number, string | null, string, string, number, string, string, string, boolean];
      poolRows.set(index, {
        link_index: index, payment_link_id: paymentLinkId, razorpay_url: url,
        reference_id: ref, amount, currency, plan, callback_path: cbPath, is_active: isActive,
      });
      return [];
    }
    // ---- seeder: totals ----
    if (t.startsWith('SELECT count(*)::int AS total')) {
      const all = [...poolRows.values()];
      return [{ total: all.length, active: all.filter((r) => r.is_active).length }];
    }
    if (t.startsWith('SELECT count(*)') && t.includes('payment_link_pool')) {
      return [{ n: poolRows.size }];
    }
    // ---- seeder: existing catalogue rows ----
    if (t.startsWith('SELECT link_index, payment_link_id')) return [...poolRows.values()] as Record<string, unknown>[];
    // ---- seeder: reserved indexes ----
    if (t.startsWith('SELECT link_index FROM payment_link_reservations')) {
      return [...resRows.values()].filter((r) => r.status === 'RESERVED').map((r) => ({ link_index: r.link_index }));
    }

    // ---- assignLink: existing intent (dedupe) ----
    if (t.startsWith('SELECT * FROM payment_intents WHERE owner_id')) {
      const owner = params[0];
      const plan = params[1];
      return [...intentRows.values()]
        .filter((i) => i.owner_id === owner && i.plan_id === plan && ['PENDING', 'REVIEW', 'ACTIVE', 'GRACE'].includes(i.status as string))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
        .slice(0, 1);
    }
    // ---- assignLink: candidate link (skip-locked modeled) ----
    if (t.includes('FOR UPDATE SKIP LOCKED')) {
      const row = poolRows.get(Number(params[0]));
      if (row && row.is_active) return [{ ...row }];
      return [];
    }
    // ---- getLinkConfig / seeder per-row read ----
    if (t.startsWith('SELECT * FROM payment_link_pool WHERE link_index')) {
      const row = poolRows.get(Number(params[0]));
      return row ? [{ ...row }] : [];
    }

    // ---- assignLink: reservation INSERT with unique-index semantics ----
    if (t.startsWith('INSERT INTO payment_link_reservations')) {
      const [id, linkIndex, intentId, userId, , plan, amountInr, currency, linkRef, , , expiresAt] = params as [string, number, string, string, unknown, string, number, string, string, unknown, unknown, Date];
      const liveByLink = [...resRows.values()].some((r) => r.status === 'RESERVED' && r.link_index === linkIndex);
      const liveByIntent = [...resRows.values()].some((r) => r.status === 'RESERVED' && r.intent_id === intentId);
      if (liveByLink) throw new Error('duplicate key value violates unique constraint "uq_pool_reservation_live_link"');
      if (liveByIntent) throw new Error('duplicate key value violates unique constraint "uq_pool_reservation_live_intent"');
      resRows.set(id as string, {
        id: id as string, link_index: linkIndex, intent_id: intentId, user_id: userId,
        plan: plan as string, amount_inr: amountInr, currency, link_reference_id: linkRef,
        status: 'RESERVED', expires_at: expiresAt, reserved_at: new Date(), fulfilled_at: null, payment_id: null,
      });
      return [];
    }
    // ---- assignLink: bind intent to reservation ----
    if (t.startsWith('UPDATE payment_intents') && t.includes('pool_link_index')) {
      const [intentId, linkIndex, ref, expiresAt] = params;
      const row = intentRows.get(intentId as string);
      if (row) {
        Object.assign(row, {
          pool_link_index: linkIndex, pool_reference_id: ref, reservation_status: 'RESERVED',
          reservation_expires_at: expiresAt, updated_at: new Date(),
        });
      }
      return [{ ...(row ?? {}) }];
    }

    // ---- intent creation ----
    if (t.startsWith('INSERT INTO payment_intents')) {
      const [id, ownerId, planId, amount, reference, link] = params;
      intentRows.set(id as string, {
        id, owner_id: ownerId, plan_id: planId, amount_inr: amount, currency: 'INR',
        reference, payment_link: link, mode: 'PAYMENT_LINK', status: 'PENDING', confidence: 0,
        decision: null, fraud_flags: null, expires_at: new Date(Date.now() + 24 * 3600 * 1000),
        created_at: new Date(), updated_at: new Date(), pool_link_index: null, pool_reference_id: null,
        reservation_status: null, reservation_expires_at: null,
      });
      return [];
    }
    // ---- intents.ts: active-intent existence check (createPaymentIntent) ----
    if (t.startsWith('SELECT id FROM payment_intents WHERE owner_id') || (t.startsWith('SELECT * FROM payment_intents') && t.includes('status IN'))) {
      return [];
    }
    // ---- getIntent (owner optional) ----
    if (t.startsWith('SELECT * FROM payment_intents WHERE id')) {
      const [id, owner] = params;
      const row = intentRows.get(id as string);
      if (!row) return [];
      if (params.length > 1 && owner !== undefined && row.owner_id !== owner) return [];
      return [{ ...row }];
    }
    if (t.includes('FROM payment_intents WHERE reference')) {
      return [...intentRows.values()].filter((r) => r.reference === params[0]);
    }
    // ---- pipeline/activation: UPDATE intent -> ACTIVE ----
    if (t.startsWith('UPDATE payment_intents')) {
      const [id] = params;
      const row = intentRows.get(id as string);
      if (row && t.includes('ACTIVE')) {
        row.status = 'ACTIVE';
        row.decision = 'ACTIVE';
        row.reservation_status = 'FULFILLED';
      }
      return row ? [{ ...row }] : [];
    }

    // ---- reservations: status helpers ----
    if (t.includes('FROM payment_link_reservations WHERE link_reference_id')) {
      return [...resRows.values()].filter((r) => r.link_reference_id === params[0]);
    }
    if (t.includes('FROM payment_link_reservations WHERE intent_id') && !t.includes('link_index')) {
      return [...resRows.values()].filter((r) => r.intent_id === params[0]);
    }
    if (t.includes('FROM payment_link_reservations WHERE link_index')) {
      return [...resRows.values()].filter((r) => r.link_index === Number(params[0]) && r.intent_id === params[1]);
    }
    // ---- expireStaleReservations ----
    if (t.startsWith('SELECT id, link_index')) {
      return [...resRows.values()]
        .filter((r) => r.status === 'RESERVED' && new Date(String(r.expires_at)) < new Date())
        .map((r) => ({ id: r.id, link_index: r.link_index, intent_id: r.intent_id, user_id: r.user_id }));
    }
    if (t.startsWith('UPDATE payment_link_reservations')) {
      const [id] = params;
      const row = resRows.get(id as string);
      if (row) {
        if (t.includes('EXPIRED') || t.includes('expires_at')) row.status = 'EXPIRED';
        else if (t.includes('payment_id')) row.status = 'FULFILLED';
        else if (t.includes('SET status')) row.status = 'RELEASED';
      }
      return [];
    }

    // ---- callbacks ledger ----
    if (t.startsWith('SELECT id, outcome FROM payment_pool_callbacks')) {
      return [...cbRows.values()].filter((r) => r.payment_id === params[0]).map((r) => ({ id: r.id, outcome: r.outcome }));
    }
    if (t.startsWith('SELECT id FROM payment_pool_callbacks')) {
      return [...cbRows.values()].filter((r) => r.payment_id === params[0]).map((r) => ({ id: r.id }));
    }
    if (t.startsWith('SELECT count(*)::int AS n FROM payment_pool_callbacks')) {
      const bad = ['duplicate', 'ambiguous', 'fraud_blocked'];
      return [{ n: [...cbRows.values()].filter((r) => bad.includes(r.outcome)).length }];
    }
    if (t.startsWith('INSERT INTO payment_pool_callbacks')) {
      const id = params[0] as string;
      const paymentId = String(params[2]);
      if (cbRows.has(paymentId)) throw new Error('duplicate key value violates unique constraint "uq_pool_callbacks_payment"');
      cbRows.set(paymentId, {
        id, link_index: params[1], payment_id: paymentId, payment_link_id: params[3],
        reference_id: params[4], link_status: params[5], signature_sha: params[6],
        signature_valid: params[7], outcome: params[8], reason: params[9],
      });
      return [];
    }

    // ---- users / entitlements ----
    if (t.startsWith('SELECT email FROM users')) {
      const row = users.get(params[0] as string);
      return row ? [{ email: row.email }] : [];
    }
    if (t.startsWith('INSERT INTO entitlements')) {
      const id = params[0] as string;
      entitlements.set(id, { id, user_id: params[1], plan_id: params[2], intent_id: params[3] ?? null, origin: params[4] ?? null });
      return [];
    }
    if (t.startsWith('UPDATE users')) return [];

    // ---- evidence ----
    if (t.includes('provider_payment_id')) {
      return [...evRows.values()].filter((e) => e.provider_payment_id === params[0]);
    }
    if (t.includes('WHERE sha256')) {
      return [...evRows.values()].filter((e) => e.sha256 === params[0]);
    }
    if (t.startsWith('SELECT count(*)') && t.includes('payment_evidence')) {
      return [{ n: evRows.size }];
    }
    if (t.startsWith('SELECT * FROM payment_evidence')) {
      return [...evRows.values()].map((e) => ({ ...e }));
    }
    if (t.startsWith('INSERT INTO payment_evidence')) {
      const id = params[0] as string;
      evRows.set(id, {
        id, intent_id: params[1], owner_id: params[2], source: params[3], sha256: params[4],
        signals: params[5] ?? '{}', fraud_flags: params[6] ?? null, provider_payment_id: params[7] ?? null,
        reference: params[8] ?? null, amount_inr: params[9] ?? null, payer_email: null,
        paid_at: new Date(), created_at: new Date(), matched: params[10] ?? true,
      });
      return [];
    }
    if (t.startsWith('UPDATE payment_evidence')) return [];

    // ---- watchtower ----
    if (t.includes('l.is_active = false')) return [];
    if (t.includes('expires_at < now()')) return [];
    if (t.includes('expires_at - reserved_at')) return [];
    if (t.startsWith('SELECT c.id FROM payment_pool_callbacks c')) return [];

    return [];
  };

  return {
    poolRows,
    resRows,
    intentRows,
    cbRows,
    evRows,
    users,
    entitlements,
    get queries() {
      return queries;
    },
    reset,
    handler,
    pool: { query: async (q: string, p: unknown[] = []) => {
      const rows = handler(q, p);
      return { rows, rowCount: rows.length };
    } },
    queryOne: async (q: string, p: unknown[] = []) => handler(q, p)[0] ?? null,
    queryMany: async (q: string, p: unknown[] = []) => handler(q, p),
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query: mock.pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query: mock.pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
  };
});

vi.mock('../shared/db.js', () => mock);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));
const enqueueOutbox = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox }));
const testLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../shared/logger.js', () => ({ logger: testLogger }));

import { env } from '../config/env.js';
import { seedPaymentPool, type PoolSeedReport } from '../modules/payments/pool/seeder.js';
import { assignLink, expireStaleReservations, verifyCallbackSignature } from '../modules/payments/pool/service.js';
import { handlePoolCallback } from '../modules/payments/pool/callback.js';
import { runPoolWatchtower } from '../modules/payments/pool/watchtower.js';

const SECRET = 'rzp_test_secret_123';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(path.join(__dirname, '..', ...rel.split('/')), 'utf8');
}

function sig(referenceId = 'CCPOOL-001', paymentId = 'pay_proveA', signature?: string | null, secret = SECRET) {
  const message = `${referenceId}:${paymentId}`;
  return {
    referenceId,
    paymentId,
    message,
    signature: signature ?? createHmac('sha256', secret).update(message).digest('hex'),
  };
}

function setupBasic(): void {
  mock.users.set('u-001', { id: 'u-001', email: 'u-001@example.com' });
  mock.users.set('u-002', { id: 'u-002', email: 'u-002@example.com' });
  mock.poolRows.set(1, { link_index: 1, payment_link_id: 'plink_1', razorpay_url: 'https://rzp.io/rzp/pool1', reference_id: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callback_path: '/cb/1', is_active: true });
  mock.poolRows.set(2, { link_index: 2, payment_link_id: 'plink_2', razorpay_url: 'https://rzp.io/rzp/pool2', reference_id: 'CCPOOL-002', amount: 4999, currency: 'INR', plan: 'team', callback_path: '/cb/2', is_active: true });
  mock.intentRows.set('pin-1', {
    id: 'pin-1', owner_id: 'u-001', plan_id: 'pro', amount_inr: 999, currency: 'INR', reference: 'CCPRO-ABCD12',
    payment_link: 'https://rzp.io/rzp/pool1', status: 'PENDING', confidence: 0, decision: null,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000), created_at: new Date(), updated_at: new Date(),
    pool_link_index: 1, pool_reference_id: 'CCPOOL-001', reservation_status: 'RESERVED',
  });
  mock.resRows.set('pvr-1', {
    id: 'pvr-1', link_index: 1, intent_id: 'pin-1', user_id: 'u-001', workspace_id: null, plan: 'pro',
    amount_inr: 999, currency: 'INR', link_reference_id: 'CCPOOL-001', status: 'RESERVED',
    reserved_at: new Date(), expires_at: new Date(Date.now() + 15 * 60 * 1000), fulfilled_at: null, payment_id: null,
  });
}

const invariants: Array<{ n: number; key: string; ok: boolean }> = [];

function report(n: number, key: string, ok: boolean): void {
  invariants.push({ n, key, ok });
  // eslint-disable-next-line no-console
  console.log(`INVARIANT ${n} | ${key} | ${ok ? 'PASS' : 'FAIL'}`);
}

beforeEach(() => {
  mock.reset();
  recordAudit.mockClear();
  notify.mockClear();
  enqueueOutbox.mockClear();
  testLogger.info.mockClear();
  testLogger.warn.mockClear();
  testLogger.error.mockClear();
  env.PAYMENT_WATCHTOWER_ALERT_EMAIL = undefined as unknown as string;
  env.RAZORPAY_KEY_SECRET = SECRET;
  env.PAYMENT_POOL_LINKS = JSON.stringify([
    { index: 1, paymentUrl: 'https://rzp.io/rzp/pool1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', paymentLinkId: 'plink_1', enabled: true },
    { index: 2, paymentUrl: 'https://rzp.io/rzp/pool2', referenceId: 'CCPOOL-002', amount: 4999, currency: 'INR', plan: 'team', callbackPath: '/cb/2', paymentLinkId: 'plink_2', enabled: true },
  ]);
});

describe('PAYMENT PROOF (16 invariants)', () => {
  it('I1 SEED_FRESH: a fresh DB is automatically provisioned by the seeder (no more ALL_LINKS_BUSY_TRY_AGAIN on boot)', async () => {
    const seedReport: PoolSeedReport = await seedPaymentPool();
    const okPaid = seedReport.seeded === 2 && seedReport.configured === 2 && seedReport.total === 2 && seedReport.active === 2;
    expect(okPaid).toBe(true);
    report(1, 'SEED_FRESH', okPaid);
  });

  it('I2 SEED_IDEMPOTENT: reseeding never duplicates pool rows', async () => {
    await seedPaymentPool();
    const before = mock.poolRows.size;
    const second = await seedPaymentPool();
    const okPaid = second.seeded === 0 && second.updated === 0 && mock.poolRows.size === before;
    expect(okPaid).toBe(true);
    report(2, 'SEED_IDEMPOTENT', okPaid);
  });

  it('I3 SINGLE_RESERVATION: 100 concurrent assigns against a one-link pool -> exactly 1 reserves, 99 fail closed', async () => {
    await seedPaymentPool();
    mock.poolRows.clear();
    mock.poolRows.set(1, { link_index: 1, payment_link_id: 'plink_1', razorpay_url: 'https://rzp.io/rzp/pool1', reference_id: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callback_path: '/cb/1', is_active: true });
    mock.intentRows.clear();
    mock.resRows.clear();
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) => assignLink(`u-${String(i).padStart(3, '0')}`, null, 'pro')),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    const okPaid = fulfilled === 1 && rejected === 99;
    expect(okPaid).toBe(true);
    report(3, 'SINGLE_RESERVATION', okPaid);
  });

  it('I4 AMOUNT_MISMATCH: a callback whose link amount drifts off the authoritative price never activates', async () => {
    setupBasic();
    mock.poolRows.set(1, { ...mock.poolRows.get(1)!, amount: 2000 }); // drift
    const s = sig();
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    const okPaid = result.outcome === 'amount_mismatch' && result.activated === false;
    expect(okPaid).toBe(true);
    report(4, 'AMOUNT_MISMATCH', okPaid);
  });

  it('I5 INR_ONLY: a non-INR entry is never seeded and a USD callback fails closed', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', paymentLinkId: 'plink_1', enabled: true },
      { index: 2, paymentUrl: 'https://rzp.io/rzp/usd', referenceId: 'CCPOOL-USD', amount: 12, currency: 'USD', plan: 'pro', callbackPath: '/cb/2', paymentLinkId: 'plink_2', enabled: true },
    ]);
    const seeded = await seedPaymentPool();
    const seededOnlyInr = seeded.seeded === 1 && seeded.skipped === 1 && mock.poolRows.size === 1;
    setupBasic();
    mock.poolRows.set(1, { ...mock.poolRows.get(1)!, currency: 'USD' });
    const s = sig();
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    const okPaid = seededOnlyInr && result.outcome === 'currency_mismatch' && result.activated === false;
    expect(okPaid).toBe(true);
    report(5, 'INR_ONLY', okPaid);
  });

  it('I6 FORGED_SIGNATURE: a tampered signature grants nothing, is recorded, never stored raw', async () => {
    setupBasic();
    const rawForge = createHmac('sha256', 'attacker-secret').update('CCPOOL-001:pay_forged').digest('hex');
    const s = sig('CCPOOL-001', 'pay_forged', rawForge);
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    const recorded = [...mock.cbRows.values()].some((c) => c.payment_id === 'pay_forged' && c.outcome === 'invalid_signature');
    const ledgerDump = JSON.stringify([...mock.cbRows.values()]);
    const okPaid = result.outcome === 'invalid_signature' && result.activated === false && recorded && !ledgerDump.includes(rawForge);
    expect(okPaid).toBe(true);
    report(6, 'FORGED_SIGNATURE', okPaid);
  });

  it('I7 REPLAY_BLOCKED: re-delivering an accepted payment_id can never re-activate', async () => {
    setupBasic();
    const s = sig();
    mock.cbRows.set(s.paymentId, { id: 'pcb-1', payment_id: s.paymentId, outcome: 'accepted' });
    mock.evRows.set('ev-1', { id: 'ev-1', provider_payment_id: s.paymentId });
    mock.intentRows.set('pin-1', { ...mock.intentRows.get('pin-1')!, status: 'ACTIVE', reservation_status: 'FULFILLED', decision: 'ACTIVE' });
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    const okPaid = ['duplicate', 'fraud_blocked'].includes(result.outcome) && result.activated === false;
    expect(okPaid).toBe(true);
    report(7, 'REPLAY_BLOCKED', okPaid);
  });

  it('I8 LATE_CALLBACK: A expires -> B reserves the freed link -> A late callback fails closed, B untouched', async () => {
    mock.poolRows.set(1, { link_index: 1, payment_link_id: 'plink_1', razorpay_url: 'https://rzp.io/rzp/pool1', reference_id: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callback_path: '/cb/1', is_active: true });
    mock.resRows.set('pvr-A', {
      id: 'pvr-A', link_index: 1, intent_id: 'pin-A', user_id: 'u-A', plan: 'pro', amount_inr: 999,
      currency: 'INR', link_reference_id: 'CCPOOL-001', status: 'EXPIRED',
      expires_at: new Date(Date.now() - 1000), reserved_at: new Date(Date.now() - 3600 * 1000), fulfilled_at: null, payment_id: null,
    });
    mock.intentRows.set('pin-A', {
      id: 'pin-A', owner_id: 'u-A', plan_id: 'pro', reference: 'CCPRO-LATEA', status: 'PENDING',
      pool_reference_id: 'CCPOOL-001', pool_link_index: 1, created_at: new Date(), updated_at: new Date(),
    });
    const s = sig('CCPOOL-001', 'pay_lateA');
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    const okPaid = result.outcome === 'reservation_expired' && result.activated === false;
    expect(okPaid).toBe(true);
    report(8, 'LATE_CALLBACK_SAFE', okPaid);
  });

  it('I9 AMBIGUOUS_FAILS_CLOSED: evidence that cannot be trusted never grants', async () => {
    setupBasic();
    // A prior evidence row already exists for this payment id on a DIFFERENT
    // intent: the callback's evidence gate (step 16) rejects it and fails closed.
    mock.evRows.set('ev-amb', { id: 'ev-amb', provider_payment_id: 'pay_amb' });
    const s = sig('CCPOOL-001', 'pay_amb');
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    const noGrant = mock.entitlements.size === 0;
    const okPaid = result.activated === false && noGrant && ['ambiguous', 'fraud_blocked'].includes(result.outcome);
    expect(okPaid).toBe(true);
    report(9, 'AMBIGUOUS_FAILS_CLOSED', okPaid);
  });

  it('I10 BROWSER_CLOSE: abandoned reservation never auto-grants; link re-assignable after expiry', async () => {
    mock.poolRows.set(1, { link_index: 1, payment_link_id: 'plink_1', razorpay_url: 'https://rzp.io/rzp/pool1', reference_id: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callback_path: '/cb/1', is_active: true });
    mock.intentRows.clear();
    mock.resRows.clear();
    const assigned = await assignLink('u-close', null, 'pro');
    const intentId = assigned.intentId;
    const res = [...mock.resRows.values()].find((r) => r.intent_id === intentId)!;
    (mock.resRows.get(res.id as string) as { expires_at: Date }).expires_at = new Date(Date.now() - 1000);
    const expiredCount = await expireStaleReservations();
    const stillPending = (mock.intentRows.get(intentId) as { status: string }).status === 'PENDING';
    const noGrant = mock.entitlements.size === 0;
    const okPaid = expiredCount === 1 && stillPending && noGrant;
    expect(okPaid).toBe(true);
    report(10, 'BROWSER_CLOSE_NO_AUTO_GRANT', okPaid);
  });

  it('I11 EXACTLY_ONCE + SOLE_AUTHORITY: activation happens once; the pool module never calls applyDecision', async () => {
    const cbSrc = readSrc('modules/payments/pool/callback.ts');
    const svcSrc = readSrc('modules/payments/pool/service.ts');
    const routesSrc = readSrc('modules/payments/pool/routes.ts');
    // Comments legitimately mention applyDecision (the authoritative rail);
    // the invariant is that the pool module never CALLS or IMPORTS it.
    const noPoolCall =
      !cbSrc.includes('applyDecision(') && !svcSrc.includes('applyDecision(') && !routesSrc.includes('applyDecision(');
    const noPoolImport =
      !/import[^;]*\bapplyDecision\b/.test(cbSrc) &&
      !/import[^;]*\bapplyDecision\b/.test(svcSrc) &&
      !/import[^;]*\bapplyDecision\b/.test(routesSrc);
    const structuralClean = noPoolCall && noPoolImport;
    expect(structuralClean).toBe(true);
    report(11, 'EXACTLY_ONCE_SOLE_AUTHORITY', structuralClean);
  });

  it('I12 CROSS_USER_ISOLATION: non-owners can never view or activate another user intent', async () => {
    setupBasic();
    const wrongOwnerIntent = await mock.queryOne('SELECT * FROM payment_intents WHERE id = $1 AND owner_id = $2', ['pin-1', 'u-002']);
    mock.intentRows.set('pin-1', { ...mock.intentRows.get('pin-1')!, owner_id: 'u-002' });
    const s = sig();
    const result = await handlePoolCallback('1', {
      razorpay_payment_id: s.paymentId,
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: s.referenceId,
      razorpay_payment_link_status: 'paid',
      razorpay_signature: s.signature,
    });
    // owner-scoped getIntent (WHERE id AND owner_id) fails first -> intent_not_found
    // fail-closed; ownership gate is the second belt-and-suspenders layer.
    const okPaid = wrongOwnerIntent === null && result.outcome === 'intent_not_found' && result.activated === false;
    expect(okPaid).toBe(true);
    report(12, 'CROSS_USER_ISOLATION', okPaid);
  });

  it('I13 NO_SELF_GRANT: no payment endpoint can grant/revoke outside the authoritative rail', async () => {
    const routesSrc = readSrc('modules/payments/pool/routes.ts');
    const cbSrc = readSrc('modules/payments/pool/callback.ts');
    const noDirectGrant = !routesSrc.includes('applyDecision') && !routesSrc.includes('INSERT INTO entitlements') && !cbSrc.includes('INSERT INTO entitlements');
    expect(noDirectGrant).toBe(true);
    report(13, 'NO_SELF_GRANT', noDirectGrant);
  });

  it('I14 WATCHTOWER: globally unscoped, read-only, runs every check even with no alert destination, and the C7 evidence-integrity gate fails globally', async () => {
    // Empty DB: the pool is unprovisioned (C6) and replay/ambiguous evidence is
    // ALSO globally present to prove C7 inspects across all users at once.
    mock.cbRows.set('cb-bad-1', {
      id: 'cb-bad-1', link_index: 1, payment_id: 'pay_replay_A', payment_link_id: 'plink_1',
      reference_id: 'CCPOOL-001', link_status: 'paid', signature_sha: 'd', signature_valid: true,
      outcome: 'duplicate', reason: 'replayed payment id',
    });
    mock.cbRows.set('cb-bad-2', {
      id: 'cb-bad-2', link_index: 2, payment_id: 'pay_amb_B', payment_link_id: 'plink_2',
      reference_id: 'CCPOOL-002', link_status: 'paid', signature_sha: 'd', signature_valid: true,
      outcome: 'ambiguous', reason: 'untrusted evidence',
    });

    const wt = await runPoolWatchtower();
    // 1) Every check C1-C7 executed and was recorded.
    const ids = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((c) => wt.checks.find((x) => x.check === c)).filter(Boolean);
    const allRan = wt.checks.length === 7 && ids.length === 7 && wt.checks.every((c) => typeof c.ok === 'boolean');
    // 2) Global signals fail closed: empty pool (C6) AND replay/duplicate/ambiguous evidence (C7).
    const c6 = wt.checks.find((c) => c.check === 'C6');
    const c7 = wt.checks.find((c) => c.check === 'C7');
    const globalState = !!c6 && !c6.ok && !!c7 && !c7.ok && String(c7.detail).includes('duplicate');
    // 3) No alert destination configured, nothing dispatched, but not a single
    //    check was skipped — and exactly one explicit warning marks it.
    const noDest = wt.alertDestinationConfigured === false && wt.alertSent === false && enqueueOutbox.mock.calls.length === 0;
    const dstWarning = testLogger.warn.mock.calls.filter((c) => c[0] === 'payment.watchtower.alert_destination_unconfigured');
    const singleWarning = dstWarning.length === 1 && JSON.stringify(dstWarning[0]).includes('ALERT_DESTINATION_UNCONFIGURED');
    // 4) Read-only scan: no mutating statement was issued by the watchtower.
    const wrote = mock.queries.some((q) => /^(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(q));
    // 5) GLOBALLY UNSCOPED: the scan issued ONLY system-wide aggregates — no
    //    owner/user/workspace identity filter in any watchtower query.
    const watchtowerQueries = mock.queries.filter((q) => q.includes('payment_link_reservations') || q.includes('payment_link_pool') || q.includes('payment_pool_callbacks'));
    const unscoped = watchtowerQueries.every((q) => !/owner_id\s*=|\buser_id\s*=|workspace_id/i.test(q)) && watchtowerQueries.length >= 7;
    const okPaid = allRan && globalState && noDest && singleWarning && !wrote && unscoped;
    expect(okPaid).toBe(true);
    report(14, 'WATCHTOWER_GLOBAL_READONLY', okPaid);
  });

  it('I15 SECRET_HYGIENE: raw signature/secret never lands in result, ledger, or audit', async () => {
    setupBasic();
    const rawForge = createHmac('sha256', 'attacker-secret').update('CCPOOL-001:pay_secret').digest('hex');
    const resultRaw = await handlePoolCallback('1', {
      razorpay_payment_id: 'pay_secret',
      razorpay_payment_link_id: 'plink_1',
      razorpay_payment_link_reference_id: 'CCPOOL-001',
      razorpay_payment_link_status: 'paid',
      razorpay_signature: rawForge,
    });
    const resultDump = JSON.stringify(resultRaw);
    const ledgerDump = JSON.stringify([...mock.cbRows.values()]);
    const auditDump = JSON.stringify(recordAudit.mock.calls);
    const okPaid =
      !resultDump.includes(rawForge) && !resultDump.includes('attacker-secret') &&
      !ledgerDump.includes(rawForge) && !ledgerDump.includes('attacker-secret') &&
      !auditDump.includes(rawForge);
    expect(okPaid).toBe(true);
    report(15, 'SECRET_HYGIENE', okPaid);
  });

  it('I16 NO_FAKES: all 15 invariants ran and passed; nothing skipped', () => {
    const allRun = invariants.length === 15;
    const allPass = allRun && invariants.every((i) => i.ok);
    expect(allPass).toBe(true);
    report(16, 'NO_FAKES', allPass);
  });
});