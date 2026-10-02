/**
 * CodeConClave — PAYMENT LINK-POOL seeder (POLICY B).
 *
 * Provisioning: the `payment_link_pool` table is the DB-backed pool catalogue
 * that reservation/assign/callback reads from. This module is the ONLY writer
 * that populates it from the deployment configuration (`PAYMENT_POOL_LINKS`
 * via `paymentPoolConfig()`). Without it a fresh DB has an empty pool and every
 * checkout 503s with ALL_LINKS_BUSY_TRY_AGAIN.
 *
 * Semantics (all idempotent, converge-to-config, fail-closed):
 *   - Upsert by immutable `link_index`; rerunning never duplicates rows.
 *   - INR-only launch: non-INR catalogue entries are SKIPPED with a warning and
 *     never silently converted to INR.
 *   - Amount binding: a seeded link's amount must equal the server-authoritative
 *     plan price (`PLAN_PRICES_INR`), otherwise every callback for that link
 *     would fail `amount_mismatch`; such an entry is SKIPPED with a warning.
 *   - RESERVED reservation preservation: a link_index that currently has a live
 *     RESERVED reservation is left untouched so an in-flight checkout's link
 *     identity never mutates mid-session (reference binding stays immutable).
 *   - Never writes to reservations, intents, entitlements, or callbacks.
*  - Startup self-check: loud failure when explicit configuration is present
 *     but seeding yields zero usable links. Intentional all-disabled
 *     configuration warns instead of failing.
 *  - Real-link format tolerance: validation is STRUCTURAL only. We require a
 *     non-empty reference id, a parseable http(s) URL (HTTPS mandatory for real
 *     provider links), a non-empty callback path, an INR currency and a
 *     positive amount equal to the authoritative plan price. We deliberately do
 *     NOT impose any length/charset/prefix/format assumption on provider
 *     identifiers (Razorpay ids vary). Whitespace around configured values is
 *     normalized (trimmed) explicitly before anything is stored.
 *  - Placeholder warning: a reference id matching the CCPOOL-* scheme marks an
 *     entry as an unverified dev/test placeholder. Such entries still seed (so
 *     development and testing are never blocked) but the startup check emits a
 *     non-failing PLACEHOLDER warning that real payment links are not
 *     configured. This warning is NOT a seeding failure.
 */
import { withSystem } from '../../../shared/db.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../shared/logger.js';
import { paymentPoolConfig, type PoolLinkConfig } from '../../../config/payment-pool.js';
import { PLAN_PRICES_INR } from '../service.js';

/** Placeholder reference scheme (dev/test catalogue). NEVER a real provider id. */
export const PLACEHOLDER_REF_PREFIX = 'CCPOOL-';

export function isPlaceholderReferenceId(referenceId: string): boolean {
  return referenceId.startsWith(PLACEHOLDER_REF_PREFIX);
}

export interface PoolSeedReport {
  configured: number;
  seeded: number;
  updated: number;
  unchanged: number;
  skipped: number;
  intentionallyDisabled: number;
  active: number;
  total: number;
  warnings: string[];
}

interface PoolRowLike {
  link_index: number;
  payment_link_id: string | null;
  razorpay_url: string;
  reference_id: string;
  amount: number;
  currency: string;
  plan: 'pro' | 'team' | 'api';
  callback_path: string;
  is_active: boolean;
  /** SPEC §24: tombstones a fulfilled link as permanently non-allocatable. */
  consumed_at: Date | null;
}

function entryRow(cfg: PoolLinkConfig): PoolRowLike {
  return {
    link_index: cfg.index,
    payment_link_id: cfg.paymentLinkId,
    razorpay_url: cfg.paymentUrl,
    reference_id: cfg.referenceId,
    amount: cfg.amount,
    currency: 'INR',
    plan: cfg.plan,
    callback_path: cfg.callbackPath,
    is_active: cfg.enabled !== false,
    consumed_at: null,
  };
}

function rowsEqual(a: PoolRowLike, b: PoolRowLike | undefined): boolean {
  if (!b) return false;
  return (
    a.payment_link_id === b.payment_link_id &&
    a.razorpay_url === b.razorpay_url &&
    a.reference_id === b.reference_id &&
    a.amount === b.amount &&
    a.currency === b.currency &&
    a.plan === b.plan &&
    a.callback_path === b.callback_path &&
    a.is_active === b.is_active
  );
}

/**
 * Seed (or converge) the payment_link_pool from the deployment catalogue.
 * Idempotent and safe to call repeatedly (server boot + `npm run db:seed:pool`).
 */
export async function seedPaymentPool(): Promise<PoolSeedReport> {
  const cfg = paymentPoolConfig();
  const report: PoolSeedReport = { configured: 0, seeded: 0, updated: 0, unchanged: 0, skipped: 0, intentionallyDisabled: 0, active: 0, total: 0, warnings: [] };

  // Existing catalogue rows + indexes currently held by a live RESERVED
  // reservation (never disturbed mid-checkout).
  const existingRows = await queryManyRows();
  const byIndex = new Map<number, PoolRowLike>(existingRows.map((r) => [r.link_index, r]));
  const reservedIndexes = await queryReservedIndexes();

  let placeholderSeen = 0;

  for (const entry of cfg.links) {
    report.configured += 1;
    if (entry.enabled === false) report.intentionallyDisabled += 1;

    // STRUCTURAL FORMAT TOLERANCE (Finding 4). We only enforce what the
    // architecture requires: non-empty identifiers, required fields present,
    // a positive amount, INR currency, and a URL that parses (HTTPS when it is
    // a real provider link, see placeholder rule below). We never impose a
    // length/charset/prefix pattern on provider identifiers — a structurally
    // valid but unusual id is accepted as-is.
    const ref = entry.referenceId.trim();
    const url = entry.paymentUrl.trim();
    const cb = entry.callbackPath.trim();
    const isPlaceholder = isPlaceholderReferenceId(ref);

    if (ref.length === 0) {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: referenceId is empty (identifier must be non-empty)`);
      continue;
    }
    if (url.length === 0) {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: paymentUrl is empty`);
      continue;
    }
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(url);
    } catch {
      parsedUrl = null;
    }
    if (!parsedUrl) {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: paymentUrl "${url.length > 60 ? `${url.slice(0, 57)}...` : url}" is not a parseable URL`);
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: paymentUrl scheme must be http(s)`);
      continue;
    }
    if (!isPlaceholder && parsedUrl.protocol !== 'https:') {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: real provider link URL must be HTTPS`);
      continue;
    }
    if (cb.length === 0) {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: callbackPath is empty`);
      continue;
    }

    // The normalized (trimmed) values are what lands in the catalogue — this is
    // the explicit whitespace normalization for downstream consumers.
    const normalized: PoolLinkConfig = { ...entry, referenceId: ref, paymentUrl: url, callbackPath: cb };

    if (isPlaceholder) placeholderSeen += 1;

    // INR-only hard gate: a non-INR entry is skipped, never converted.
    if (normalized.currency !== 'INR') {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: currency ${normalized.currency} — launch currency is INR only`);
      continue;
    }
    // Amount binding: must equal the authoritative plan price or no callback
    // could ever validate; seed it only if it can actually activate.
    const authority = PLAN_PRICES_INR[normalized.plan];
    if (normalized.amount !== authority) {
      report.skipped += 1;
      report.warnings.push(`link ${entry.index} skipped: amount ${normalized.amount} != authoritative ${planLabel(normalized.plan)} price ${authority}`);
      continue;
    }

    const want = entryRow(normalized);
    const have = byIndex.get(entry.index);

    // Preserve an in-flight checkout: never mutate a link with a live RESERVED
    // reservation (immutable binding for late-callback protection).
    if (reservedIndexes.has(entry.index)) {
      report.unchanged += 1;
      report.warnings.push(`link ${entry.index} preserved: active RESERVED reservation holds this link`);
      continue;
    }

    if (rowsEqual(want, have)) {
      report.unchanged += 1;
      continue;
    }

    // SPEC §24: a consumed (fulfilled) link is PERMANENTLY disabled. Config is
    // never allowed to resurrect it — a fulfilled link must never be handed to
    // another user. This check must come AFTER rowsEqual (a consumed link whose
    // config now says enabled would otherwise look "changed" and get re-seeded).
    if (have?.consumed_at) {
      report.unchanged += 1;
      report.warnings.push(`link ${entry.index} preserved: consumed by a fulfilled payment (${have.consumed_at.toISOString()}) — permanently non-allocatable`);
      continue;
    }

    await withSystem(async (q) =>
      q.query(
        `INSERT INTO payment_link_pool
           (link_index, payment_link_id, razorpay_url, reference_id, amount, currency, plan, callback_path, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (link_index) DO UPDATE SET
           payment_link_id = EXCLUDED.payment_link_id,
           razorpay_url = EXCLUDED.razorpay_url,
           reference_id = EXCLUDED.reference_id,
           amount = EXCLUDED.amount,
           currency = EXCLUDED.currency,
           plan = EXCLUDED.plan,
           callback_path = EXCLUDED.callback_path,
           is_active = EXCLUDED.is_active`,
        [want.link_index, want.payment_link_id, want.razorpay_url, want.reference_id, want.amount, want.currency, want.plan, want.callback_path, want.is_active],
      ),
    );
    if (have) report.updated += 1;
    else report.seeded += 1;
  }

  const totals = await queryPoolTotals();
  report.total = totals.total;
  report.active = totals.active;

  // Placeholder aggregate: the catalogue uses the UNVERIFIED CCPOOL-* scheme.
  // Real provider links are not configured — this is a WARNING, never a
  // failure, and it must not block dev/test (placeholders seed normally).
  if (placeholderSeen > 0) {
    report.warnings.push(`PLACEHOLDER_LINKS: ${placeholderSeen} catalogue link(s) use the ${PLACEHOLDER_REF_PREFIX}* UNVERIFIED dev/test placeholder scheme — real payment links are NOT configured (seeding is NOT failing)`);
  }

  if (report.skipped > 0 || placeholderSeen > 0) {
    for (const w of report.warnings) logger.warn(`[payment-pool] ${w}`);
  }
  logger.info('[payment-pool] seed complete', {
    configured: report.configured,
    seeded: report.seeded,
    updated: report.updated,
    unchanged: report.unchanged,
    skipped: report.skipped,
    total: report.total,
    active: report.active,
  });
  return report;
}

/**
 * Phase 4 — startup self-check. Fail loud when explicit catalogue configuration
 * is present but seeding produced zero usable links (every checkout would 503).
 * An intentional all-disabled configuration warns instead.
 */
export async function assertPoolUsable(report: PoolSeedReport): Promise<void> {
  // PLACEHOLDER WARNING (non-failing): if every catalogue link uses the
  // UNVERIFIED CCPOOL-* dev/test scheme, real payment links are not configured.
  // This must NOT falsely indicate a seeding failure and must NOT block
  // dev/test — the pool is still usable for development.
  const cfg = paymentPoolConfig();
  const anyReal = cfg.links.some((l) => !isPlaceholderReferenceId(l.referenceId.trim()));
  const anyPlaceholder = cfg.links.some((l) => isPlaceholderReferenceId(l.referenceId.trim()));
  if (!anyReal && anyPlaceholder) {
    logger.warn(
      '[payment-pool] PLACEHOLDER_WARNING: real Razorpay payment links are NOT configured — catalogue uses the CCPOOL-* UNVERIFIED dev/test placeholder scheme. Seeding is NOT failing; replace the placeholder catalogue with real links before any live use.',
    );
  }

  const hasExplicitConfig = Boolean(env.PAYMENT_POOL_LINKS && env.PAYMENT_POOL_LINKS.trim().length > 0);
  if (!hasExplicitConfig) return;
  if (report.active > 0) return;

  // An explicit, intentionally all-disabled configuration is a deliberate
  // state, not a misdeployment. A configuration that is merely invalid
  // (skipped entries) is NOT intentional and fails loud.
  if (report.configured > 0 && report.intentionallyDisabled === report.configured) return;

  throw new Error(
    `payment-link pool unusable: explicit PAYMENT_POOL_LINKS configured but 0 active links after seeding ` +
      `(configured=${report.configured} skipped=${report.skipped} intentionallyDisabled=${report.intentionallyDisabled}). ` +
      `Refusing to start: every checkout would fail with ALL_LINKS_BUSY_TRY_AGAIN. Fix the pool configuration or disable ` +
      `the pool explicitly.`,
  );
}

function planLabel(plan: 'pro' | 'team' | 'api'): string {
  return plan.toUpperCase();
}

async function queryManyRows(): Promise<PoolRowLike[]> {
  return queryManyRowsImpl();
}

async function queryReservedIndexes(): Promise<Set<number>> {
  const rows = await queryManyReserved();
  return new Set(rows.map((r) => r.link_index));
}

async function queryPoolTotals(): Promise<{ total: number; active: number }> {
  return withSystem(async (q) => {
    const total = (await q.query<{ n: number | null }>('SELECT count(*)::int AS n FROM payment_link_pool')).rows[0];
    const active = (await q.query<{ n: number | null }>('SELECT count(*)::int AS n FROM payment_link_pool WHERE is_active = true')).rows[0];
    return { total: total?.n ?? 0, active: active?.n ?? 0 };
  });
}

/**
 * DB-agnostic read helpers. Kept as separate indirections so a DB-mocked test
 * harness (matching the repo convention) can intercept the exact statements the
 * seeder issues. Reads are snapshot-at-start: convergence is compare-then-write.
 */
async function queryManyRowsImpl(): Promise<PoolRowLike[]> {
  return withSystem(async (q) =>
    (await q.query<PoolRowLike>(
      `SELECT link_index, payment_link_id, razorpay_url, reference_id, amount, currency, plan, callback_path, is_active, consumed_at FROM payment_link_pool`,
    )).rows,
  );
}

async function queryManyReserved(): Promise<Array<{ link_index: number }>> {
  return withSystem(async (q) =>
    (await q.query<{ link_index: number }>(
      `SELECT link_index FROM payment_link_reservations WHERE status = 'RESERVED'`,
    )).rows,
  );
}