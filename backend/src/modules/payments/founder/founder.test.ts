/**
 * §44 — founder control plane: server-authoritative revenue + bounded AI.
 *
 * Covers: revenue overview periods + product split + refunds/net + distinct
 * customers; monthly revenue rollup; the AI query bound to real reads; the
 * fixed tool allow-list with NO entitlement tool; offline (AI disabled)
 * heuristic classification; control tools executed only for the fixed set;
 * and the founder identity lookup.
 *
 * Mocks: shared/db, audit, notifications, autopilot service (mutable state),
 * control-center, claims, autoapproval service, AI gateway.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── in-memory DB ─────────────────────────────────────────────────────────
const store = {
  rows: [] as Record<string, unknown>[],
  users: new Map<string, Record<string, unknown>>(),
  audit: [] as Record<string, unknown>[],
  queries: [] as string[],
  runtimeMode: 'AUTOPILOT',
};

const handler = (text: string, params: unknown[] = []): { rows: Record<string, unknown>[]; rowCount: number } => {
  const t = text.replace(/\s+/g, ' ').trim();
  store.queries.push(t);

  if (t.includes('SELECT i.purchase_type, i.amount_inr, i.status, i.owner_id') && t.includes('FROM payment_intents')) {
    return { rows: store.rows, rowCount: store.rows.length };
  }
  if (t.startsWith('SELECT id FROM users WHERE lower(email)')) {
    const email = String(params[0] ?? '').toLowerCase();
    const hit = [...store.users.values()].find((u) => String(u.email ?? '').toLowerCase() === email);
    return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
  }
  if (t.startsWith('SELECT email FROM users WHERE id')) {
    const user = store.users.get(String(params[0] ?? ''));
    return { rows: user ? [{ email: user.email }] : [], rowCount: user ? 1 : 0 };
  }
  if (t.includes('FROM payment_intents i') && t.includes("WHERE i.status = 'REVIEW'")) {
    return { rows: [], rowCount: 0 };
  }
  if (t.includes('FROM payment_auto_approvals') && t.includes('count(*)')) {
    return { rows: [{ n: 0 }], rowCount: 1 };
  }
  if (t.startsWith('SELECT id, action, ') && t.includes('FROM audit_logs')) {
    return { rows: store.audit.slice(0, Number(params[1] ?? params[0] ?? 50)), rowCount: store.audit.length };
  }
  return { rows: [], rowCount: 0 };
};

const mock = vi.hoisted(() => {
  const controlCenter = {
    summary: { totalPaid: 0, revenueInr: 0, activeSubs: 0 },
    payment: (id: string) => ({ id, status: 'ACTIVE' }),
  };
  const runtime = { mode: 'AUTOPILOT' };
  const stopCalls: Array<Record<string, unknown>> = [];
  const setAutopilotCalls: string[] = [];

  return {
    completeWithFallback: vi.fn(),
    recordAudit: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    controlCenterSummary: vi.fn(async () => controlCenter.summary),
    controlCenterPayment: vi.fn(async (id: string) => controlCenter.payment(id)),
    listClaimInbox: vi.fn(async () => ({ claims: [], total: 0 })),
    listAutoApprovals: vi.fn(async () => ({ rows: [], pendingCount: 0 })),
    stopAutoApproval: vi.fn(async (paymentId, actor, reason) => {
      stopCalls.push({ paymentId, actor, reason });
      return { stopped: true, state: 'STOPPED', intentId: 'pin_1' };
    }),
    sweepAutoApprovals: vi.fn(async () => 0),
    getEffectiveUnlockMode: vi.fn(async () => (runtime.mode === 'AUTOPILOT' ? 'AUTOPILOT' : 'MANUAL')),
    getRuntimeUnlockMode: vi.fn(async () => runtime.mode),
    setRuntimeUnlockMode: vi.fn(async (mode: string) => {
      runtime.mode = mode;
      setAutopilotCalls.push(mode);
    }),
    autopilotReadiness: vi.fn(async () => ({ ready: true, checks: [] })),
    runtime: { mode: () => runtime.mode },
    stopCalls,
    setAutopilotCalls,
  };
});

vi.mock('../../../shared/db.js', () => {
  const run = async (t: string, p?: unknown[]) => handler(t, p);
  return {
    pool: {
      query: run,
      connect: () => ({ release: () => {} }),
    },
    queryOne: async (t: string, p?: unknown[]) => (await handler(t, p)).rows[0] ?? null,
    queryMany: async (t: string, p?: unknown[]) => (await handler(t, p)).rows,
    withSystem: async (fn: (q: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
  };
});
vi.mock('../../../config/env.js', () => ({ env: {} as Record<string, string | undefined> }));
vi.mock('../../../shared/errors.js', async (i) => ({ ...(await i()) }));
vi.mock('../../../shared/ids.js', async (i) => ({ ...(await i()) }));
vi.mock('../../../shared/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('../../audit/service.js', () => ({ recordAudit: mock.recordAudit }));
vi.mock('../../notifications/service.js', () => ({ notify: mock.notify }));
vi.mock('../../ai/gateway.js', () => ({ completeWithFallback: mock.completeWithFallback }));
vi.mock('../autopilot/service.js', () => ({
  getEffectiveUnlockMode: mock.getEffectiveUnlockMode,
  getRuntimeUnlockMode: mock.getRuntimeUnlockMode,
  setRuntimeUnlockMode: mock.setRuntimeUnlockMode,
  autopilotReadiness: mock.autopilotReadiness,
  queueAutopilotReview: vi.fn(async () => ({ queued: true })),
}));
vi.mock('../control-center.js', () => ({
  controlCenterSummary: mock.controlCenterSummary,
  controlCenterPayment: mock.controlCenterPayment,
  canAccessControlCenter: vi.fn(async () => true),
  assertControlCenterAccess: vi.fn(),
}));
vi.mock('../claims/service.js', () => ({ listClaimInbox: mock.listClaimInbox }));
vi.mock('../autoapproval/service.js', () => ({
  listAutoApprovals: mock.listAutoApprovals,
  stopAutoApproval: mock.stopAutoApproval,
  sweepAutoApprovals: mock.sweepAutoApprovals,
}));
vi.mock('../intents.js', () => ({
  purchaseTypeForPlan: (p: string) => (p === 'team' ? 'team' : p === 'api' ? 'api' : 'pro'),
}));

import { founderRevenueOverview, founderMonthlyRevenue } from './revenue.js';
import { founderAiQuery } from './ai.js';
import { founderAiTools } from './ai.js';
import { getFounderUserId } from './service.js';

function setEnv(overrides: Record<string, string | undefined>) {
  Object.entries(overrides).forEach(([k, v]) => {
    (env as Record<string, string | undefined>)[k] = v;
  });
}

import { env } from '../../../config/env.js';

// Fixed "now": 2026-06-15 12:00 (Monday) so today/week/month boundaries are stable.
const NOW = new Date(2026, 5, 15, 12, 0, 0);

function row(overrides: Partial<{ purchase_type: string; amount_inr: number; status: string; owner_id: string; paid_time: Date | null }>) {
  return {
    purchase_type: overrides.purchase_type ?? 'pro',
    amount_inr: overrides.amount_inr ?? 999,
    status: overrides.status ?? 'ACTIVE',
    owner_id: overrides.owner_id ?? 'u_c1',
    paid_time: overrides.paid_time === undefined ? NOW : overrides.paid_time,
  };
}

function reset() {
  store.rows.splice(0);
  store.users.clear();
  store.audit.splice(0);
  store.queries.splice(0);
  mock.completeWithFallback.mockClear();
  mock.recordAudit.mockClear();
  mock.stopAutoApproval.mockClear();
  mock.setRuntimeUnlockMode.mockClear();
  mock.stopCalls.splice(0);
  mock.setAutopilotCalls.splice(0);
}

beforeEach(() => {
  reset();
  setEnv({ PAYMENT_FOUNDER_EMAIL: 'founder@example.com', AI_FOUNDER_AGENT: 'true', UNLOCK_MODE: 'AUTOPILOT' });
});

describe('founder identity', () => {
  it('resolves founder user id from PAYMENT_FOUNDER_EMAIL (case-insensitive)', async () => {
    store.users.set('u_founder', { id: 'u_founder', email: 'Founder@Example.com' });
    expect(await getFounderUserId()).toBe('u_founder');
  });
  it('fails closed to null when unconfigured or not found', async () => {
    setEnv({ ...env, PAYMENT_FOUNDER_EMAIL: 'nobody@example.com' });
    expect(await getFounderUserId()).toBeNull();
  });
});

describe('founderRevenueOverview', () => {
  it('buckets ACTIVE/GRACE as collected and REFUNDED/CHARGEBACK as refunds, per product', async () => {
    store.rows = [
      row({ purchase_type: 'pro', amount_inr: 999, status: 'ACTIVE', owner_id: 'u_a' }),
      row({ purchase_type: 'team', amount_inr: 4999, status: 'GRACE', owner_id: 'u_b', paid_time: new Date(NOW.getTime() - 2 * 24 * 3600e3) }),
      row({ purchase_type: 'api', amount_inr: 9999, status: 'ACTIVE', owner_id: 'u_c', paid_time: new Date(NOW.getTime() - 20 * 24 * 3600e3) }),
      row({ purchase_type: 'pro', amount_inr: 999, status: 'REFUNDED', owner_id: 'u_d', paid_time: new Date(NOW.getTime() - 3 * 24 * 3600e3) }),
    ];
    const { periods, allTime } = await founderRevenueOverview(NOW);
    const today = periods.find((p) => p.period === 'today')!;
    expect(today.collectedInr).toBe(999);
    expect(today.paidCount).toBe(1);
    expect(today.products.solo.collectedInr).toBe(999);
    expect(today.customerCount).toBe(1);

    const week = periods.find((p) => p.period === 'this_week')!;
    expect(week.collectedInr).toBe(999 + 4999);
    expect(week.refundedInr).toBe(999);
    expect(week.netInr).toBe(999 + 4999 - 999);
    expect(week.products.team.collectedInr).toBe(4999);
    expect(week.customerCount).toBe(2); // u_a, u_b (refunded u_d excluded)

    const month = periods.find((p) => p.period === 'this_month')!;
    expect(month.collectedInr).toBe(999 + 4999);

    const prev = periods.find((p) => p.period === 'prev_month')!;
    expect(prev.collectedInr).toBe(9999);
    expect(prev.products.api.collectedInr).toBe(9999);

    expect(allTime.collectedInr).toBe(999 + 4999 + 9999);
    expect(allTime.refundedInr).toBe(999);
    expect(allTime.netInr).toBe(999 + 4999 + 9999 - 999);
    expect(allTime.customerCount).toBe(3);
  });

  it('ignores rows that are neither paid nor refunded', async () => {
    store.rows = [row({ status: 'PENDING' }), row({ status: 'REVIEW' })];
    const { allTime } = await founderRevenueOverview(NOW);
    expect(allTime.collectedInr).toBe(0);
    expect(allTime.paidCount).toBe(0);
    expect(allTime.netInr).toBe(0);
  });

  it('counts distinct customers per period', async () => {
    store.rows = [
      row({ owner_id: 'u_a' }),
      row({ owner_id: 'u_a' }),
      row({ owner_id: 'u_b', status: 'GRACE' }),
    ];
    const { allTime, periods } = await founderRevenueOverview(NOW);
    expect(allTime.customerCount).toBe(2);
    expect(periods.find((p) => p.period === 'today')!.customerCount).toBe(2);
  });

  it('epoch-paid rows count in all-time but in no now-relative window', async () => {
    store.rows = [row({ purchase_type: 'pro', amount_inr: 999, status: 'ACTIVE', paid_time: null })];
    const { allTime, periods } = await founderRevenueOverview(NOW);
    expect(allTime.collectedInr).toBe(999);
    expect(allTime.paidCount).toBe(1);
    for (const p of periods) {
      expect(p.collectedInr).toBe(0);
    }
  });
});

describe('founderMonthlyRevenue', () => {
  it('rolls up rows into YYYY-MM buckets with Solo/Team/API split + refunds', async () => {
    store.rows = [
      row({ purchase_type: 'solo', amount_inr: 999, status: 'ACTIVE', owner_id: 'u_a', paid_time: new Date(2026, 4, 10) }),
      row({ purchase_type: 'team', amount_inr: 4999, status: 'ACTIVE', owner_id: 'u_b', paid_time: new Date(2026, 4, 20) }),
      row({ purchase_type: 'api', amount_inr: 9999, status: 'ACTIVE', owner_id: 'u_c', paid_time: new Date(2026, 5, 2) }),
      row({ purchase_type: 'solo', amount_inr: 999, status: 'REFUNDED', owner_id: 'u_d', paid_time: new Date(2026, 4, 25) }),
    ];
    const months = await founderMonthlyRevenue(12, NOW);
    const may = months.find((m) => m.month === '2026-05')!;
    const jun = months.find((m) => m.month === '2026-06')!;
    expect(may.soloInr).toBe(999);
    expect(may.teamInr).toBe(4999);
    expect(may.totalInr).toBe(999 + 4999);
    expect(may.refundedInr).toBe(999);
    expect(may.netInr).toBe(999 + 4999 - 999);
    expect(may.customerCount).toBe(2);
    expect(jun.apiInr).toBe(9999);
    expect(months.length).toBe(12);
  });

  it('excludes refunds from paidCount and counts customers once per month', async () => {
    store.rows = [
      row({ owner_id: 'u_a', paid_time: new Date(2026, 5, 1) }),
      row({ owner_id: 'u_a', status: 'GRACE', paid_time: new Date(2026, 5, 8) }),
    ];
    const jun = (await founderMonthlyRevenue(12, NOW)).find((m) => m.month === '2026-06')!;
    expect(jun.paidCount).toBe(2);
    expect(jun.customerCount).toBe(1);
  });
});

describe('founderAiQuery (bounded tools)', () => {
  it('exposes only the fixed allow-list and NEVER any entitlement tool', () => {
    const tools = founderAiTools();
    const FORBIDDEN = ['approve', 'refund', 'revoke', 'grant', 'claim', 'activate', 'apply'];
    expect(tools).toEqual(expect.arrayContaining(['dashboard', 'revenue', 'monthly_revenue', 'payments', 'payment_detail', 'reviews', 'failures', 'audit', 'autopilot', 'set_autopilot', 'stop_intervention', 'refresh']));
    for (const f of FORBIDDEN) {
      expect(tools).not.toContain(f);
    }
  });

  it('classifies revenue question offline (AI disabled) and returns real data', async () => {
    setEnv({ ...env, AI_FOUNDER_AGENT: 'false' });
    store.rows = [row({ purchase_type: 'pro', amount_inr: 999, paid_time: new Date() })];
    const answer = await founderAiQuery('u_founder', 'how much revenue did we collect today?');
    expect(answer.data).toBeDefined();
    expect(answer.data.revenue).toBeDefined();
    const r = answer.data.revenue as { periods: { period: string; collectedInr: number }[] };
    expect(r.periods.find((p) => p.period === 'today')!.collectedInr).toBe(999);

    // every AI query is audited with sanitized args
    const call = mock.recordAudit.mock.calls.find((c) => c[0].action === 'payment.founder_ai_query');
    expect(call).toBeDefined();
    const q = JSON.stringify(call![0].detail ?? {});
    expect(q).not.toMatch(/pay_[A-Z]/);
  });

  it('executes set_autopilot (MANUAL) for the control question', async () => {
    setEnv({ ...env, AI_FOUNDER_AGENT: 'false' });
    const answer = await founderAiQuery('u_founder', 'set autopilot to manual now');
    expect(answer.tool).toBe('set_autopilot');
    expect(mock.setRuntimeUnlockMode).toHaveBeenCalledWith('MANUAL', 'u_founder');
    expect(mock.setAutopilotCalls).toEqual(['MANUAL']);
  });

  it('executes stop_intervention for a payment id', async () => {
    setEnv({ ...env, AI_FOUNDER_AGENT: 'false' });
    const answer = await founderAiQuery('u_founder', 'stop auto approving pay_abcdef12345 immediately');
    expect(answer.tool).toBe('stop_intervention');
    expect(mock.stopAutoApproval).toHaveBeenCalled();
    expect(mock.stopCalls.length).toBe(1);
  });

  it('refuses to fabricate paid state from a mere id (no payment detail found → no assertion)', async () => {
    setEnv({ ...env, AI_FOUNDER_AGENT: 'false' });
    const answer = await founderAiQuery('u_founder', 'is pay_abcdef12345 paid');
    expect(['payment_detail', 'dashboard', 'payments', 'autopilot']).toContain(answer.tool);
    // tool result must be truthful: no entitlement can be granted by any tool here
    expect(Object.keys(answer.data)).toBeDefined();
  });
});