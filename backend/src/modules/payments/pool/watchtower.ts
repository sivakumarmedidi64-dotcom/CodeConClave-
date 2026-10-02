/**
 * CodeConClave — PAYMENT WATCHTOWER (READ-ONLY, GLOBALLY UNSCOPED).
 *
 * Periodic safety scan over the whole payment system. It ONLY reads. It never
 * reserves, releases, expires, seeds, or otherwise mutates any row — mutation
 * remains solely with the pool service / seeder / reconciliation.
 *
 * The watchtower is a MONITORING system, not an authorization boundary: it has
 * NO identity-based filtering and inspects payment state across ALL users,
 * workspaces and projects (tenancy isolation is preserved for user-facing
 * APIs; this process is privileged, read-only and system-scoped).
 *
 * Checks (each = one global aggregate query, system-scoped, no owner filter):
 *   C1  Reserved > active                       — over-subscription (impossible if pool unique index works)
 *   C2  RESERVED rows past their expiry         — reservation expiry leak (should be reaped)
 *   C3  Reserved-but-not-active link index      — a callback bound to a link that is no longer active (stale)
 *   C4  Outlier reservation duration            — reservation much older than TTL (clock skew / stuck row)
 *   C5  Callbacks referencing unknown link      — orphaned payment/callback evidence
 *   C6  Pool is not even seeded                  — empty pool with no explicit config would 503 everything
 *   C7  Replay / duplicate / ambiguous evidence  — duplicate-payment attempts and evidence that
 *                                                 could not be trusted (parse failure is surfaced by
 *                                                 these ambiguous outcomes, not hidden)
 *
 * Alert delivery: only the DESTINATION is configurable (PAYMENT_WATCHTOWER_ALERT_EMAIL,
 * sent via the existing outbox/SMTP configuration). The absence of a destination
 * NEVER skips a check and NEVER reduces coverage:
 *   1. all checks run,
 *   2. the complete result is always recorded and written to the log,
 *   3. when a destination is missing AND something is failing, exactly one
 *      ALERT_DESTINATION_UNCONFIGURED warning is emitted,
 *   4. alertSent reflects whether an alert was actually dispatched.
 */
import { withSystem } from '../../../shared/db.js';
import { enqueueOutbox } from '../../../modules/outbox/service.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../shared/logger.js';

export type WatchCheckId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';

export interface WatchCheckResult {
  check: WatchCheckId;
  ok: boolean;
  detail: string | null;
  unreadable?: boolean;
}

export interface WatchtowerReport {
  checks: WatchCheckResult[];
  failing: number;
  unreadable: number;
  alertSent: boolean;
  alertDestinationConfigured: boolean;
}

export function watchtowerAlertEmail(): string | null {
  const raw = env.PAYMENT_WATCHTOWER_ALERT_EMAIL;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Run every check. A check whose query throws is surfaced as
 * STATE_UNREADABLE (ok=false, unreadable=true) rather than aborting the whole
 * scan — so a partially-unreadable store still alerts loudly.
 *
 * `alertEmail` is injectable for tests; production callers omit it and
 * PAYMENT_WATCHTOWER_ALERT_EMAIL is used. It configures delivery ONLY.
 */
export async function runPoolWatchtower(opts: { alertEmail?: string | null } = {}): Promise<WatchtowerReport> {
  const alertEmail = opts.alertEmail !== undefined ? (opts.alertEmail ?? '').trim() : (watchtowerAlertEmail() ?? '');
  const destinationConfigured = alertEmail.length > 0 && alertEmail.includes('@');
  const checks: WatchCheckResult[] = [];

  const run = async (
    check: WatchCheckId,
    label: string,
    fn: () => Promise<{ ok: boolean; detail: string | null }>,
  ): Promise<void> => {
    try {
      const r = await fn();
      checks.push({ check, ok: r.ok, detail: r.detail });
    } catch (err) {
      logger.warn('payment.watchtower.unreadable', { check, label, error: err instanceof Error ? err.message : String(err) });
      checks.push({
        check,
        ok: false,
        unreadable: true,
        detail: `${label} unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // ---- global, system-scoped aggregate checks (NO identity filtering) ----
  await run('C1', 'reserved-vs-active', async () => {
    const [reserved, active] = await withSystem<[number, number]>((db) =>
      Promise.all([
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_link_reservations WHERE status = 'RESERVED'`).then((r) => r.rows[0]?.n ?? 0),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_link_pool WHERE is_active = true`).then((r) => r.rows[0]?.n ?? 0),
      ]),
    );
    if (reserved > active) return { ok: false, detail: `${reserved} live reservations > ${active} active links` };
    return { ok: true, detail: `${reserved} reserved / ${active} active` };
  });

  await run('C2', 'expired-reservations', async () => {
    const rows = await withSystem<Array<{ id: string }>>((db) =>
      db
        .query<{ id: string }>(`SELECT id FROM payment_link_reservations WHERE status = 'RESERVED' AND expires_at < now()`)
        .then((r) => r.rows),
    );
    if (rows.length > 0) return { ok: false, detail: `${rows.length} RESERVED row(s) past expiry` };
    return { ok: true, detail: 'no expired RESERVED row' };
  });

  await run('C3', 'reserved-on-inactive-link', async () => {
    const rows = await withSystem<Array<{ ref_id: string }>>((db) =>
      db
        .query<{ ref_id: string }>(
          `SELECT l.reference_id AS ref_id
             FROM payment_link_reservations r
             JOIN payment_link_pool l ON l.link_index = r.link_index
            WHERE r.status = 'RESERVED' AND l.is_active = false`,
        )
        .then((r) => r.rows),
    );
    if (rows.length > 0) return { ok: false, detail: `${rows.length} live reservation(s) on inactive links` };
    return { ok: true, detail: 'no live reservation on inactive link' };
  });

  await run('C4', 'outlier-reservation-duration', async () => {
    const rows = await withSystem<Array<{ id: string }>>((db) =>
      db
        .query<{ id: string }>(
          `SELECT id FROM payment_link_reservations
            WHERE status = 'RESERVED'
              AND expires_at - reserved_at > make_interval(mins => 240)`,
        )
        .then((r) => r.rows),
    );
    if (rows.length > 0) return { ok: false, detail: `${rows.length} reservation(s) with outlier duration (>4h)` };
    return { ok: true, detail: 'no outlier reservation duration' };
  });

  await run('C5', 'callback-unknown-link', async () => {
    const rows = await withSystem<Array<{ id: string }>>((db) =>
      db
        .query<{ id: string }>(
          `SELECT c.id FROM payment_pool_callbacks c
            LEFT JOIN payment_link_pool l ON l.link_index = c.link_index
           WHERE c.link_index IS NOT NULL AND l.link_index IS NULL`,
        )
        .then((r) => r.rows),
    );
    if (rows.length > 0) return { ok: false, detail: `${rows.length} callback(s) reference unknown link` };
    return { ok: true, detail: 'no callback references unknown link' };
  });

  await run('C6', 'pool-seeded', async () => {
    const rows = await withSystem<Array<{ n: number }>>((db) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_link_pool`).then((r) => r.rows),
    );
    const n = rows[0]?.n ?? 0;
    if (n === 0) return { ok: false, detail: 'payment_link_pool is empty (0 rows) — every checkout would 503' };
    return { ok: true, detail: `${n} pool rows` };
  });

  // C7: replay / duplicate / ambiguous evidence attempts (global). Duplicate
  // payment ids and ambiguous (untrusted) evidence are security-relevant
  // signals that always surface for a human — fail closed, never hidden.
  await run('C7', 'replay-duplicate-evidence', async () => {
    const rows = await withSystem<number>((db) =>
      db
        .query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payment_pool_callbacks WHERE outcome IN ('duplicate','ambiguous','fraud_blocked')`,
        )
        .then((r) => r.rows[0]?.n ?? 0),
    );
    if (rows > 0) return { ok: false, detail: `${rows} replay/duplicate/ambiguous evidence attempt(s)` };
    return { ok: true, detail: 'no replay/duplicate/ambiguous evidence attempts' };
  });

  const failing = checks.filter((c) => !c.ok).length;
  const unreadable = checks.filter((c) => c.unreadable).length;

  // Always record/write the complete result to the log. Alert delivery is a
  // separate concern and NEVER affects monitoring coverage.
  const reportLines = checks.map((c) => `${c.check}${c.unreadable ? ' (STATE_UNREADABLE)' : ''}:: ${c.ok ? 'OK' : 'FAIL'} ${c.detail ?? ''}`).join('\n');

  let alertSent = false;
  if (failing > 0 && destinationConfigured) {
    const lines = checks
      .filter((c) => !c.ok)
      .map((c) => `${c.check}${c.unreadable ? ' (STATE_UNREADABLE)' : ''}:: ${c.detail ?? ''}`)
      .join('\n');
    const day = new Date().toISOString().slice(0, 10);
    const signature = checks.filter((c) => !c.ok).map((c) => c.check).join(',') || 'unknown';
    await enqueueOutbox(
      'payment.watchtower.alert',
      {
        channel: 'email',
        to: alertEmail,
        subject: 'CodeConClave payment watchtower alert',
        message: `One or more payment checks are failing.\n${lines}\n\n(Read-only, globally scoped scan. No automated action taken — reconcile manually.)`,
      },
      { dedupeKey: `watchtower:alert:${day}:${signature}` },
    );
    alertSent = true;
    logger.warn('payment.watchtower.alert', { failing, unreadable, alertEmail });
  }

  if (failing > 0) {
    logger.warn('payment.watchtower.report', { failing, unreadable, checks: reportLines });
    if (!destinationConfigured) {
      // Exactly ONE explicit warning when alerts cannot be delivered — the
      // scan already ran and is fully recorded; only delivery is unavailable.
      logger.warn('payment.watchtower.alert_destination_unconfigured', {
        warning: 'ALERT_DESTINATION_UNCONFIGURED',
        detail: 'PAYMENT_WATCHTOWER_ALERT_EMAIL is not set — all checks still ran and are recorded, but no alert was delivered',
      });
    }
  } else {
    logger.info('payment.watchtower.report', { failing, unreadable, checks: reportLines });
  }

  return {
    checks,
    failing,
    unreadable,
    alertSent,
    alertDestinationConfigured: destinationConfigured,
  };
}