/**
 * CodeConClave â€” PRIVATE PAYMENT CONTROL CENTER (read-only, thin control plane).
 *
 * This is OBSERVABILITY ONLY. It READS the canonical payments subsystem
 * (payment_intents / payment_evidence / entitlements / users) and never writes
 * payment state. There is NO manual activation, NO force-active, NO approve
 * button, and NO administrative bypass: only the existing authoritative gate
 * (activation.applyDecision) may produce ACTIVE.
 *
 * Access gate: the configured founder (PAYMENT_FOUNDER_EMAIL) OR an account
 * with rbacRole owner/admin. Cross-tenant visibility is impossible by
 * construction because every query is scoped via the users table join for the
 * gate, and responses never include secrets (raw evidence payloads, tokens,
 * provider credentials) or non-required PII beyond the customer email/country
 * that the founder already controls.
 */
import { withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { isFounder } from './digest.js';
import type { AuthUser } from '../../middleware/context.js';

/**
 * P0-2: every read in this file is intentionally CROSS-TENANT. The control
 * center is a founder/admin observability surface, so a tenant-scoped
 * transaction would be wrong (it would hide other tenants' rows) and a bare
 * pool query would be accidentally un-scoped. These helpers make the system
 * scope explicit instead of implicit.
 */
async function sysMany<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withSystem((q) => q.query<T>(text, params)).then((r) => r.rows);
}

/** Founder dashboards are restricted to the configured founder + admin/owner roles. */
export async function canAccessControlCenter(user: AuthUser | null | undefined): Promise<boolean> {
  if (!user?.id) return false;
  if (user.rbacRole === 'owner' || user.rbacRole === 'admin') return true;
  return isFounder(user.id);
}

export async function assertControlCenterAccess(user: AuthUser | null | undefined): Promise<void> {
  if (user?.rbacRole === 'owner' || user?.rbacRole === 'admin') return;
  if (user && (await isFounder(user.id))) return;
  throw AppError.forbidden('founder_only', 'The payment control center is restricted to the configured founder');
}

// ---------------------------------------------------------------------------
// Row shapes (server-selected, secret-safe)
// ---------------------------------------------------------------------------

export interface ControlCenterPaymentRow {
  intentId: string;
  ownerId: string;
  email: string | null;
  country: string | null;
  plan: string;
  expectedAmount: number;
  detectedAmount: number | null;
  paymentId: string | null;
  paymentLinkId: string | null;
  referenceId: string | null;
  paymentMethod: string | null;
  paymentTimestamp: string | null;
  evidenceSource: string | null;
  correlationStatus: 'CORRELATED' | 'PARTIAL' | 'UNKNOWN';
  verificationStatus: 'ACTIVE' | 'REVIEW' | 'PENDING' | 'FAILED' | 'EXPIRED';
  entitlementStatus: 'ACTIVE' | 'PENDING' | 'NONE';
  status: string;
  fraudFlags: string[];
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ControlCenterSummary {
  day: string;
  totalIntents: number;
  proIntents: number;
  teamIntents: number;
  detectedPayments: number;
  verifiedPayments: number;
  activeEntitlements: number;
  pendingPayments: number;
  rejectedPayments: number;
  unknownPayments: number;
  verifiedRevenueInr: number;
}

export interface ControlCenterStats {
  intentsByStatus: Record<string, number>;
  intentsByPlan: Record<string, number>;
  evidenceBySource: Record<string, number>;
  byFraudFlag: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Queries (read-only)
// ---------------------------------------------------------------------------

const INTENT_SELECT = `
  SELECT
    i.id::text AS intentId,
    i.owner_id::text AS ownerId,
    u.email,
    i.plan_id AS plan,
    i.amount_inr AS expectedAmount,
    i.status,
    i.decision,
    i.fraud_flags,
    i.reference,
    i.payment_link,
    i.mode,
    i.provider_payment_link_id::text AS paymentLinkId,
    i.provider_reference_id::text AS referenceId,
    i.confidence,
    i.created_at,
    i.expires_at,
    i.activated_at,
    i.decision,
    e.detected_amount,
    e.provider_payment_id::text AS paymentId,
    e.payment_method AS paymentMethod,
    e.paid_at AS paymentTimestamp,
    e.source AS evidenceSource,
    ent.ent_state
  FROM payment_intents i
  LEFT JOIN users u ON u.id = i.owner_id
  LEFT JOIN LATERAL (
    SELECT d.amount_inr AS detected_amount, d.provider_payment_id, d.payment_method,
           d.paid_at, d.source
      FROM payment_evidence d
     WHERE d.intent_id = i.id
     ORDER BY d.created_at DESC
     LIMIT 1
  ) e ON true
  LEFT JOIN LATERAL (
    SELECT state AS ent_state
      FROM entitlements t
     WHERE t.user_id = i.owner_id AND t.plan_id = i.plan_id
     ORDER BY t.updated_at DESC
     LIMIT 1
  ) ent ON true
`;

export interface IntentQueryFilters {
  plan?: string;
  status?: string;
  correlation?: string;
  verification?: string;
  source?: string;
  from?: string;
  to?: string;
  customer?: string;
  paymentId?: string;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}

function reasonOf(
  status: string,
  decision: string | null,
  fraudFlags: string[] | null,
): string | null {
  if (fraudFlags && fraudFlags.length > 0) return `fraud_flags: ${fraudFlags.join(', ')}`;
  if (status === 'REVIEW') return 'awaiting review (no safe correlation)';
  if (status === 'PENDING') return decision === 'PENDING' ? 'no trusted evidence yet' : 'pending verification';
  if (status === 'EXPIRED') return 'intent expired';
  if (status === 'REFUNDED') return 'refunded';
  if (status === 'REVOKED') return 'revoked';
  if (status === 'CHARGEBACK') return 'chargeback';
  if (status === 'ACTIVE' || status === 'GRACE') return decision === 'ACTIVE' ? 'verified by evidence policy' : 'active (legacy)';
  return null;
}

function mapRow(r: Record<string, unknown>): ControlCenterPaymentRow {
  const status = String(r.status ?? 'PENDING');
  const decision = r.decision ? String(r.decision) : null;
  const fraud: string[] = Array.isArray(r.fraud_flags)
    ? (r.fraud_flags as unknown[]).map(String)
    : Array.isArray((r.fraud_flags as { value?: unknown })?.value)
      ? ((r.fraud_flags as { value: unknown[] }).value).map(String)
      : [];
  const detectedAmount =
    typeof r.detected_amount === 'number' ? (r.detected_amount as number)
    : typeof r.detected_amount === 'string' ? Number(r.detected_amount)
    : null;
  const entState = r.ent_state ? String(r.ent_state) : null;
  const entitlementStatus =
    entState === 'PRO_VERIFIED' ? 'ACTIVE'
    : entState ? 'PENDING'
    : 'NONE';
  const verificationStatus =
    status === 'ACTIVE' || status === 'GRACE' ? 'ACTIVE'
    : status === 'REVIEW' ? 'REVIEW'
    : status === 'EXPIRED' ? 'EXPIRED'
    : status === 'REFUNDED' || status === 'REVOKED' || status === 'CHARGEBACK' ? 'FAILED'
    : 'PENDING';
  const correlationStatus =
    decision === 'ACTIVE' ? 'CORRELATED'
    : (r.paymentId && status !== 'EXPIRED') ? 'PARTIAL'
    : 'UNKNOWN';

  return {
    intentId: String(r.intentId),
    ownerId: String(r.ownerId),
    email: r.email ? String(r.email) : null,
    country: null,
    plan: String(r.plan),
    expectedAmount: Number(r.expectedAmount ?? 0),
    detectedAmount,
    paymentId: r.paymentId ? String(r.paymentId) : null,
    paymentLinkId: r.paymentLinkId ? String(r.paymentLinkId) : null,
    referenceId: r.referenceId ? String(r.referenceId) : null,
    paymentMethod: r.paymentMethod ? String(r.paymentMethod) : null,
    paymentTimestamp: r.paymentTimestamp ? String(r.paymentTimestamp) : null,
    evidenceSource: r.evidenceSource ? String(r.evidenceSource) : null,
    correlationStatus,
    verificationStatus,
    entitlementStatus,
    status,
    fraudFlags: fraud,
    reason: reasonOf(status, decision, fraud),
    createdAt: String(r.created_at ?? ''),
    expiresAt: String(r.expires_at ?? ''),
  };
}

/** Summary for TODAY. Revenue counts VERIFIED (ACTIVE/GRACE) payments only. */
export async function controlCenterSummary(): Promise<ControlCenterSummary> {
  const rows = await sysMany<Record<string, unknown>>(INTENT_SELECT);
  const today = new Date().toISOString().slice(0, 10);
  const dayRows = rows.filter((r) => String(r.created_at ?? '').slice(0, 10) === today);

  const byStatus = (x: Record<string, unknown>) => String(x.status ?? 'PENDING');
  const verified = (x: Record<string, unknown>) => {
    const s = byStatus(x);
    return s === 'ACTIVE' || s === 'GRACE';
  };
  const rejected = (x: Record<string, unknown>) =>
    ['REFUNDED', 'REVOKED', 'CHARGEBACK', 'FAILED'].includes(byStatus(x));

  const summary: ControlCenterSummary = {
    day: today,
    totalIntents: dayRows.length,
    proIntents: dayRows.filter((r) => r.plan === 'pro').length,
    teamIntents: dayRows.filter((r) => r.plan === 'team').length,
    detectedPayments: dayRows.filter((r) => Boolean(r.paymentId)).length,
    verifiedPayments: dayRows.filter(verified).length,
    activeEntitlements: dayRows.filter((r) => String(r.ent_state ?? '') === 'PRO_VERIFIED').length,
    pendingPayments: dayRows.filter((r) => byStatus(r) === 'PENDING').length,
    rejectedPayments: dayRows.filter(rejected).length,
    unknownPayments: dayRows.filter((r) => !verified(r) && !rejected(r) && byStatus(r) !== 'PENDING').length,
    verifiedRevenueInr: dayRows.filter(verified).reduce((sum, r) => sum + Number(r.expectedAmount ?? 0), 0),
  };
  return summary;
}

/** Payments table with filters. */
export async function controlCenterPayments(filters: IntentQueryFilters, limit = 100): Promise<ControlCenterPaymentRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const lp = () => `$${params.length + 1}`;

  if (filters.plan === 'pro' || filters.plan === 'team') {
    where.push(`i.plan_id = ${lp()}`);
    params.push(filters.plan);
  }
  if (filters.status && /^[A-Z_]+$/.test(filters.status)) {
    where.push(`i.status = ${lp()}`);
    params.push(filters.status);
  }
  if (filters.source && /^[a-z_]+$/.test(filters.source)) {
    where.push(`e.source = ${lp()}`);
    params.push(filters.source);
  }
  if (filters.customer) {
    where.push(`(u.email ILIKE ${lp()} OR i.id::text = ${lp()})`);
    params.push(`%${filters.customer}%`, filters.customer);
  }
  if (filters.paymentId) {
    where.push(`e.provider_payment_id = ${lp()}`);
    params.push(filters.paymentId);
  }
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) {
    where.push(`i.created_at >= ${lp()}`);
    params.push(`${filters.from}T00:00:00Z`);
  }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
    where.push(`i.created_at < ${lp()}`);
    params.push(`${filters.to}T00:00:00Z`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `${INTENT_SELECT} ${whereSql} ORDER BY i.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`;
  const rows = await sysMany<Record<string, unknown>>(sql, params);
  return rows.map(mapRow);
}

/** Single payment + verification chain (intent â†’ evidence â†’ correlation â†’ verification â†’ entitlement). */
export async function controlCenterPayment(intentId: string): Promise<{
  payment: ControlCenterPaymentRow;
  evidence: Array<{
    id: string;
    source: string;
    providerPaymentId: string | null;
    amountInr: number | null;
    payerEmail: string | null;
    paidAt: string | null;
    createdAt: string;
    fraudFlags: string[];
  }>;
} | null> {
  const rows = await sysMany<Record<string, unknown>>(
    `${INTENT_SELECT} WHERE i.id = $1`,
    [intentId],
  );
  if (rows.length === 0) return null;
  const payment = mapRow(rows[0]!);

  const evidence = await sysMany<Record<string, unknown>>(
    `SELECT id::text AS id, source, provider_payment_id::text AS providerPaymentId,
            amount_inr AS amountInr, payer_email AS payerEmail, paid_at AS paidAt,
            created_at AS createdAt, fraud_flags AS fraudFlags
       FROM payment_evidence
      WHERE intent_id = $1
      ORDER BY created_at ASC`,
    [intentId],
  );
  return {
    payment,
    evidence: evidence.map((e) => ({
      id: String(e.id),
      source: String(e.source ?? ''),
      providerPaymentId: e.providerPaymentId ? String(e.providerPaymentId) : null,
      amountInr: typeof e.amountInr === 'number' ? e.amountInr : null,
      payerEmail: e.payerEmail ? String(e.payerEmail) : null,
      paidAt: e.paidAt ? String(e.paidAt) : null,
      createdAt: String(e.createdAt ?? ''),
      fraudFlags: Array.isArray(e.fraudFlags)
        ? (e.fraudFlags as unknown[]).map(String)
        : Array.isArray((e.fraudFlags as { value?: unknown })?.value)
          ? ((e.fraudFlags as { value: unknown[] }).value).map(String)
          : [],
    })),
  };
}

/** Aggregate stats over all time (safe, founder-only). */
export async function controlCenterStats(): Promise<ControlCenterStats> {
  const byStatus = await sysMany<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM payment_intents GROUP BY status`,
  );
  const byPlan = await sysMany<{ plan_id: string; n: number }>(
    `SELECT plan_id, count(*)::int AS n FROM payment_intents GROUP BY plan_id`,
  );
  const bySource = await sysMany<{ source: string; n: number }>(
    `SELECT source, count(*)::int AS n FROM payment_evidence GROUP BY source`,
  );
  const byFlag = await sysMany<{ flag: string; n: number }>(
    `SELECT jsonb_array_elements_text(fraud_flags::jsonb) AS flag, count(*)::int AS n
       FROM payment_evidence
      WHERE fraud_flags IS NOT NULL AND jsonb_array_length(fraud_flags::jsonb) > 0
      GROUP BY flag`,
  );
  return {
    intentsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    intentsByPlan: Object.fromEntries(byPlan.map((r) => [r.plan_id, r.n])),
    evidenceBySource: Object.fromEntries(bySource.map((r) => [r.source, r.n])),
    byFraudFlag: Object.fromEntries(byFlag.map((r) => [r.flag, r.n])),
  };
}

// ---------------------------------------------------------------------------
// Payment Link-Pool overview (READ-ONLY observability, phase 16).
// NO manual activate / grant controls. Reports pool health truthfully.
// ---------------------------------------------------------------------------

export interface PoolOverview {
  poolSize: number;
  activeLinks: number;
  reservedLinks: number;
  fulfilledLinks: number;
  expiredReservations: number;
  fulfilledIntents: number;
  ambiguousCallbacks: number;
  orphanedCallbacks: number;
  failedSignatures: number;
  replayAttempts: number;
  lastCallbackAt: string | null;
  reservationsByStatus: Record<string, number>;
}

export async function controlCenterPool(): Promise<PoolOverview> {
  // P0-2: all 12 counters read inside ONE system transaction. Running them as
  // independent system-scoped queries would pin 12 pool connections at once
  // (the pool max is 10) and give an inconsistent snapshot across counters.
  const { total, active, reserved, fulfilled, expired, fulfilledIntents, ambiguous, orphaned, failedSig, replay, last, byStatus } =
    await withSystem(async (q) => {
      const [
        totalRows,
        activeRows,
        reservedRows,
        fulfilledRows,
        expiredRows,
        fulfilledIntentRows,
        ambiguousRows,
        orphanedRows,
        failedSigRows,
        replayRows,
        lastRows,
        byStatusRows,
      ] = await Promise.all([
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_link_pool'),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_link_pool WHERE is_active = true'),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_link_reservations WHERE status = \'RESERVED\''),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_link_reservations WHERE status = \'FULFILLED\''),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_link_reservations WHERE status = \'EXPIRED\''),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_intents WHERE reservation_status = \'FULFILLED\''),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_pool_callbacks WHERE outcome IN (\'ambiguous\',\'intent_plan_mismatch\',\'reservation_expired\')'),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_pool_callbacks WHERE outcome = \'orphaned\''),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_pool_callbacks WHERE outcome = \'invalid_signature\''),
        q.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_pool_callbacks WHERE outcome = \'duplicate\''),
        q.query<{ created_at: Date }>('SELECT created_at FROM payment_pool_callbacks ORDER BY created_at DESC LIMIT 1'),
        q.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM payment_link_reservations GROUP BY status`,
        ),
      ]);
      return {
        total: totalRows.rows,
        active: activeRows.rows,
        reserved: reservedRows.rows,
        fulfilled: fulfilledRows.rows,
        expired: expiredRows.rows,
        fulfilledIntents: fulfilledIntentRows.rows,
        ambiguous: ambiguousRows.rows,
        orphaned: orphanedRows.rows,
        failedSig: failedSigRows.rows,
        replay: replayRows.rows,
        last: lastRows.rows,
        byStatus: byStatusRows.rows,
      };
    });
  return {
    poolSize: total[0]?.n ?? 0,
    activeLinks: active[0]?.n ?? 0,
    reservedLinks: reserved[0]?.n ?? 0,
    fulfilledLinks: fulfilled[0]?.n ?? 0,
    expiredReservations: expired[0]?.n ?? 0,
    fulfilledIntents: fulfilledIntents[0]?.n ?? 0,
    ambiguousCallbacks: ambiguous[0]?.n ?? 0,
    orphanedCallbacks: orphaned[0]?.n ?? 0,
    failedSignatures: failedSig[0]?.n ?? 0,
    replayAttempts: replay[0]?.n ?? 0,
    lastCallbackAt: last[0]?.created_at ? last[0].created_at.toISOString() : null,
    reservationsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
  };
}