import { beforeEach, describe, expect, it, vi } from 'vitest';

// First query: recent events (sessions). Second: this week's tokens by product.
let events: { created_at: Date; tokens: number }[] = [];
let products: { product: string; tokens: number }[] = [];
let fail = false;
vi.mock('../../shared/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (fail) throw new Error('db down');
      return { rows: sql.includes('GROUP BY') ? products : events };
    }),
  },
}));

let paidPlan: 'free' | 'pro' | 'team' = 'pro';
let demo = false;
vi.mock('../entitlements/service.js', () => ({
  effectivePlan: vi.fn(async () => paidPlan),
  temporaryDemoModeEnabled: () => demo,
}));

import { activeSession, assertWithinPlanLimits, limitsFor, planLimits, resolveLimitPlan, weekStartUtc } from './limits.js';

const ago = (mins: number) => new Date(Date.now() - mins * 60_000);

beforeEach(() => {
  events = [];
  products = [];
  fail = false;
  paidPlan = 'pro';
  demo = false;
});

describe('plan usage limits', () => {
  it('maps verified plans to limit tiers — and there is no free tier', async () => {
    paidPlan = 'pro';
    expect(await resolveLimitPlan('usr_1', 'pro')).toBe('solo');
    paidPlan = 'team';
    expect(await resolveLimitPlan('usr_1', 'team')).toBe('team');
    expect(await resolveLimitPlan('usr_1', 'api')).toBe('api');
    // users.plan_id says pro but the payment is not verified → nothing.
    paidPlan = 'free';
    expect(await resolveLimitPlan('usr_1', 'pro')).toBe('none');
    demo = true;
    expect(await resolveLimitPlan('usr_1', 'free')).toBe('demo');
    expect(limitsFor('team').weekly).toBeGreaterThan(limitsFor('solo').weekly);
  });

  it('an account without a paid plan gets no AI at all', async () => {
    paidPlan = 'free';
    await expect(assertWithinPlanLimits('usr_1', 'free')).rejects.toMatchObject({
      status: 402,
      errorCode: 'plan_required',
      message: expect.stringMatching(/no free tier/),
    });
    const l = await planLimits('usr_1', 'free');
    expect(l).toMatchObject({ plan: 'none', planLabel: 'No plan', forecast: 'no_plan', limited: true });
  });

  it('early-access demo mode has its own bounded limits', async () => {
    paidPlan = 'free';
    demo = true;
    await expect(assertWithinPlanLimits('usr_1', 'free')).resolves.toBeUndefined();
    const l = await planLimits('usr_1', 'free');
    expect(l).toMatchObject({ plan: 'demo', planLabel: 'Early access' });
    expect(l.session.limit).toBeGreaterThan(0);
  });

  it('weeks reset Monday 00:00 at the reset offset', () => {
    expect(weekStartUtc(new Date('2026-10-20T10:00:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z'); // Tue → Mon
    expect(weekStartUtc(new Date('2026-10-25T23:59:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z'); // Sun → Mon
    expect(weekStartUtc(new Date('2026-10-19T00:00:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    // IST (UTC+5:30): Monday 00:00 IST is Sunday 18:30 UTC.
    expect(weekStartUtc(new Date('2026-10-18T19:00:00Z'), 330).toISOString()).toBe('2026-10-18T18:30:00.000Z');
    expect(weekStartUtc(new Date('2026-10-18T18:00:00Z'), 330).toISOString()).toBe('2026-10-11T18:30:00.000Z');
  });

  it('a session starts with your first message and the next one after it ends starts fresh', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const at = (iso: string, tokens: number) => ({ at: new Date(iso), tokens });
    // 05:00 opens a session that ends 10:00; 10:30 opens the next one (ends 15:30).
    const s = activeSession([at('2026-10-20T05:00:00Z', 900), at('2026-10-20T09:00:00Z', 100), at('2026-10-20T10:30:00Z', 40), at('2026-10-20T11:00:00Z', 60)], 5, now);
    expect(s).toEqual({ startedAt: new Date('2026-10-20T10:30:00Z'), endsAt: new Date('2026-10-20T15:30:00Z'), used: 100 });
    expect(activeSession([at('2026-10-20T05:00:00Z', 900)], 5, now)).toBeNull(); // ended at 10:00
    expect(activeSession([], 5, now)).toBeNull();
  });

  it('reports the session, the week, and this week by product', async () => {
    events = [
      { created_at: ago(60), tokens: 100_000 },
      { created_at: ago(30), tokens: 50_000 },
    ];
    products = [
      { product: 'chats', tokens: 400_000 },
      { product: 'cowork', tokens: 150_000 },
      { product: 'code_review', tokens: 50_000 },
    ];
    const l = await planLimits('usr_1', 'pro');
    expect(l.planLabel).toBe('Solo');
    expect(l.session).toMatchObject({ used: 150_000, limit: 300_000, pct: 50, active: true });
    expect(Date.parse(l.session.resetsAt!) - Date.parse(l.session.startedAt!)).toBe(5 * 3_600_000);
    expect(l.weekly).toMatchObject({ used: 600_000, pct: 20 });
    // Monday 00:00 IST by default.
    expect(new Date(Date.parse(l.weekly.resetsAt!) + 330 * 60_000).toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(new Date(Date.parse(l.weekly.resetsAt!) + 330 * 60_000).getUTCDay()).toBe(1);
    expect(l.byProduct).toEqual({ chats: 400_000, cowork: 150_000, code_review: 50_000, api_other: 0 });
    expect(l.limited).toBe(false);
  });

  it('blocks new AI work once a window is full, saying when it resets', async () => {
    events = [{ created_at: ago(4 * 60), tokens: 300_000 }];
    products = [{ product: 'chats', tokens: 300_000 }];
    await expect(assertWithinPlanLimits('usr_1', 'pro')).rejects.toMatchObject({
      status: 429,
      errorCode: 'usage_limit_reached',
      message: expect.stringMatching(/Solo plan's 5-hour session usage limit\. It resets in (\d+ hr )?\d+ min/),
    });
  });

  it('with no messages yet the session has not started', async () => {
    paidPlan = 'team';
    await expect(assertWithinPlanLimits('usr_1', 'team')).resolves.toBeUndefined();
    const l = await planLimits('usr_1', 'team');
    expect(l.session).toMatchObject({ active: false, used: 0, resetsAt: null, startedAt: null });
    expect(l.forecast).toBe('on_track');
  });

  it('fails open when usage cannot be read (quota, not security)', async () => {
    fail = true;
    await expect(assertWithinPlanLimits('usr_1', 'pro')).resolves.toBeUndefined();
  });
});
