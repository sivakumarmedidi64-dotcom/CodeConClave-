/**
 * CodeConClave — PAYMENT LINK-POOL deployment configuration (POLICY B).
 *
 * Supplies the pool catalogue (pre-created STATIC Razorpay links) and the
 * runtime tuning knobs. Pool links are NOT created via the Razorpay API here;
 * they are provisioned out-of-band (dashboard/API) and their immutable
 * provider identifiers are listed below.
 *
 * RAZORPAY_REFERENCE_BEHAVIOR = UNVERIFIED  (no real production evidence in
 * repo; a place-holder reference_id scheme is used and MUST be reconciled
 * against the real provider before any live use over the static fallback).
 *
 * CONFIG MODEL
 *   The pool is deployment-configurable. Each link entry carries exactly:
 *     index, paymentUrl, referenceId, amount, currency, plan, callbackPath,
 *     paymentLinkId, enabled.
 *
 *   The `referenceId` must be globally unique and is the immutable correlation
 *   key that a Razorpay callback echoes back. `callbackPath` is the unique
 *   browser-redirect path for that link (used to disambiguate which link a
 *   callback came from without the API).
 *
 * POOL_SIZE default = 50. Links beyond the explicit catalogue use a generated,
 * clearly-unverified place-holder reference scheme (CCPOOL-<N>) so the pool can
 * start without fabricating real provider identifiers. Only links explicitly
 * present with real data are trusted end-to-end.
 */
import { env } from './env.js';

export interface PoolLinkConfig {
  index: number;
  paymentUrl: string;
  referenceId: string;
  amount: number;
  currency: string;
  plan: 'pro' | 'team' | 'api';
  callbackPath: string;
  paymentLinkId: string | null;
  enabled: boolean;
}

export interface PaymentPoolConfig {
  size: number;
  reservationTtlMinutes: number;
  links: PoolLinkConfig[];
  enabled: boolean;
  /**
   * True only when the catalogue comes from an explicit PAYMENT_POOL_LINKS
   * config (real provider links). Placeholder auto-generated links
   * (paymentUrl = API_URL/cb/N) are NOT payable and must never be handed to a
   * payer as the checkout URL.
   */
  explicit: boolean;
}

/** Amount in INR for each supported plan (authoritative, matches PLAN_PRICES_INR). */
const PLAN_AMOUNT_INR: Record<'pro' | 'team' | 'api', number> = { pro: 999, team: 4999, api: 9999 };

const DEFAULT_SIZE = 50;

function defaultReservationTtlMinutes(): number {
  return Number.isFinite(Number(env.PAYMENT_POOL_TTL_MINUTES)) && Number(env.PAYMENT_POOL_TTL_MINUTES) > 0
    ? Number(env.PAYMENT_POOL_TTL_MINUTES)
    : 15;
}

/**
 * Build the pool catalogue. Entries may be supplied via the optional
 * PAYMENT_POOL_LINKS env (JSON array of PoolLinkConfig) for deployment-time
 * configuration. When absent (or incomplete), a deterministic place-holder
 * catalogue is generated with UNVERIFIED reference ids — these are still
 * internally unique and safe for the correlation/tests, but MUST NOT be
 * treated as real provider links.
 */
export function paymentPoolConfig(): PaymentPoolConfig {
  const ttl = defaultReservationTtlMinutes();
  const configured = env.PAYMENT_POOL_LINKS ? parsePoolLinks(env.PAYMENT_POOL_LINKS) : [];

  const size = Math.max(DEFAULT_SIZE, configured.length);
  if (configured.length > 0) {
    return {
      size: Math.max(size, configured.length),
      reservationTtlMinutes: ttl,
      links: configured,
      enabled: true,
      explicit: true,
    };
  }

  // Place-holder catalogue (UNVERIFIED provider ids). Deterministic; each link
  // unique. reference id scheme CCPOOL-<NNN> (within Razorpay's 40-char cap).
  const links: PoolLinkConfig[] = [];
  for (let i = 1; i <= DEFAULT_SIZE; i += 1) {
    const plan: 'pro' | 'team' | 'api' = i % 7 === 0 ? 'api' : i % 3 === 0 ? 'team' : 'pro';
    links.push({
      index: i,
      paymentUrl: `${env.API_URL}/cb/${i}`,
      referenceId: `CCPOOL-${String(i).padStart(3, '0')}`,
      amount: PLAN_AMOUNT_INR[plan],
      currency: 'INR',
      plan,
      callbackPath: `/cb/${i}`,
      paymentLinkId: null,
      enabled: true,
    });
  }

  return { size, reservationTtlMinutes: ttl, links, enabled: true, explicit: false };
}

function parsePoolLinks(raw: string): PoolLinkConfig[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PoolLinkConfig[] = [];
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const index = Number(entry.index);
      const plan = entry.plan;
      if (!Number.isInteger(index) || index < 1) continue;
      if (plan !== 'pro' && plan !== 'team' && plan !== 'api') continue;
      // Per-link amount is RETAINED from configuration (never forcibly
      // overwritten): the seeder validates it against the authoritative plan
      // price and only seeds entries that can actually validate at callback.
      const amount =
        Number.isInteger(entry.amount) && Number(entry.amount) > 0 ? Number(entry.amount) : PLAN_AMOUNT_INR[plan];
      // Currency is retained verbatim (default 'INR'); non-INR entries are
      // detected and SKIPPED by the seeder — never silently converted.
      const currency = typeof entry.currency === 'string' && entry.currency.trim().length > 0
        ? entry.currency.trim().toUpperCase()
        : 'INR';
      // Whitespace normalization is explicit: all identifier/URL/path values are
      // trimmed here so every consumer (seeder, assign, callback routing) sees
      // exact values. Provider identifier formats are NOT constrained further —
      // validation is structural (non-empty, required fields present, URL parses)
      // and lives in the seeder/startup layer.
      const paymentUrl = String(entry.paymentUrl ?? '').trim();
      const callbackPath = String(entry.callbackPath ?? '').trim();
      const paymentLinkId = String(entry.paymentLinkId ?? '').trim();
      out.push({
        index,
        paymentUrl,
        // Empty reference id is preserved as empty so the seeder can reject it
        // structurally with a warning (never silently turn it into a placeholder).
        referenceId: String(entry.referenceId ?? '').trim(),
        amount,
        currency,
        plan,
        callbackPath,
        paymentLinkId: paymentLinkId.length > 0 ? paymentLinkId : null,
        enabled: entry.enabled !== false,
      });
    }
    return out;
  } catch {
    return [];
  }
}
