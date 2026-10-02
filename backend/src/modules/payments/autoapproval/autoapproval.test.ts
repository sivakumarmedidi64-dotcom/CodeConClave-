/**
 * §44 — payment_auto_approvals intervention window tests.
 *
 * Covers: request → pending, duplicate idempotent, invalid payment fail-closed,
 * STOP → STOPPED + intent REVIEW + queueAutopilotReview, STOP idempotent,
 * STOP cannot rollback AUTO_APPROVED, sweep approvals (ACTIVE path),
 * sweep rejects non-ACTIVE / throws → REVIEW + founder review, and
 * exactly-once sweep (second sweep is no-op).
 *
 * Mocks: shared/db, audit, notifications, pipeline.ingestEvidence,
 * autopilot.queueAutopilotReview, founder.notifyFounder, intents.purchaseTypeForPlan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── in-memory DB stores ─────────────────────────────────────────────────
const store = {
  approvals: [] as Record<string, unknown>[],
  intents: new Map<string, Record<string, unknown>>(),
  users: new Map<string, Record<string, unknown>>(),
  queries: [] as string[],
};

const handler = (text: string, params: unknown[] = []): { rows: Record<string, unknown>[]; rowCount: number } => {
  const t = text.replace(/\s+/g, ' ').trim();
  store.queries.push(t);

  // requestAutoApproval insert (params: rowid, intent_id, payment_id, plan, type, amt, email, owner, payload, tenant)
  if (t.startsWith('INSERT INTO payment_auto_approvals') && t.includes('ON CONFLICT (payment_id)')) {
    const paymentId = String(params[2] ?? '');
    const existing = store.approvals.find((a) => a.payment_id === paymentId);
    if (existing) {
      return { rows: [{ id: existing.id, state: existing.state }], rowCount: 0 };
    }
    const row: Record<string, unknown> = {
      id: String(params[0]),
      intent_id: params[1],
      payment_id: paymentId,
      plan_id: params[3],
      purchase_type: params[4],
      amount_inr: params[5],
      payer_email: params[6],
      owner_id: params[7],
      payload: JSON.parse(String(params[8] ?? '{}')),
      state: 'PENDING_APPROVAL',
      created_at: new Date(),
      approved_at: null,
      stopped_at: null,
    };
    store.approvals.push(row);
    return { rows: [{ id: row.id, state: 'PENDING_APPROVAL' }], rowCount: 1 };
  }

  // pure state lookup
  if (t === 'SELECT state FROM payment_auto_approvals WHERE payment_id = $1') {
    const paymentId = String(params[0] ?? '');
    const row = store.approvals.find((a) => a.payment_id === paymentId);
    if (!row) return { rows: [], rowCount: 0 };
    return { rows: [{ state: row.state }], rowCount: 1 };
  }

  // stopAutoApproval UPDATE (params: payment_id, actor, reason)
  if (t.startsWith("UPDATE payment_auto_approvals SET state = 'STOPPED'")) {
    const paymentId = String(params[0] ?? '');
    const row = store.approvals.find((a) => a.payment_id === paymentId);
    if (!row || row.state !== 'PENDING_APPROVAL') return { rows: [], rowCount: 0 };
    row.state = 'STOPPED';
    row.stopped_at = new Date();
    row.decided_by = params[1] ?? null;
    row.stop_reason = params[2] ?? null;
    return { rows: [{ id: row.id, intent_id: row.intent_id, owner_id: row.owner_id, plan_id: row.plan_id, amount_inr: row.amount_inr }], rowCount: 1 };
  }

  // sweep candidate select (params: cutoff, limit)
  if (t.includes('WHERE state') && t.includes("'PENDING_APPROVAL'") && t.includes('created_at <= ') && t.includes('ORDER BY created_at ASC')) {
    const cutoff = new Date(String(params[0] ?? '')).getTime();
    const limit = Number(params[1] ?? 100);
    const rows = store.approvals
      .filter((a) => a.state === 'PENDING_APPROVAL' && new Date(String(a.created_at)).getTime() <= cutoff)
      .slice(0, limit);
    return { rows, rowCount: rows.length };
  }

  // sweep claim (params: id) — exactly-once
  if (t.startsWith("UPDATE payment_auto_approvals SET state = 'AUTO_APPROVED'")) {
    const id = String(params[0] ?? '');
    const row = store.approvals.find((a) => a.id === id);
    if (!row || row.state !== 'PENDING_APPROVAL') return { rows: [], rowCount: 0 };
    row.state = 'AUTO_APPROVED';
    row.approved_at = new Date();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // intent status update (params: intent_id; status is a SQL literal)
  if (t.startsWith('UPDATE payment_intents SET status')) {
    const intentId = String(params[0] ?? '');
    const intent = store.intents.get(intentId);
    if (!intent) return { rows: [], rowCount: 0 };
    intent.status = t.includes("status = 'REVIEW'") ? 'REVIEW' : intent.status;
    return { rows: [{ id: intentId }], rowCount: 1 };
  }

  // intent status query (pre-check in sweepAutoApprovals, FIX 2)
  if (t.startsWith('SELECT status FROM payment_intents WHERE id = $1')) {
    const intentId = String(params[0] ?? '');
    const intent = store.intents.get(intentId);
    return { rows: intent ? [{ status: intent.status }] : [], rowCount: intent ? 1 : 0 };
  }

  // owner email lookup
  if (t.startsWith('SELECT email FROM users WHERE id')) {
    const userId = String(params[0] ?? '');
    const user = store.users.get(userId);
    return { rows: user ? [{ email: user.email }] : [], rowCount: user ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
};

const mock = vi.hoisted(() => ({
  ingestEvidence: vi.fn(async () => ({
    evidence: [{ id: 'pev_mock' }],
    matched: 1,
    replayed: 0,
    result: { confidence: 0.95, decision: 'APPROVE', flags: [] as string[], intentStatus: 'ACTIVE' as string },
  })),
  queueAutopilotReview: vi.fn(async () => ({ queued: true })),
  notifyFounder: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
  purchaseTypeForPlan: vi.fn((plan: string) => (plan === 'team' ? 'team' : plan === 'api' ? 'api' : 'pro')),
}));

vi.mock('../../../shared/db.js', () => ({
  pool: { query: async (t: string, p?: unknown[]) => handler(t, p) },
  queryOne: async (t: string, p?: unknown[]) => (await handler(t, p)).rows[0] ?? null,
  queryMany: async (t: string, p?: unknown[]) => (await handler(t, p)).rows,
  withTenant: async (_userId: string | null, fn: (c: { query: typeof handler }) => Promise<unknown>) => fn({ query: handler }),
  withSystem: async (fn: (c: { query: typeof handler }) => Promise<unknown>) => fn({ query: handler }),
}));
vi.mock('../../../config/env.js', () => ({ env: { PAYMENT_AUTO_APPROVAL_MS: '2000' } as Record<string, string | undefined> }));
vi.mock('../../../shared/errors.js', async (i) => ({ ...(await i()) }));
vi.mock('../../../shared/ids.js', async (i) => ({ ...(await i()) }));
vi.mock('../../../shared/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('../../audit/service.js', () => ({ recordAudit: mock.recordAudit }));
vi.mock('../../notifications/service.js', () => ({ notify: async () => {} }));
vi.mock('../pipeline.js', () => ({ ingestEvidence: mock.ingestEvidence }));
vi.mock('../autopilot/service.js', () => ({ queueAutopilotReview: mock.queueAutopilotReview }));
vi.mock('../founder/service.js', () => ({ notifyFounder: mock.notifyFounder }));
vi.mock('../intents.js', () => ({ purchaseTypeForPlan: mock.purchaseTypeForPlan }));

import { requestAutoApproval, stopAutoApproval, sweepAutoApprovals } from './service.js';
import { queueAutopilotReview } from '../autopilot/service.js';

// ── helpers ──────────────────────────────────────────────────────────────
function reset() {
  store.approvals.splice(0);
  store.intents.clear();
  store.users.clear();
  store.queries.splice(0);
  mock.ingestEvidence.mockClear();
  mock.queueAutopilotReview.mockClear();
  mock.notifyFounder.mockClear();
  mock.recordAudit.mockClear();
}

function seedIntent(id: string, owner = 'u_alice', plan = 'pro') {
  store.intents.set(id, {
    id, owner_id: owner, plan_id: plan, amount_inr: plan === 'team' ? 4999 : plan === 'api' ? 9999 : 999, status: 'PENDING', created_at: new Date(),
  });
}

function seedUser(id: string, email = 'alice@example.com') {
  store.users.set(id, { id, email });
}

const PAYLOAD = { paymentId: 'pay_testing_12345', amountInr: 999, payerEmail: 'payer@test.com', paidAt: '2026-01-01T00:00:00Z' };

function req(intentId: string, plan = 'pro') {
  return requestAutoApproval({
    intent: { id: intentId, owner_id: 'u_alice', plan_id: plan, amount_inr: plan === 'team' ? 4999 : plan === 'api' ? 9999 : 999 },
    signal: PAYLOAD,
  });
}

function expire(intentId: string) {
  const row = store.approvals.find((a) => a.intent_id === intentId)!;
  row.created_at = new Date(Date.now() - 5000);
}

beforeEach(reset);

// ── requestAutoApproval ──────────────────────────────────────────────────
describe('requestAutoApproval', () => {
  it('inserts a pending row and notifies founder', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    const outcome = await req('pin_1');
    expect(outcome).toEqual({ planned: 'PENDING' });
    const row = store.approvals.find((a) => a.intent_id === 'pin_1');
    expect(row).toBeDefined();
    expect(row!.state).toBe('PENDING_APPROVAL');
    expect(row!.purchase_type).toBe('pro');
    expect(mock.notifyFounder).toHaveBeenCalledWith(expect.anything(), 'Auto-approval in 2 seconds — [STOP] to review', expect.anything());
    expect(mock.recordAudit.mock.calls.find((c) => c[0].action === 'payment.auto_approval_scheduled')).toBeDefined();
  });

  it('returns REVIEW_QUEUED (fail-closed) for invalid payment id', async () => {
    seedIntent('pin_2');
    seedUser('u_alice');
    const outcome = await requestAutoApproval({
      intent: { id: 'pin_2', owner_id: 'u_alice', plan_id: 'pro', amount_inr: 999 },
      signal: { paymentId: 'not-a-pay-id', amountInr: 999, payerEmail: 'payer@test.com', paidAt: '2026-01-01' },
    });
    expect(outcome).toMatchObject({ planned: 'REVIEW_QUEUED', reason: 'invalid_payment_id' });
    expect(store.approvals.length).toBe(0);
    expect(mock.queueAutopilotReview).toHaveBeenCalled();
  });

  it('returns ALREADY_PENDING when duplicate payment_id exists', async () => {
    seedIntent('pin_1');
    seedIntent('pin_2');
    seedUser('u_alice');
    await req('pin_1');
    const outcome = await req('pin_2');
    expect(outcome).toMatchObject({ planned: 'ALREADY_PENDING' });
    expect(store.approvals.length).toBe(1);
  });

  it('returns ALREADY_APPROVED when payment already approved', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    store.approvals.push({
      id: 'paa_existing', intent_id: 'pin_old', payment_id: PAYLOAD.paymentId,
      plan_id: 'pro', purchase_type: 'pro', amount_inr: 999, payer_email: 'payer@test.com',
      owner_id: 'u_alice', payload: {}, state: 'AUTO_APPROVED', created_at: new Date(),
    });
    const outcome = await req('pin_1');
    expect(outcome).toMatchObject({ planned: 'ALREADY_APPROVED' });
  });
});

// ── stopAutoApproval ─────────────────────────────────────────────────────
describe('stopAutoApproval', () => {
  it('transitions PENDING → STOPPED, pushes intent to REVIEW, queues founder review', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    const result = await stopAutoApproval(PAYLOAD.paymentId, 'u_founder', 'manual_review');
    expect(result.stopped).toBe(true);
    expect(result.state).toBe('STOPPED');
    expect(result.intentId).toBe('pin_1');
    expect(store.approvals.find((a) => a.payment_id === PAYLOAD.paymentId)!.state).toBe('STOPPED');
    expect(mock.queueAutopilotReview).toHaveBeenCalled();
    expect(store.intents.get('pin_1')!.status).toBe('REVIEW');
    expect(mock.notifyFounder).toHaveBeenCalled();
    expect(mock.recordAudit.mock.calls.find((c) => c[0].action === 'payment.auto_approval_stopped')).toBeDefined();
  });

  it('is idempotent: second call returns already_stopped and records nothing', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    await stopAutoApproval(PAYLOAD.paymentId, 'u_founder', 'first');
    mock.recordAudit.mockClear();
    const second = await stopAutoApproval(PAYLOAD.paymentId, 'u_founder', 'second');
    expect(second.stopped).toBe(false);
    expect(second.state).toBe('STOPPED');
    expect(second.reason).toBe('already_stopped');
    expect(mock.recordAudit).not.toHaveBeenCalled();
  });

  it('cannot roll back AUTO_APPROVED', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    store.approvals.push({
      id: 'paa_approved', intent_id: 'pin_1', payment_id: PAYLOAD.paymentId,
      plan_id: 'pro', purchase_type: 'pro', amount_inr: 999, payer_email: 'payer@test.com',
      owner_id: 'u_alice', payload: {}, state: 'AUTO_APPROVED', created_at: new Date(),
    });
    const result = await stopAutoApproval(PAYLOAD.paymentId, 'u_founder', 'too late');
    expect(result.stopped).toBe(false);
    expect(result.state).toBe('AUTO_APPROVED');
    expect(result.reason).toBe('already_approved');
    expect(mock.queueAutopilotReview).not.toHaveBeenCalled();
  });

  it('returns not_found when no record exists', async () => {
    const result = await stopAutoApproval('pay_nonexistent', 'u_founder', 'oops');
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});

// ── sweepAutoApprovals ───────────────────────────────────────────────────
describe('sweepAutoApprovals', () => {
  it('auto-approves expired pending intent via ingestEvidence → ACTIVE', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    expire('pin_1');

    const n = await sweepAutoApprovals({ limit: 10 });
    expect(n).toBe(1);
    expect(store.approvals.find((a) => a.intent_id === 'pin_1')!.state).toBe('AUTO_APPROVED');
    expect(mock.ingestEvidence).toHaveBeenCalledWith('u_alice', 'pin_1', 'razorpay_autopilot', expect.objectContaining({ paymentId: PAYLOAD.paymentId }));
    expect(mock.notifyFounder).toHaveBeenCalledWith(expect.anything(), 'Payment auto-approved', expect.anything());
    expect(mock.recordAudit.mock.calls.find((c) => c[0].action === 'payment.autopilot_activated')).toBeDefined();
  });

  it('skips rows not yet expired (within the 2s window)', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    const n = await sweepAutoApprovals({ limit: 10 });
    expect(n).toBe(0);
    expect(store.approvals.find((a) => a.intent_id === 'pin_1')!.state).toBe('PENDING_APPROVAL');
  });

  it('exactly-once: second sweep over same row is a no-op', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    expire('pin_1');

    await sweepAutoApprovals({ limit: 10 });
    expect(mock.ingestEvidence).toHaveBeenCalledTimes(1);
    mock.ingestEvidence.mockClear();

    const second = await sweepAutoApprovals({ limit: 10 });
    expect(second).toBe(0);
    expect(mock.ingestEvidence).not.toHaveBeenCalled();
  });

  it('non-ACTIVE intent result → intent REVIEW + founder review (row still claimed, never reprocessed)', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    expire('pin_1');

    mock.ingestEvidence.mockResolvedValueOnce({
      evidence: [{ id: 'pev_r' }],
      matched: 1,
      replayed: 0,
      result: { confidence: 0.5, decision: 'REVIEW', flags: ['amount_mismatch'], intentStatus: 'REVIEW' },
    });
    const n = await sweepAutoApprovals({ limit: 10 });
    expect(n).toBe(1);
    expect(store.approvals.find((a) => a.intent_id === 'pin_1')!.state).toBe('AUTO_APPROVED');
    expect(store.intents.get('pin_1')!.status).toBe('REVIEW');
    expect(mock.queueAutopilotReview).toHaveBeenCalled();
    expect(mock.recordAudit.mock.calls.find((c) => c[0].action === 'payment.auto_approval_review_required')).toBeDefined();
  });

  it('ingestEvidence throws → intent REVIEW + auto_approval_failed audit', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    expire('pin_1');

    mock.ingestEvidence.mockRejectedValueOnce(new Error('DB connection refused'));
    const n = await sweepAutoApprovals({ limit: 10 });
    expect(n).toBe(1);
    expect(mock.recordAudit.mock.calls.find((c) => c[0].action === 'payment.auto_approval_failed')).toBeDefined();
    expect(store.intents.get('pin_1')!.status).toBe('REVIEW');
  });

  it('STOPPED rows are ignored by the sweep', async () => {
    seedIntent('pin_1');
    seedUser('u_alice');
    await req('pin_1');
    expire('pin_1');
    await stopAutoApproval(PAYLOAD.paymentId, 'u_founder', 'nope');
    mock.ingestEvidence.mockClear();

    const n = await sweepAutoApprovals({ limit: 10 });
    expect(n).toBe(0);
    expect(mock.ingestEvidence).not.toHaveBeenCalled();
  });

  it('claims batch up to limit', async () => {
    seedUser('u_alice');
    for (let i = 0; i < 3; i++) {
      seedIntent(`pin_${i}`);
      mock.purchaseTypeForPlan.mockResolvedValueOnce('pro');
      await requestAutoApproval({
        intent: { id: `pin_${i}`, owner_id: 'u_alice', plan_id: 'pro', amount_inr: 999 },
        signal: { ...PAYLOAD, paymentId: `pay_batch_000${i}` },
      });
      expire(`pin_${i}`);
    }
    const n = await sweepAutoApprovals({ limit: 2 });
    expect(n).toBe(2);
    const remaining = store.approvals.filter((a) => a.state === 'PENDING_APPROVAL');
    expect(remaining.length).toBe(1);
  });
});