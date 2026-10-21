/**
 * CodeConClave — API Access prepaid credits.
 *
 * API Access is bought in ₹50,000 blocks. Every verified purchase grants its
 * amount as credits exactly once (keyed by the payment intent — a complimentary
 * entitlement with no purchase grants one block, keyed by the entitlement).
 * Every API call debits its real token cost at API_CREDIT_PAISE_PER_1K_TOKENS
 * (minimum API_CREDIT_MIN_PAISE_PER_CALL). At ₹0 the API refuses new calls
 * with 402 until the next ₹50,000 top-up. Amounts are integer paise; the
 * ledger is append-only and the balance row is updated in the same
 * transaction, so the two can never disagree.
 */
import { withSystem } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { PLAN_PRICES_INR } from '../payments/service.js';
import { logger } from '../../shared/logger.js';

export const API_TOPUP_INR = PLAN_PRICES_INR.api ?? 50_000;

/**
 * Spend alerts (Article 6 — borrowed from Replit's budgets/alerts and GitHub
 * Copilot's budgets): the owner is told when credits fall to ₹10,000 (20% of
 * a ₹50,000 block), ₹2,500 (5%) and ₹0. Each level fires once per downward
 * pass — a top-up starts a new pass.
 */
export const CREDIT_ALERT_LEVELS_PAISE = [API_TOPUP_INR * 100 * 0.2, API_TOPUP_INR * 100 * 0.05, 0].map((n) => Math.round(n));

/** Levels a debit crossed: the balance was above the level and is now at or below it. Pure. */
export function crossedAlertLevels(beforePaise: number, afterPaise: number, levels: number[] = CREDIT_ALERT_LEVELS_PAISE): number[] {
  return levels.filter((level) => beforePaise > level && afterPaise <= level);
}

/** Whole rupees, rounded DOWN so an alert never overstates what is left. */
function rupees(paise: number): string {
  return `₹${Math.max(0, Math.floor(paise / 100)).toLocaleString('en-IN')}`;
}

async function sendCreditAlert(ownerId: string, level: number, balancePaise: number): Promise<void> {
  const { notify } = await import('../notifications/service.js');
  const { NotificationType } = await import('@codeconclave/shared');
  const empty = level <= 0;
  await notify(
    ownerId,
    NotificationType.PAYMENT_STATUS,
    empty ? 'API credits used up' : `API credits: ${rupees(balancePaise)} left`,
    {
      body: empty
        ? `Your API credits reached ₹0, so new API calls are refused. Top up ₹${API_TOPUP_INR.toLocaleString('en-IN')} to continue.`
        : `Your API credits fell to ${rupees(balancePaise)}. Calls keep working until ₹0; top up ₹${API_TOPUP_INR.toLocaleString('en-IN')} any time.`,
      resourceType: 'api_credits',
      resourceId: ownerId,
      email: true,
      metadata: { levelPaise: level, balancePaise },
    },
  );
}

export interface CreditState {
  balancePaise: number;
  grantedPaise: number;
  spentPaise: number;
  calls: number;
  lastTopupAt: string | null;
  exhausted: boolean;
  topupInr: number;
  rate: { paisePer1kTokens: number; minPaisePerCall: number };
}

/** Cost of one call in paise (deterministic, shown to the customer). */
export function callCostPaise(tokens: number): number {
  const rate = env.API_CREDIT_PAISE_PER_1K_TOKENS;
  const min = env.API_CREDIT_MIN_PAISE_PER_CALL;
  return Math.max(min, Math.ceil((Math.max(0, tokens) / 1000) * rate));
}

type Q = { query: <T extends object = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }> };

async function grant(q: Q, ownerId: string, paise: number, ref: string, note: string): Promise<boolean> {
  const inserted = await q.query<{ id: string }>(
    `INSERT INTO api_credit_ledger (id, owner_id, kind, amount_paise, payment_ref, note)
     VALUES ($1,$2,'GRANT',$3,$4,$5)
     ON CONFLICT (payment_ref) WHERE payment_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [newId('acl'), ownerId, paise, ref, note],
  );
  if (!inserted.rows[0]) return false;
  await q.query(
    `INSERT INTO api_credit_balances (owner_id, balance_paise, granted_paise, last_topup_at)
     VALUES ($1, $2, $2, now())
     ON CONFLICT (owner_id) DO UPDATE SET balance_paise = api_credit_balances.balance_paise + EXCLUDED.balance_paise,
       granted_paise = api_credit_balances.granted_paise + EXCLUDED.granted_paise, last_topup_at = now(), updated_at = now()`,
    [ownerId, paise],
  );
  return true;
}

/** Issue credits for every verified API Access purchase not yet granted (idempotent). */
export async function ensureGrants(ownerId: string): Promise<number> {
  return withSystem(async (q) => {
    let granted = 0;
    const intents = (
      await q.query<{ id: string; amount_inr: number | string }>(
        `SELECT id, amount_inr FROM payment_intents WHERE owner_id = $1 AND plan_id = 'api' AND status IN ('ACTIVE','GRACE') ORDER BY created_at`,
        [ownerId],
      )
    ).rows;
    if (intents.length > 0) {
      for (const it of intents) {
        if (await grant(q, ownerId, Math.round(Number(it.amount_inr) * 100), `intent:${it.id}`, `API Access purchase (₹${Number(it.amount_inr).toLocaleString('en-IN')})`)) granted += 1;
      }
      return granted;
    }
    const ent = (
      await q.query<{ id: string }>(`SELECT id FROM entitlements WHERE user_id = $1 AND plan_id = 'api' AND state = 'PRO_VERIFIED' LIMIT 1`, [ownerId])
    ).rows[0];
    if (ent && (await grant(q, ownerId, API_TOPUP_INR * 100, `entitlement:${ent.id}`, 'API Access (complimentary or pre-credit grant)'))) granted += 1;
    return granted;
  });
}

export async function creditState(ownerId: string): Promise<CreditState> {
  await ensureGrants(ownerId);
  const row = await withSystem(async (q) =>
    (
      await q.query<{ balance_paise: string | number; granted_paise: string | number; spent_paise: string | number; calls: string | number; last_topup_at: Date | null }>(
        'SELECT balance_paise, granted_paise, spent_paise, calls, last_topup_at FROM api_credit_balances WHERE owner_id = $1',
        [ownerId],
      )
    ).rows[0],
  );
  const balance = Number(row?.balance_paise ?? 0);
  return {
    balancePaise: balance,
    grantedPaise: Number(row?.granted_paise ?? 0),
    spentPaise: Number(row?.spent_paise ?? 0),
    calls: Number(row?.calls ?? 0),
    lastTopupAt: row?.last_topup_at ? new Date(row.last_topup_at).toISOString() : null,
    exhausted: balance <= 0,
    topupInr: API_TOPUP_INR,
    rate: { paisePer1kTokens: env.API_CREDIT_PAISE_PER_1K_TOKENS, minPaisePerCall: env.API_CREDIT_MIN_PAISE_PER_CALL },
  };
}

/** Gate for the API rail: refuse new calls once credits are used up. */
export async function assertApiCredits(ownerId: string): Promise<CreditState> {
  const state = await creditState(ownerId);
  if (state.exhausted) {
    throw AppError.paymentRequired(
      'api_credits_exhausted',
      state.grantedPaise > 0
        ? `Your API credits are used up (₹${(state.grantedPaise / 100).toLocaleString('en-IN')} spent). Top up ₹${API_TOPUP_INR.toLocaleString('en-IN')} to keep calling the API.`
        : `No API credits yet. Buy API Access (₹${API_TOPUP_INR.toLocaleString('en-IN')}) to get credits.`,
    );
  }
  return state;
}

/** Debit one completed call. The balance may dip below 0 by one in-flight call; new calls are then refused. */
export async function debitApiCall(ownerId: string, tokens: number, apiKeyId: string | null, requestId: string): Promise<{ costPaise: number; balancePaise: number }> {
  const cost = callCostPaise(tokens);
  const result = await withSystem(async (q) => {
    await q.query(
      `INSERT INTO api_credit_ledger (id, owner_id, kind, amount_paise, tokens, api_key_id, request_id, note)
       VALUES ($1,$2,'DEBIT',$3,$4,$5,$6,'API call')`,
      [newId('acl'), ownerId, -cost, Math.max(0, Math.round(tokens)), apiKeyId, requestId],
    );
    const row = (
      await q.query<{ balance_paise: string | number }>(
        `INSERT INTO api_credit_balances (owner_id, balance_paise, spent_paise, calls)
         VALUES ($1, -$2::bigint, $2, 1)
         ON CONFLICT (owner_id) DO UPDATE SET balance_paise = api_credit_balances.balance_paise - $2::bigint,
           spent_paise = api_credit_balances.spent_paise + $2::bigint, calls = api_credit_balances.calls + 1, updated_at = now()
         RETURNING balance_paise`,
        [ownerId, cost],
      )
    ).rows[0];
    return { costPaise: cost, balancePaise: Number(row?.balance_paise ?? -cost) };
  });
  // Best-effort, after the debit committed: an alert failure never fails the call.
  for (const level of crossedAlertLevels(result.balancePaise + result.costPaise, result.balancePaise)) {
    await sendCreditAlert(ownerId, level, result.balancePaise).catch((err) =>
      logger.warn('credit alert not sent', { error: err instanceof Error ? err.message : String(err) }),
    );
  }
  return result;
}

export async function recentCreditEntries(ownerId: string, limit = 20): Promise<{ kind: string; amountPaise: number; tokens: number | null; note: string | null; createdAt: string }[]> {
  const rows = await withSystem(async (q) =>
    (
      await q.query<{ kind: string; amount_paise: string | number; tokens: number | null; note: string | null; created_at: Date }>(
        'SELECT kind, amount_paise, tokens, note, created_at FROM api_credit_ledger WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
        [ownerId, Math.min(Math.max(limit, 1), 100)],
      )
    ).rows,
  );
  return rows.map((r) => ({ kind: r.kind, amountPaise: Number(r.amount_paise), tokens: r.tokens, note: r.note, createdAt: new Date(r.created_at).toISOString() }));
}
