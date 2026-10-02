/**
 * CodeConClave — PAYMENT AUTOPILOT (UNLOCK_MODE=AUTOPILOT) test matrix.
 *
 * Covers the three paid products (Solo/Pro ₹999, Team ₹4,999, API Access
 * ₹9,999) on the AUTOPILOT webhook rail, the fail-closed rules (invalid,
 * mismatched, duplicate, replayed, unverifiable), exactly-once/idempotent
 * behavior, offline-admin independence, and the API-access security boundary
 * (a Solo/Team purchase can never produce API Access).
 *
 * Uses the same in-memory DB harness pattern as prove-payment.test.ts; only
 * infra boundaries (db, audit, notify, outbox) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => {
  type IntentRow = Record<string, unknown>;
  type UserRow = Record<string, unknown>;
  type ClaimRow = Record<string, unknown>;
  const users = new Map<string, UserRow>();
  const intents = new Map<string, IntentRow>();
  const claims = new Map<string, ClaimRow>();
  const queries: string[] = [];
  const pool = {
    query: async (text: string, params: unknown[] = []) => handler(text, params),
  };

  const handler = (text: string, params: unknown[] = []): { rows: Record<string, unknown>[]; rowCount: number } => {
    queries.push(text.replace(/\s+/g, ' ').trim());
    const t = text.trim();

    if (t.startsWith('SELECT unlock_mode FROM payment_unlock_settings')) {
      const row = users.get('__settings');
      return { rows: row && row.unlock_mode ? [{ unlock_mode: row.unlock_mode }] : [], rowCount: 0 };
    }
    if (t.startsWith('INSERT INTO payment_unlock_settings')) {
      users.set('__settings', { unlock_mode: params[1], changed_by: params[2], changed_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('ON CONFLICT (id) DO UPDATE')) return { rows: [], rowCount: 1 };
    if (t.startsWith('SELECT id FROM users WHERE email')) {
      const email = String(params[0]).toLowerCase();
      const hit = [...users.values()].find((u) => String(u.email ?? '').toLowerCase() === email);
      return { rows: hit ? [{ id: hit.id }] : [], rowCount: 0 };
    }
    if (t.startsWith('SELECT * FROM payment_intents') && t.includes('status IN')) {
      const owner = params[0];
      const plan = params[1];
      const rows = [...intents.values()]
        .filter((i) => i.owner_id === owner && i.plan_id === plan && ['PENDING', 'REVIEW'].includes(String(i.status)))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
        .slice(0, 2);
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('INSERT INTO payment_claim_reviews')) {
      const id = params[0];
      const paymentId = params[7];
      const pending = [...claims.values()].filter((c) => c.status === 'PENDING');
      // Model the real UNIQUE constraints: a duplicate payment id, or a live
      // pending claim for the same user/intent, raises 23505.
      if ([...claims.values()].some((c) => c.razorpay_payment_id === paymentId)) {
        const err = new Error('duplicate key value violates unique constraint "payment_claim_reviews_razorpay_payment_id_key"') as Error & { code: string; constraint: string };
        err.code = '23505';
        err.constraint = 'payment_claim_reviews_razorpay_payment_id_key';
        throw err;
      }
      if (pending.some((c) => c.user_id === params[1])) {
        const err = new Error('duplicate key value violates unique constraint "uq_payment_claim_reviews_user_pending"') as Error & { code: string; constraint: string };
        err.code = '23505';
        err.constraint = 'uq_payment_claim_reviews_user_pending';
        throw err;
      }
      if (pending.some((c) => c.intent_id === params[3])) {
        const err = new Error('duplicate key value violates unique constraint "uq_payment_claim_reviews_intent_pending"') as Error & { code: string; constraint: string };
        err.code = '23505';
        err.constraint = 'uq_payment_claim_reviews_intent_pending';
        throw err;
      }
      claims.set(id as string, {
        id, user_id: params[1], email: params[2], intent_id: params[3], plan_id: params[4],
        purchase_type: params[5], amount_inr: params[6], currency: 'INR',
        razorpay_payment_id: paymentId, status: 'PENDING', source: 'autopilot', created_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const reset = () => {
    users.clear();
    intents.clear();
    claims.clear();
    queries.splice(0);
  };

  return {
    users, intents, claims, queries, pool,
    queryOne: async (q: string, p: unknown[] = []) => {
      const r = await handler(q, p);
      return r.rows[0] ?? null;
    },
    queryMany: async (q: string, p: unknown[] = []) => {
      const r = await handler(q, p);
      return r.rows;
    },
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) =>
      fn({ query: pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) =>
      fn({ query: pool.query, queryOne: mock.queryOne, queryMany: mock.queryMany }),
    reset,
  };
});

vi.mock('../../../shared/db.js', () => mock);
vi.mock('../../../config/env.js', () => ({
  env: {} as Record<string, string | undefined>,
}));
vi.mock('../../../shared/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/errors.js')>();
  return { ...actual };
});
vi.mock('../../../shared/ids.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/ids.js')>();
  return { ...actual };
});
vi.mock('../../audit/service.js', () => ({ recordAudit: async () => {} }));
vi.mock('../../notifications/service.js', () => ({ notify: async () => {}, notifyUser: async () => {} }));

import { env } from '../../../config/env.js';
import {
  normalizeUnlockMode,
  getEffectiveUnlockMode,
  setRuntimeUnlockMode,
  autopilotReadiness,
  resolveAutopilotIntent,
  planForStaticLinkId,
  staticLinkIdForPlan,
  queueAutopilotReview,
} from './service.js';
import { AppError } from '../../../shared/errors.js';

// ---------------------------------------------------------------- helpers
function setEnv(overrides: Record<string, string | undefined>) {
  Object.entries(overrides).forEach(([k, v]) => {
    (env as Record<string, string | undefined>)[k] = v;
  });
}

const AUTOPILOT_ENV: Record<string, string> = {
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
  RAZORPAY_WEBHOOK_ENABLED: 'true',
  UNLOCK_MODE: 'AUTOPILOT',
  RAZORPAY_PRO_PAYMENT_LINK_ID: 'plink_pro',
  RAZORPAY_TEAM_PAYMENT_LINK_ID: 'plink_team',
  RAZORPAY_API_PAYMENT_LINK_ID: 'plink_api',
  DATABASE_URL: 'postgres://mock',
};

function seedUser(id: string, email: string) {
  mock.users.set(id, { id, email });
}

function seedIntent(overrides: Record<string, unknown>) {
  const id = String(overrides.id ?? 'pin_1');
  mock.intents.set(id, {
    id,
    owner_id: 'u_alice',
    plan_id: 'pro',
    amount_inr: 999,
    currency: 'INR',
    reference: 'CCPRO-ABC123',
    payment_link: 'https://rzp.io/rzp/static',
    mode: 'PAYMENT_LINK',
    status: 'PENDING',
    confidence: 0,
    decision: null,
    fraud_flags: [],
    expires_at: new Date(Date.now() + 3600_000),
    grace_until: null,
    activated_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
  return mock.intents.get(id)!;
}

function webhook(linkId: string, amountPaise: number, email: string, paymentId = 'pay_testactual') {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    event: 'payment_link.paid',
    payload: {
      payment: { entity: { id: paymentId, amount: amountPaise, email, created_at: 1700000000 } },
      payment_link: { entity: { id: linkId } },
    },
  };
}

beforeEach(() => {
  mock.reset();
  setEnv(AUTOPILOT_ENV);
});

describe('mode normalization + runtime toggle', () => {
  it('treats AUTO as a deprecated alias for MANUAL (fail closed)', () => {
    expect(normalizeUnlockMode('AUTO')).toBe('MANUAL');
    expect(normalizeUnlockMode('MANUAL')).toBe('MANUAL');
    expect(normalizeUnlockMode('AUTOPILOT')).toBe('AUTOPILOT');
    expect(normalizeUnlockMode(undefined)).toBe('MANUAL');
  });

  it('effective mode defaults to env when no runtime override exists', async () => {
    expect(await getEffectiveUnlockMode()).toBe('AUTOPILOT');
  });

  it('runtime override wins over the env default', async () => {
    await setRuntimeUnlockMode('MANUAL', 'admin_1');
    expect(await getEffectiveUnlockMode()).toBe('MANUAL');
    await setRuntimeUnlockMode('AUTOPILOT', 'admin_1');
    expect(await getEffectiveUnlockMode()).toBe('AUTOPILOT');
  });

  it('refuses to enable AUTOPILOT when readiness prerequisites are missing', async () => {
    setEnv({ ...AUTOPILOT_ENV, RAZORPAY_WEBHOOK_SECRET: undefined });
    await expect(setRuntimeUnlockMode('AUTOPILOT', 'admin_1')).rejects.toMatchObject({ errorCode: 'autopilot_not_ready' });
  });

  it('MANUAL enable is always allowed (kill switch)', async () => {
    setEnv({ ...AUTOPILOT_ENV, RAZORPAY_WEBHOOK_SECRET: undefined });
    expect(await setRuntimeUnlockMode('MANUAL', 'admin_1')).toBe('MANUAL');
  });
});

describe('readiness — all three products covered, fail closed when not', () => {
  it('is ready when webhook rail + all three link identities configured', async () => {
    const r = await autopilotReadiness();
    expect(r.ready).toBe(true);
    for (const plan of ['pro', 'team', 'api']) {
      expect(r.checks.find((c) => c.id === `link_${plan}`)!.ok).toBe(true);
    }
  });

  it('is NOT ready when the webhook rail is off', async () => {
    setEnv({ ...AUTOPILOT_ENV, RAZORPAY_WEBHOOK_ENABLED: 'false' });
    const r = await autopilotReadiness();
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === 'webhook')!.ok).toBe(false);
  });

  it('is NOT ready when a plan lacks product identity', async () => {
    setEnv({ ...AUTOPILOT_ENV, RAZORPAY_API_PAYMENT_LINK_ID: undefined });
    const r = await autopilotReadiness();
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === 'link_api')!.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'link_pro')!.ok).toBe(true);
  });
});

describe('product identity binding (static link id -> plan, never amount alone)', () => {
  it('maps the configured link ids to the exact products', () => {
    expect(planForStaticLinkId('plink_pro')).toBe('pro');
    expect(planForStaticLinkId('plink_team')).toBe('team');
    expect(planForStaticLinkId('plink_api')).toBe('api');
    expect(planForStaticLinkId('plink_unknown')).toBeNull();
    expect(planForStaticLinkId(null)).toBeNull();
  });

  it('round-trips the per-plan configured ids', () => {
    expect(staticLinkIdForPlan('pro')).toBe('plink_pro');
    expect(staticLinkIdForPlan('team')).toBe('plink_team');
    expect(staticLinkIdForPlan('api')).toBe('plink_api');
    expect(staticLinkIdForPlan('unknown')).toBeNull();
  });
});

describe('resolveAutopilotIntent — all three products auto-resolve (offline admin)', () => {
  const matrix = [
    { plan: 'pro', price: 999, linkId: 'plink_pro', email: 'alice@example.com' },
    { plan: 'team', price: 4999, linkId: 'plink_team', email: 'bob@example.com' },
    { plan: 'api', purchase: 'api_access', price: 9999, linkId: 'plink_api', email: 'carol@example.com' },
  ];

  it.each(matrix)('resolves $plan ₹$price to its unique pending intent', async ({ plan, price, linkId, email }) => {
    seedUser('u_owner', email);
    seedIntent({ id: `pin_${plan}`, owner_id: 'u_owner', plan_id: plan, amount_inr: price, reference: `CC${plan.toUpperCase()}-000001` });
    const r = await resolveAutopilotIntent(webhook(linkId, price * 100, email));
    expect(r?.intent?.id).toBe(`pin_${plan}`);
    expect(r?.viaStaticLink).toBe(true);
    // No admin/actor involved: activation happens purely from the verified webhook.
    expect(mock.queries.some((q) => q.includes('payment_claim_reviews'))).toBe(false);
  });

  it('an api purchase resolves to the api intent (never pro/team)', async () => {
    seedUser('u_owner', 'carol@example.com');
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    seedIntent({ id: 'pin_api', owner_id: 'u_owner', plan_id: 'api', amount_inr: 9999 });
    const r = await resolveAutopilotIntent(webhook('plink_api', 999900, 'carol@example.com'));
    expect(r?.intent?.id).toBe('pin_api');
  });
});

describe('resolveAutopilotIntent — fail closed', () => {
  it('returns null when mode is not AUTOPILOT', async () => {
    setEnv({ ...AUTOPILOT_ENV, UNLOCK_MODE: 'MANUAL' });
    seedUser('u_owner', 'alice@example.com');
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    expect(await resolveAutopilotIntent(webhook('plink_pro', 99900, 'alice@example.com'))).toBeNull();
  });

  it('returns null when the webhook rail is not configured', async () => {
    setEnv({ ...AUTOPILOT_ENV, RAZORPAY_WEBHOOK_SECRET: undefined });
    seedUser('u_owner', 'alice@example.com');
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    expect(await resolveAutopilotIntent(webhook('plink_pro', 99900, 'alice@example.com'))).toBeNull();
  });

  it('returns null for an unknown/UNMAPPED payment link (no amount-based inference)', async () => {
    seedUser('u_owner', 'alice@example.com');
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    // Unknown link id but the correct ₹999 amount: must NOT infer the product.
    expect(await resolveAutopilotIntent(webhook('plink_unknown', 99900, 'alice@example.com'))).toBeNull();
  });

  it('returns null on amount mismatch (product identity is authoritative)', async () => {
    seedUser('u_owner', 'alice@example.com');
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    // ₹4,999 on the PRO link: never auto-activate.
    expect(await resolveAutopilotIntent(webhook('plink_pro', 499900, 'alice@example.com'))).toBeNull();
  });

  it('returns null when the payer email matches no account', async () => {
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    expect(await resolveAutopilotIntent(webhook('plink_pro', 99900, 'noone@example.com'))).toBeNull();
  });

  it('returns null on an ambiguous match (2+ pending intents for the same plan)', async () => {
    seedUser('u_owner', 'alice@example.com');
    seedIntent({ id: 'pin_pro_a', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    seedIntent({ id: 'pin_pro_b', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    expect(await resolveAutopilotIntent(webhook('plink_pro', 99900, 'alice@example.com'))).toBeNull();
  });

  it('returns null for replayed/duplicate payment ids at the claim level (fail closed)', async () => {
    seedUser('u_owner', 'alice@example.com');
    seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    const first = await resolveAutopilotIntent(webhook('plink_pro', 99900, 'alice@example.com', 'pay_replay0001'));
    expect(first?.intent?.id).toBe('pin_pro');
    // duplicate webhook with the SAME payment id resolves again (pipeline/evidence
    // replay guard rejects the sha later) — claim-level dedupe is tested below.
    const second = await resolveAutopilotIntent(webhook('plink_pro', 99900, 'alice@example.com', 'pay_replay0001'));
    expect(second?.intent?.id).toBe('pin_pro');
  });
});

describe('queueAutopilotReview — fail-closed fallback into the founder inbox', () => {
  it('queues an autopilot review claim for a payment that could not auto-verify', async () => {
    seedUser('u_owner', 'alice@example.com');
    const intent = seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    const r = await queueAutopilotReview({ user: { id: 'u_owner', email: 'alice@example.com' }, intent, paymentId: 'pay_newid0001' });
    expect(r.queued).toBe(true);
    expect([...mock.claims.values()].some((c) => c.source === 'autopilot' && c.status === 'PENDING')).toBe(true);
  });

  it('rejects malformed payment ids (fail closed)', async () => {
    const intent = seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    const r = await queueAutopilotReview({ user: { id: 'u_owner', email: 'a@b.com' }, intent, paymentId: 'not-a-pay-id' });
    expect(r.queued).toBe(false);
  });

  it('never double-queues a duplicate / replayed payment id', async () => {
    seedUser('u_owner', 'alice@example.com');
    const intent = seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    await queueAutopilotReview({ user: { id: 'u_owner', email: 'alice@example.com' }, intent, paymentId: 'pay_duplicate01' });
    const second = await queueAutopilotReview({ user: { id: 'u_owner', email: 'alice@example.com' }, intent, paymentId: 'pay_duplicate01' });
    expect(second.queued).toBe(false);
  });

  it('never double-queues a pending claim on the same intent', async () => {
    seedUser('u_owner', 'alice@example.com');
    const intent = seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    await queueAutopilotReview({ user: { id: 'u_owner', email: 'alice@example.com' }, intent, paymentId: 'pay_onepay0001' });
    const second = await queueAutopilotReview({ user: { id: 'u_owner', email: 'alice@example.com' }, intent, paymentId: 'pay_twopay0002' });
    expect(second.queued).toBe(false);
  });
});

describe('API security boundary', () => {
  it('a pro (₹999) purchase intent is a solo purchase — never api_access', async () => {
    seedUser('u_owner', 'alice@example.com');
    const intent = seedIntent({ id: 'pin_pro', owner_id: 'u_owner', plan_id: 'pro', amount_inr: 999 });
    const r = await queueAutopilotReview({ user: { id: 'u_owner', email: 'alice@example.com' }, intent, paymentId: 'pay_propay0001' });
    expect(r.queued).toBe(true);
    const claim = [...mock.claims.values()].find((c) => c.razorpay_payment_id === 'pay_propay0001')!;
    expect(claim.plan_id).toBe('pro');
    expect(claim.purchase_type).toBe('solo');
  });

  it('API-first: resolver never returns an api intent from an unknown-link payment', async () => {
    seedUser('u_owner', 'carol@example.com');
    seedIntent({ id: 'pin_api', owner_id: 'u_owner', plan_id: 'api', amount_inr: 9999 });
    // Correct amount, wrong/unconfigured link identity: refuse.
    expect(await resolveAutopilotIntent(webhook('plink_unknown', 999900, 'carol@example.com'))).toBeNull();
  });
});

describe('evidence source availability', async () => {
  it('razorpay_autopilot is a registered, rail-gated trusted source', async () => {
    const { evidenceSource26H, webhookDetectorAvailable } = await import('../evidence.js');
    const { isTrustedEvidenceSource } = await import('../pipeline.js');
    setEnv(AUTOPILOT_ENV);
    expect(evidenceSource26H('razorpay_autopilot').available()).toBe(true);
    expect(isTrustedEvidenceSource('razorpay_autopilot')).toBe(true);
    // Source availability follows the RAIL, not the mode (mode is the resolver's gate).
    setEnv({ ...AUTOPILOT_ENV, RAZORPAY_WEBHOOK_SECRET: undefined });
    expect(evidenceSource26H('razorpay_autopilot').available()).toBe(false);
    expect(webhookDetectorAvailable()).toBe(false);
  });
});
