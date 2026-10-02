/**
 * CodeConClave — TEST-ONLY payment bypass (PAYMENT_TEST_USER_IDS) tests.
 *
 * The bypass exists so one explicitly configured account can validate
 * protected features without paying. It is a read-time override only:
 * - allowlist is server-side user IDs (exact match; empty = disabled)
 * - never email-based, never client-influenced
 * - writes no entitlement or payment rows, marks no payment successful
 * - does NOT grant API Access (separate product, still gated)
 * - ordinary users are completely unaffected (still 402 without payment)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: 0 };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { paymentTestUserIds } from '../config/env.js';
import { isPaymentTestUser, effectivePlan } from '../modules/entitlements/service.js';
import { workspaceAccess } from '../middleware/entitlement.js';
import { apiAccessEntitlementState } from '../modules/apikeys/service.js';

const TEST_USER = 'usr_payment_test_1';
const ORDINARY_USER = 'usr_ordinary_9';

function freeUserRow() {
  return {
    plan_id: 'free', entitlement_state: 'FREE', email: 'someone@example.com',
    email_verified: true, is_founder: false,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = (text) => {
    if (text.includes('FROM users')) return [freeUserRow()];
    if (text.includes('FROM entitlements')) return [];
    return [];
  };
  paymentTestUserIds.add(TEST_USER);
});

afterEach(() => {
  paymentTestUserIds.delete(TEST_USER);
});

function wroteMoneyRows(): boolean {
  return db.state.calls.some((c) =>
    /INSERT INTO (entitlements|payments|payment_sessions|payment_intents|payment_evidence)\b/.test(c.text),
  );
}

describe('TEST-ONLY payment bypass', () => {
  it('unlocks the Team workspace for the allowlisted ID only, visibly marked', async () => {
    const access = await workspaceAccess(TEST_USER);
    expect(access.unlocked).toBe(true);
    expect(access.effectivePlan).toBe('team');
    expect(access.testBypass).toBe(true);
    expect(await effectivePlan(TEST_USER)).toBe('team');
  });

  it('leaves ordinary users fully gated (still locked without payment)', async () => {
    const access = await workspaceAccess(ORDINARY_USER);
    expect(access.unlocked).toBe(false);
    expect(access.effectivePlan).toBe('free');
    expect(access.testBypass).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
    expect(await effectivePlan(ORDINARY_USER)).toBe('free');
  });

  it('is disabled when the allowlist is empty', async () => {
    paymentTestUserIds.delete(TEST_USER);
    const access = await workspaceAccess(TEST_USER);
    expect(access.unlocked).toBe(false);
    expect(access.testBypass).toBe(false);
  });

  it('never matches by email and never activates for unknown IDs', () => {
    expect(isPaymentTestUser('founder@example.com')).toBe(false);
    expect(isPaymentTestUser('usr_stranger')).toBe(false);
    expect(isPaymentTestUser(null)).toBe(false);
    expect(isPaymentTestUser(undefined)).toBe(false);
    expect(isPaymentTestUser(TEST_USER)).toBe(true);
  });

  it('writes no entitlement or payment rows (no fake payment exists)', async () => {
    await workspaceAccess(TEST_USER);
    await effectivePlan(TEST_USER);
    expect(wroteMoneyRows()).toBe(false);
  });

  it('does NOT grant API Access (separate product stays gated)', async () => {
    const { entitled } = await apiAccessEntitlementState(TEST_USER);
    expect(entitled).toBe(false);
  });
});
