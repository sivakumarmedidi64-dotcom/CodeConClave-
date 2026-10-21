import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory model of the two credit tables + the two payment tables they read.
const state = vi.hoisted(() => ({
  intents: [] as { id: string; amount_inr: number }[],
  entitlement: null as { id: string } | null,
  ledger: [] as { kind: string; amount: number; ref: string | null }[],
  balance: null as null | { balance: number; granted: number; spent: number; calls: number },
}));

vi.mock('../../shared/db.js', () => {
  const q = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM payment_intents')) return { rows: state.intents };
      if (sql.includes('FROM entitlements')) return { rows: state.entitlement ? [state.entitlement] : [] };
      if (sql.includes("VALUES ($1,$2,'GRANT'")) {
        const ref = params[3] as string;
        if (state.ledger.some((l) => l.ref === ref)) return { rows: [] }; // ON CONFLICT DO NOTHING
        state.ledger.push({ kind: 'GRANT', amount: params[2] as number, ref });
        return { rows: [{ id: 'acl_x' }] };
      }
      if (sql.includes('INSERT INTO api_credit_balances (owner_id, balance_paise, granted_paise')) {
        const p = params[1] as number;
        state.balance = state.balance
          ? { ...state.balance, balance: state.balance.balance + p, granted: state.balance.granted + p }
          : { balance: p, granted: p, spent: 0, calls: 0 };
        return { rows: [] };
      }
      if (sql.includes("'DEBIT'")) {
        state.ledger.push({ kind: 'DEBIT', amount: params[2] as number, ref: null });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO api_credit_balances (owner_id, balance_paise, spent_paise, calls)')) {
        const c = params[1] as number;
        state.balance = state.balance
          ? { ...state.balance, balance: state.balance.balance - c, spent: state.balance.spent + c, calls: state.balance.calls + 1 }
          : { balance: -c, granted: 0, spent: c, calls: 1 };
        return { rows: [{ balance_paise: state.balance.balance }] };
      }
      if (sql.includes('FROM api_credit_balances')) {
        const b = state.balance;
        return { rows: b ? [{ balance_paise: b.balance, granted_paise: b.granted, spent_paise: b.spent, calls: b.calls, last_topup_at: new Date() }] : [] };
      }
      return { rows: [] };
    }),
  };
  return { withSystem: vi.fn(async (fn: (q: unknown) => unknown) => fn(q)) };
});

const notified = vi.hoisted(() => [] as { title: string; body?: string }[]);
vi.mock('../notifications/service.js', () => ({
  notify: vi.fn(async (_to: string, _type: string, title: string, input: { body?: string }) => {
    notified.push({ title, body: input?.body });
  }),
}));

import { assertApiCredits, callCostPaise, creditState, crossedAlertLevels, CREDIT_ALERT_LEVELS_PAISE, debitApiCall, ensureGrants } from './credits.js';

beforeEach(() => {
  notified.length = 0;
  state.intents = [];
  state.entitlement = null;
  state.ledger = [];
  state.balance = null;
});

describe('API Access prepaid credits', () => {
  it('prices a call from its real tokens (₹1 per 1K tokens, ₹0.10 minimum by default)', () => {
    expect(callCostPaise(0)).toBe(10);
    expect(callCostPaise(50)).toBe(10);
    expect(callCostPaise(1000)).toBe(100);
    expect(callCostPaise(2501)).toBe(251);
  });

  it('grants ₹50,000 per verified purchase, exactly once each', async () => {
    state.intents = [{ id: 'pi_1', amount_inr: 50000 }];
    expect(await ensureGrants('usr_1')).toBe(1);
    expect(await ensureGrants('usr_1')).toBe(0); // idempotent
    state.intents.push({ id: 'pi_2', amount_inr: 50000 }); // a top-up
    expect(await ensureGrants('usr_1')).toBe(1);
    const s = await creditState('usr_1');
    expect(s).toMatchObject({ balancePaise: 10_000_000, grantedPaise: 10_000_000, exhausted: false });
  });

  it('a complimentary entitlement with no purchase gets one block', async () => {
    state.entitlement = { id: 'ent_1' };
    expect(await ensureGrants('usr_1')).toBe(1);
    expect(await ensureGrants('usr_1')).toBe(0);
  });

  it('debits calls and refuses new ones at ₹0 until a top-up', async () => {
    state.intents = [{ id: 'pi_1', amount_inr: 50000 }];
    await assertApiCredits('usr_1');
    const d = await debitApiCall('usr_1', 1500, 'ak_1', 'req_1');
    expect(d).toEqual({ costPaise: 150, balancePaise: 5_000_000 - 150 });
    // Drain it.
    state.balance!.balance = 0;
    await expect(assertApiCredits('usr_1')).rejects.toMatchObject({ status: 402, errorCode: 'api_credits_exhausted', message: expect.stringContaining('Top up ₹50,000') });
    // A new ₹50,000 purchase restores access.
    state.intents.push({ id: 'pi_2', amount_inr: 50000 });
    await expect(assertApiCredits('usr_1')).resolves.toMatchObject({ balancePaise: 5_000_000, exhausted: false });
  });

  it('no purchase at all → no credits, with a clear message', async () => {
    await expect(assertApiCredits('usr_1')).rejects.toMatchObject({ errorCode: 'api_credits_exhausted', message: expect.stringContaining('Buy API Access') });
  });

  it('alerts at ₹10,000, ₹2,500 and ₹0 — once each per top-up', async () => {
    expect(CREDIT_ALERT_LEVELS_PAISE).toEqual([1_000_000, 250_000, 0]);
    expect(crossedAlertLevels(1_000_100, 999_900)).toEqual([1_000_000]);
    expect(crossedAlertLevels(999_900, 999_800)).toEqual([]);
    expect(crossedAlertLevels(300_000, -10)).toEqual([250_000, 0]);
    state.intents = [{ id: 'pi_1', amount_inr: 50000 }];
    await ensureGrants('usr_1');
    state.balance!.balance = 1_000_050; // ₹10,000.50 left
    await debitApiCall('usr_1', 1000, 'ak_1', 'req_a'); // −₹1 → crosses ₹10,000
    await debitApiCall('usr_1', 1000, 'ak_1', 'req_b'); // already below: no repeat
    expect(notified.map((n) => n.title)).toEqual(['API credits: ₹9,999 left']);
    state.balance!.balance = 50;
    await debitApiCall('usr_1', 1000, 'ak_1', 'req_c'); // crosses ₹0
    expect(notified.at(-1)).toMatchObject({ title: 'API credits used up', body: expect.stringContaining('Top up ₹50,000') });
  });
});
