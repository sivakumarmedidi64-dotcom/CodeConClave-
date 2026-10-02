/**
 * CodeConClave — PAYMENT LINK-POOL seeder + fresh-DB regression tests (Phase 5/6).
 *
 * Verifies, against a stateful in-memory DB (repo convention: vi.mock of
 * ../shared/db.js), that:
 *   - a fresh DB (empty payment_link_pool) is provisioned by the REAL seeder
 *   - reseeding is idempotent (no duplicate rows)
 *   - INR-only hard gate: non-INR entries skipped, never converted
 *   - amount binding: a link whose amount != authoritative plan price is
 *     skipped as unvalidatable
 *   - live RESERVED links are preserved across reseed (in-flight checkout)
 *   - after fresh seeding, the reserve flow really can reserve a link
 *   - a single-link pool cannot be double-reserved (503 ALL_LINKS_BUSY)
 *   - 100 concurrent assigns against a single-link pool: exactly one reserves,
 *     99 fail closed with ALL_LINKS_BUSY (DB unique-index semantics modeled)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const seederLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../shared/logger.js', () => ({ logger: seederLogger }));

// ---------------------------------------------------------------------------
// Stateful in-memory SQL harness. Modeled on the real Postgres constraints:
//   - payment_link_pool upsert by link_index
//   - partial unique index uq_pool_reservation_live_link (one RESERVED/link)
//   - partial unique index uq_pool_reservation_live_intent (one RESERVED/intent)
// ---------------------------------------------------------------------------
const store = vi.hoisted(() => {
  type PoolRow = {
    link_index: number;
    payment_link_id: string | null;
    razorpay_url: string;
    reference_id: string;
    amount: number;
    currency: string;
    plan: string;
    callback_path: string;
    is_active: boolean;
    consumed_at?: Date | null;
  };
  type ResRow = {
    id: string;
    link_index: number;
    intent_id: string;
    user_id: string;
    plan: string;
    amount_inr: number;
    currency: string;
    link_reference_id: string;
    status: string;
    expires_at: Date;
  };
  type IntentRow = Record<string, unknown>;

  const poolRows = new Map<number, PoolRow>();
  const resRows = new Map<string, ResRow>();
  const intentRows = new Map<string, IntentRow>();

  const reset = () => {
    poolRows.clear();
    resRows.clear();
    intentRows.clear();
  };

  const handler = (text: string, params: unknown[] = []): Record<string, unknown>[] => {
    const t = text.trim();

    // ---- seeder: upsert pool catalogue ----
    if (t.startsWith('INSERT INTO payment_link_pool')) {
      const [index, paymentLinkId, url, ref, amount, currency, plan, cbPath, isActive] = params as [
        number, string | null, string, string, number, string, string, string, boolean,
      ];
      const row: PoolRow = {
        link_index: index, payment_link_id: paymentLinkId, razorpay_url: url,
        reference_id: ref, amount, currency, plan: plan as string, callback_path: cbPath,
        is_active: isActive,
      };
      poolRows.set(index, row);
      return [];
    }
    // ---- seeder: totals ----
    if (t.startsWith('SELECT count(*)') && t.includes('WHERE is_active')) {
      return [{ n: [...poolRows.values()].filter((r) => r.is_active).length }];
    }
    if (t.startsWith('SELECT count(*)')) return [{ n: poolRows.size }];
    // ---- seeder: existing catalogue rows ----
    if (t.startsWith('SELECT link_index, payment_link_id')) return [...poolRows.values()];
    // ---- seeder: reserved indexes ----
    if (t.startsWith('SELECT link_index FROM payment_link_reservations WHERE status')) {
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
      const index = params[0];
      const row = poolRows.get(Number(index));
      if (row && row.is_active) return [{ ...row }];
      return [];
    }
    // ---- callback/getLinkConfig: single pool row ----
    if (t.startsWith('SELECT * FROM payment_link_pool WHERE link_index')) {
      const row = poolRows.get(Number(params[0]));
      return row ? [{ ...row }] : [];
    }

    // ---- assignLink: reservation INSERT with unique-index semantics ----
    if (t.startsWith('INSERT INTO payment_link_reservations')) {
      const [id, linkIndex, intentId, userId, , plan, amountInr, currency, linkRef, , , expiresAt] = params as [
        string, number, string, string, unknown, string, number, string, string, unknown, unknown, Date,
      ];
      const liveByLink = [...resRows.values()].some((r) => r.status === 'RESERVED' && r.link_index === linkIndex);
      const liveByIntent = [...resRows.values()].some((r) => r.status === 'RESERVED' && r.intent_id === intentId);
      if (liveByLink) {
        throw new Error('duplicate key value violates unique constraint "uq_pool_reservation_live_link"');
      }
      if (liveByIntent) {
        throw new Error('duplicate key value violates unique constraint "uq_pool_reservation_live_intent"');
      }
      resRows.set(id as string, {
        id: id as string, link_index: linkIndex, intent_id: intentId, user_id: userId,
        plan: plan as string, amount_inr: amountInr, currency, link_reference_id: linkRef,
        status: 'RESERVED', expires_at: expiresAt,
      });
      return [];
    }
    // ---- assignLink: bind intent to reservation ----
    if (t.startsWith('UPDATE payment_intents') && t.includes('pool_link_index')) {
      const [intentId, linkIndex, ref, expiresAt, sessionId, clientIp] = params;
      const row = intentRows.get(intentId as string);
      if (row) {
        Object.assign(row, {
          pool_link_index: linkIndex, pool_reference_id: ref, reservation_status: 'RESERVED',
          reservation_expires_at: expiresAt, reservation_locked_at: new Date(),
          pool_session_id: sessionId ?? null, pool_client_ip: clientIp ?? null, updated_at: new Date(),
        });
      }
      return [{ ...(row ?? {}) }];
    }

    // ---- intent creation ----
    if (t.startsWith('INSERT INTO payment_intents')) {
      const [id, ownerId, planId, purchaseType, amount, reference, link, , , , exp] = params as [
        string, string, string, string, number, string, string, unknown, unknown, unknown, Date,
      ];
      intentRows.set(id as string, {
        id, owner_id: ownerId, plan_id: planId, purchase_type: purchaseType, amount_inr: amount, currency: 'INR',
        reference, payment_link: link, mode: 'PAYMENT_LINK', provider_payment_link_id: null,
        provider_reference_id: null, status: 'PENDING', confidence: 0, decision: null,
        fraud_flags: null, expires_at: exp, tenant_id: ownerId, created_at: new Date(),
        updated_at: new Date(), pool_link_index: null, pool_reference_id: null,
        reservation_status: null, reservation_expires_at: null,
      });
      return [];
    }
    // ---- getIntent (owner optional — intents.ts calls with just id) ----
    if (t.startsWith('SELECT * FROM payment_intents WHERE id')) {
      const [id, owner] = params;
      const row = intentRows.get(id as string);
      if (!row) return [];
      if (params.length > 1 && owner !== undefined && row.owner_id !== owner) return [];
      return [{ ...row }];
    }

    return [];
  };

  return {
    poolRows, resRows, intentRows, reset, handler,
    pool: { query: async (q: string, p: unknown[] = []) => {
      const rows = handler(q, p);
      return { rows, rowCount: rows.length };
    } },
    queryOne: async (q: string, p: unknown[] = []) => handler(q, p)[0] ?? null,
    queryMany: async (q: string, p: unknown[] = []) => handler(q, p),
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query: store.pool.query, queryOne: store.queryOne, queryMany: store.queryMany }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query: store.pool.query, queryOne: store.queryOne, queryMany: store.queryMany }),
  };
});

vi.mock('../../../shared/db.js', () => store);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../audit/service.js', () => ({ recordAudit }));
vi.mock('../../notifications/service.js', () => ({ notify: vi.fn(async () => {}), notifyUser: vi.fn(async () => {}) }));

import { env } from '../../../config/env.js';
import { paymentPoolConfig } from '../../../config/payment-pool.js';
import { seedPaymentPool, assertPoolUsable } from './seeder.js';
import { assignLink, poolEnabled } from './service.js';

const ACTIVE_PRO = JSON.stringify([
  { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', paymentLinkId: 'plink_1', enabled: true },
  { index: 2, paymentUrl: 'https://rzp.io/rzp/pool-2', referenceId: 'CCPOOL-002', amount: 4999, currency: 'INR', plan: 'team', callbackPath: '/cb/2', paymentLinkId: 'plink_2', enabled: true },
]);

beforeEach(() => {
  vi.clearAllMocks();
  store.reset();
  recordAudit.mockClear();
  env.PAYMENT_POOL_LINKS = ACTIVE_PRO;
});

describe('payment link-pool: seeder (fresh-DB provisioning)', () => {
  it('provisions an empty pool from the catalogue with exact amount/currency/plan', async () => {
    const report = await seedPaymentPool();
    expect(report.seeded).toBe(2);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.total).toBe(2);
    expect(report.active).toBe(2);
    // Structural validation adds no skips for these entries; the CCPOOL-*
    // ids are the documented UNVERIFIED placeholder scheme, so the aggregate
    // placeholder notice is expected (warning, not failure).
    expect(report.warnings.join(' ')).toMatch(/PLACEHOLDER_LINKS/);
    expect(report.warnings.some((w) => w.includes('skipped'))).toBe(false);
    const rows = [...store.poolRows.values()];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.link_index === 1)).toMatchObject({
      razorpay_url: 'https://rzp.io/rzp/pool-1', reference_id: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', is_active: true,
    });
    expect(rows.find((r) => r.link_index === 2)).toMatchObject({ amount: 4999, currency: 'INR', plan: 'team' });
  });

  it('is idempotent — reseeding a populated pool adds/updates nothing (no dupes)', async () => {
    const first = await seedPaymentPool();
    expect(first.seeded).toBe(2);
    const second = await seedPaymentPool();
    expect(second.seeded).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(second.total).toBe(2);
    expect(store.poolRows.size).toBe(2);
  });

  it('converges changed catalogue data (same index, updated fields) — still one row per index, catalogue-absent rows untouched', async () => {
    await seedPaymentPool();
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1-NEW', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', paymentLinkId: 'plink_1', enabled: true },
    ]);
    const report = await seedPaymentPool();
    expect(report.updated).toBe(1);
    expect(report.total).toBe(2); // index 2's row persists (no destructive pruning)
    expect(store.poolRows.get(1)?.razorpay_url).toBe('https://rzp.io/rzp/pool-1-NEW');
    expect(store.poolRows.get(2)?.amount).toBe(4999);
  });

  it('INR-only hard gate: a non-INR entry is skipped, never converted, never seeds', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: true },
      { index: 2, paymentUrl: 'https://rzp.io/rzp/pool-usd', referenceId: 'CCPOOL-002', amount: 999, currency: 'USD', plan: 'pro', callbackPath: '/cb/2', enabled: true },
    ]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(1);
    expect(report.seeded).toBe(1);
    expect(report.total).toBe(1);
    expect(store.poolRows.has(2)).toBe(false);
    expect(report.warnings.join(' ')).toMatch(/currency USD — launch currency is INR only/);
  });

  it('amount binding: a link priced off the authoritative plan price is skipped (would 100% fail amount_mismatch)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: true },
      { index: 2, paymentUrl: 'https://rzp.io/rzp/pool-wrong', referenceId: 'CCPOOL-002', amount: 1999, currency: 'INR', plan: 'pro', callbackPath: '/cb/2', enabled: true },
    ]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(1);
    expect(report.warnings.join(' ')).toMatch(/amount 1999 != authoritative PRO price 999/);
  });

  it('seeds a disabled entry as is_active=false and counts it as seeded', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: false },
    ]);
    const report = await seedPaymentPool();
    expect(report.seeded).toBe(1);
    expect(report.active).toBe(0);
    expect(report.total).toBe(1);
    expect(store.poolRows.get(1)?.is_active).toBe(false);
  });

  it('preserves a link held by a live RESERVED reservation (in-flight checkout never mutated)', async () => {
    // Pre-existing DB state: link 7 live in the pool, reserved by a live checkout.
    store.poolRows.set(7, {
      link_index: 7, payment_link_id: 'plink_orig', razorpay_url: 'https://rzp.io/rzp/orig',
      reference_id: 'CCPOOL-007', amount: 999, currency: 'INR', plan: 'pro',
      callback_path: '/cb/7', is_active: true,
    });
    store.intentRows.set('pin-7', { id: 'pin-7', owner_id: 'u1', plan_id: 'pro', amount_inr: 999, currency: 'INR', reference: 'CCPRO-7777', status: 'PENDING' });
    store.resRows.set('pvr-7', {
      id: 'pvr-7', link_index: 7, intent_id: 'pin-7', user_id: 'u1', plan: 'pro',
      amount_inr: 999, currency: 'INR', link_reference_id: 'CCPOOL-007', status: 'RESERVED',
      expires_at: new Date(Date.now() + 60_000),
    });
    // New catalogue wants index 7 to point at a different link identity.
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: true },
      { index: 7, paymentUrl: 'https://rzp.io/rzp/NEW-URL', referenceId: 'CCPOOL-007-NEW', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/7-NEW', paymentLinkId: 'plink_REPLACED', enabled: true },
    ]);
    const report = await seedPaymentPool();
    // Index 7 preserved; only the new index 1 was seeded.
    expect(report.unchanged).toBe(1);
    expect(report.seeded).toBe(1);
    expect(store.poolRows.get(7)).toMatchObject({
      payment_link_id: 'plink_orig', razorpay_url: 'https://rzp.io/rzp/orig', reference_id: 'CCPOOL-007', callback_path: '/cb/7',
    });
    expect(report.warnings.join(' ')).toMatch(/link 7 preserved: active RESERVED reservation holds this link/);
  });

  it('SPEC $24: a consumed (fulfilled) link is permanently preserved — config can never resurrect it', async () => {
    // Link 1 was fulfilled: consumed_at tombstone set, is_active cleared.
    store.poolRows.set(1, {
      link_index: 1, payment_link_id: 'plink_1', razorpay_url: 'https://rzp.io/rzp/pool-1',
      reference_id: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro',
      callback_path: '/cb/1', is_active: false, consumed_at: new Date('2026-01-01T00:00:00Z'),
    });
    // Catalogue still says index 1 is enabled — a naive converge would flip it
    // back to active. The consumed guard must win.
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: true },
      { index: 2, paymentUrl: 'https://rzp.io/rzp/pool-2', referenceId: 'CCPOOL-002', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/2', enabled: true },
    ]);
    const report = await seedPaymentPool();
    // Index 1 preserved (not resurrected, not updated); index 2 freshly seeded.
    expect(report.unchanged).toBe(1);
    expect(report.seeded).toBe(1);
    expect(store.poolRows.get(1)).toMatchObject({
      is_active: false,
      consumed_at: new Date('2026-01-01T00:00:00Z'),
    });
    expect(report.warnings.join(' ')).toMatch(/consumed by a fulfilled payment/);
    // Index 2 remains a normal allocatable link.
    expect(store.poolRows.get(2)?.is_active).toBe(true);
  });
});

describe('payment link-pool: fresh-DB reserve flow (real seeder + real assignLink)', () => {
  it('after seeding, a fresh checkout can reserve the link and a second checkout 503s (all busy)', async () => {
    await seedPaymentPool();

    const first = await assignLink('u-A', null, 'pro');
    expect(first.linkIndex).toBe(1);
    expect(first.amountInr).toBe(999);
    expect(first.currency).toBe('INR');
    expect(first.plan).toBe('pro');

    // Same user, same plan -> reuses the reserved intent (no second reservation).
    const again = await assignLink('u-A', null, 'pro');
    expect(again.intentId).toBe(first.intentId);
    expect([...store.resRows.values()].filter((r) => r.status === 'RESERVED')).toHaveLength(1);

    // Different user wants pro; the only pro link is already live-reserved.
    await expect(assignLink('u-B', null, 'pro')).rejects.toMatchObject({ errorCode: 'ALL_LINKS_BUSY_TRY_AGAIN' });

    // Team link is untouched and still reservable by either user.
    const team = await assignLink('u-B', null, 'team');
    expect(team.linkIndex).toBe(2);
    expect(team.amountInr).toBe(4999);
    // Exactly one RESERVED row per link.
    expect([...store.resRows.values()].filter((r) => r.status === 'RESERVED')).toHaveLength(2);
  });

  it('100 concurrent assigns against a one-link pool: exactly one reserves, 99 fail closed', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: true },
    ]);
    await seedPaymentPool();
    expect(poolEnabled()).toBe(true);

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) => assignLink(`u-${String(i).padStart(3, '0')}`, null, 'pro')),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason.errorCode).toBe('ALL_LINKS_BUSY_TRY_AGAIN');
    }

    // DB-level invariant: exactly one live RESERVED reservation for the single link.
    const live = [...store.resRows.values()].filter((r) => r.status === 'RESERVED');
    expect(live).toHaveLength(1);
    expect(live[0].link_index).toBe(1);
    // The link itself stays active (reservation occupancy is by reservation, not by deactivation).
    expect(store.poolRows.get(1)?.is_active).toBe(true);
  });
});

describe('payment link-pool: startup self-check (Phase 4)', () => {
  it('fails loud when explicit config yields an unusable/empty pool', async () => {
    // Explicit config but every entry is invalid (non-INR) -> active == 0.
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-usd', referenceId: 'CCPOOL-001', amount: 999, currency: 'USD', plan: 'pro', callbackPath: '/cb/1', enabled: true },
    ]);
    const report = await seedPaymentPool();
    expect(report.active).toBe(0);
    await expect(assertPoolUsable(report)).rejects.toThrow(/payment-link pool unusable/);
  });

  it('does not fail when the pool is usable (active > 0)', async () => {
    await seedPaymentPool();
    const report = await seedPaymentPool();
    expect(report.active).toBeGreaterThan(0);
    await expect(assertPoolUsable(report)).resolves.toBeUndefined();
  });

  it('does not fail when there is no explicit config (dev/test placeholder catalogue)', async () => {
    env.PAYMENT_POOL_LINKS = undefined;
    const report = await seedPaymentPool();
    // Placeholder catalogue seeds (CCPOOL-<NNN>, UNVERIFIED) — no hard failure.
    await expect(assertPoolUsable(report)).resolves.toBeUndefined();
  });

  it('does not fail when every link is explicitly disabled (intentional state)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-1', referenceId: 'CCPOOL-001', amount: 999, currency: 'INR', plan: 'pro', callbackPath: '/cb/1', enabled: false },
    ]);
    const report = await seedPaymentPool();
    expect(report.active).toBe(0);
    await expect(assertPoolUsable(report)).resolves.toBeUndefined();
  });
});

describe('payment link-pool: real-link format tolerance (Finding 4)', () => {
  const pro = (index: number, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    index,
    paymentUrl: 'https://rzp.io/rzp/pool-1',
    referenceId: `CCPOOL-${String(index).padStart(3, '0')}`,
    amount: 999,
    currency: 'INR',
    plan: 'pro',
    callbackPath: `/cb/${index}`,
    paymentLinkId: 'plink_1',
    enabled: true,
    ...patch,
  });

  it('accepts a very long, structurally valid reference id (no length/charset assumption)', async () => {
    const longRef = `plink_${'aBc-D_ef.123456789'.repeat(6)}${'Z'.repeat(40)}`;
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { paymentUrl: 'https://pay.example/l/AB?src=ci', referenceId: longRef, paymentLinkId: 'pl_ul_44' })]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(report.seeded).toBe(1);
    expect(store.poolRows.get(1)?.reference_id).toBe(longRef);
    expect(store.poolRows.get(1)?.payment_link_id).toBe('pl_ul_44');
  });

  it('accepts unusual-but-valid identifier characters (no format invention)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      pro(1, { referenceId: 'x-y_z.1qAZ', paymentLinkId: 'l_0aBc-Def.12' }),
    ]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(report.seeded).toBe(1);
    expect(store.poolRows.get(1)?.reference_id).toBe('x-y_z.1qAZ');
    expect(store.poolRows.get(1)?.payment_link_id).toBe('l_0aBc-Def.12');
  });

  it('accepts a valid HTTPS URL with query params and preserves it exactly', async () => {
    const url = 'https://secure.example.com/pay/pl_AB-12?utm_source=ci&session=9f1';
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { paymentUrl: url })]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(store.poolRows.get(1)?.razorpay_url).toBe(url);
  });

  it('normalizes whitespace around configured values before storing', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      pro(1, { paymentUrl: '  https://rzp.io/rzp/pool-1  ', referenceId: '  CCPOOL-WS-1  ', callbackPath: '  /cb/1  ', paymentLinkId: ' plink_7 ' }),
    ]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(store.poolRows.get(1)).toMatchObject({
      razorpay_url: 'https://rzp.io/rzp/pool-1',
      reference_id: 'CCPOOL-WS-1',
      callback_path: '/cb/1',
      payment_link_id: 'plink_7',
    });
  });

  it('preserves the configured per-link amount and identity (never fabricated)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { amount: 999 })]);
    await seedPaymentPool();
    expect(store.poolRows.get(1)).toMatchObject({
      amount: 999, currency: 'INR', plan: 'pro',
      razorpay_url: 'https://rzp.io/rzp/pool-1', payment_link_id: 'plink_1',
    });
  });

  it('accepts INR currency and seeds (INR encoding passes structural gate)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { currency: 'INR' })]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(store.poolRows.get(1)?.currency).toBe('INR');
  });

  it('placeholder warning: CCPOOL-* catalogue warns (PLACEHOLDER_LINKS) but still seeds and startup check passes', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1)]);
    const report = await seedPaymentPool();
    expect(report.seeded).toBe(1);
    expect(report.active).toBe(1);
    expect(report.warnings.join(' ')).toMatch(/PLACEHOLDER_LINKS/);
    expect(report.warnings.join(' ')).toMatch(/NOT failing/);
    seederLogger.warn.mockClear();
    await expect(assertPoolUsable(report)).resolves.toBeUndefined();
    expect(seederLogger.warn.mock.calls.some((c) => String(c[0]).includes('PLACEHOLDER_WARNING'))).toBe(true);
    expect(seederLogger.warn.mock.calls.some((c) => String(c[0]).includes('Seeding is NOT failing'))).toBe(true);
  });

  it('placeholder links (CCPOOL-*) may use a plain http URL without being blocked (dev/test must run)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      pro(1, { paymentUrl: 'http://localhost:4000/cb/7', referenceId: 'CCPOOL-007', callbackPath: '/cb/7' }),
    ]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(report.seeded).toBe(1);
    expect(store.poolRows.get(1)?.razorpay_url).toBe('http://localhost:4000/cb/7');
  });

  it('rejects a structurally invalid URL with a warning (never seeds junk)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { paymentUrl: 'not a url' })]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/not a parseable URL/);
  });

  it('rejects an empty reference identifier with a warning', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { referenceId: '' })]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/referenceId is empty/);
  });

  it('rejects a non-INR currency with a warning (never converts)', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([pro(1, { currency: 'USD' })]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/launch currency is INR only/);
  });

  it('requires HTTPS for a REAL (non-placeholder) provider link', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      pro(1, { paymentUrl: 'http://insecure.example.com/pay', referenceId: 'real_plink_ab12' }),
    ]);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/real provider link URL must be HTTPS/);
  });
});

describe('payment link-pool: API ACCESS pool tier (plan "api")', () => {
  it('explicit PAYMENT_POOL_LINKS with plan "api" parses, seeds and preserves the api link', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-api', referenceId: 'CCPOOL-API1', amount: 9999, currency: 'INR', plan: 'api', callbackPath: '/cb/1', paymentLinkId: 'plink_api1', enabled: true },
      { index: 2, paymentUrl: 'https://rzp.io/rzp/pool-team2', referenceId: 'CCPOOL-TEAM2', amount: 4999, currency: 'INR', plan: 'team', callbackPath: '/cb/2', paymentLinkId: 'plink_t2', enabled: true },
    ]);
    const report = await seedPaymentPool();
    expect(report.seeded).toBe(2);
    expect(report.skipped).toBe(0);
    expect(store.poolRows.get(1)).toMatchObject({
      plan: 'api', amount: 9999, currency: 'INR',
      reference_id: 'CCPOOL-API1', payment_link_id: 'plink_api1', razorpay_url: 'https://rzp.io/rzp/pool-api',
    });
    expect(store.poolRows.get(2)).toMatchObject({ plan: 'team', amount: 4999 });
  });

  it('placeholder (unconfigured) catalogue includes API ACCESS links at the ₹9,999 price', async () => {
    env.PAYMENT_POOL_LINKS = undefined as unknown as string;
    const cfg = paymentPoolConfig();
    const apiLinks = cfg.links.filter((l) => l.plan === 'api');
    expect(apiLinks.length).toBeGreaterThan(0);
    expect(apiLinks.every((l) => l.amount === 9999 && l.currency === 'INR')).toBe(true);
    expect(apiLinks.every((l) => l.referenceId.startsWith('CCPOOL-'))).toBe(true);
    const report = await seedPaymentPool();
    expect(report.skipped).toBe(0);
    expect(report.active).toBeGreaterThan(0);
  });

  it('rejects an explicit api link whose amount is not the authoritative ₹9,999', async () => {
    env.PAYMENT_POOL_LINKS = JSON.stringify([
      { index: 1, paymentUrl: 'https://rzp.io/rzp/pool-api', referenceId: 'CCPOOL-API1', amount: 1, currency: 'INR', plan: 'api', callbackPath: '/cb/1', paymentLinkId: 'plink_api1', enabled: true },
    ]);
    const report = await seedPaymentPool();
    expect(report.seeded).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/API price 9999/);
  });
});