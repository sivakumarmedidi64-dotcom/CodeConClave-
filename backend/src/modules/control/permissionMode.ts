/**
 * CodeConClave — per-user permission mode (Claude-style approvals dial).
 *
 * The policy engine (execution/policy.ts) is synchronous and called from many
 * places, so the mode lives in a small cache that authenticated requests
 * refresh from Postgres (TTL 15s). Anything unknown — no row, cache miss, DB
 * error — resolves to 'ask', the strictest mode. A mode only waives the
 * approval PROMPT for specific allowed actions; it never turns a denial into
 * an allow and never touches deletes or HIGH/CRITICAL commands.
 *
 * Power Mode: a mode can be time-boxed (e.g. Auto for 2 hours). The expiry is
 * enforced on every read — even from the cache — so a lapsed grant falls back
 * to the previous mode without waiting for any sweep.
 */
import type { NextFunction, Request, Response } from 'express';
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';
import { loadPermissionRules, rulesStale } from './permissionRules.js';

export const PERMISSION_MODES = ['ask', 'accept_edits', 'full_access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const TTL_MS = 15_000;
/** Longest Power Mode grant (12 hours). */
export const MAX_POWER_MINUTES = 12 * 60;

interface CachedMode {
  mode: PermissionMode;
  at: number;
  /** Power Mode: when the grant lapses (epoch ms), and what it falls back to. */
  expiresAt?: number | null;
  revertTo?: PermissionMode | null;
}
const cache = new Map<string, CachedMode>();

export interface PermissionModeState {
  mode: PermissionMode;
  /** ISO time the current (temporary) mode ends; null = until changed. */
  expiresAt: string | null;
  /** The mode it returns to when it ends. */
  revertTo: PermissionMode | null;
}

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

function effective(entry: CachedMode | undefined, now = Date.now()): PermissionMode {
  if (!entry) return 'ask';
  if (entry.expiresAt && now >= entry.expiresAt) return entry.revertTo ?? 'ask';
  return entry.mode;
}

/** Synchronous read for the policy engine. Unknown → 'ask'; lapsed Power Mode → its fallback. */
export function permissionModeFor(userId: string): PermissionMode {
  return effective(cache.get(userId));
}

/** Full state (mode + Power Mode expiry) from Postgres; refreshes the cache. */
export async function loadPermissionModeState(userId: string): Promise<PermissionModeState> {
  const row = await withTenant(userId, async (q) =>
    (
      await q.query<{ mode: string; expires_at: Date | null; revert_to: string | null }>(
        'SELECT mode, expires_at, revert_to FROM user_permission_modes WHERE user_id = $1',
        [userId],
      )
    ).rows[0],
  );
  const stored: PermissionMode = isPermissionMode(row?.mode) ? row.mode : 'ask';
  const revertTo: PermissionMode | null = isPermissionMode(row?.revert_to) ? row.revert_to : null;
  const expiresAt = row?.expires_at ? new Date(row.expires_at).getTime() : null;
  const entry: CachedMode = { mode: stored, at: Date.now(), expiresAt, revertTo };
  cache.set(userId, entry);
  const mode = effective(entry);
  if (expiresAt && Date.now() >= expiresAt) {
    // Lapsed Power Mode: settle the row back to its fallback (best effort —
    // the read above already enforces the expiry).
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE user_permission_modes SET mode = $2, expires_at = NULL, revert_to = NULL, updated_at = now()
          WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at <= now()`,
        [userId, mode],
      ),
    ).catch(() => undefined);
    cache.set(userId, { mode, at: Date.now() });
    return { mode, expiresAt: null, revertTo: null };
  }
  return { mode, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, revertTo: expiresAt ? revertTo : null };
}

export async function loadPermissionMode(userId: string): Promise<PermissionMode> {
  return (await loadPermissionModeState(userId)).mode;
}

/**
 * Set the mode. With `minutes`, it is Power Mode: the mode applies for that
 * long (1…MAX_POWER_MINUTES) and then falls back to the mode you had before.
 */
export async function setPermissionMode(userId: string, mode: unknown, opts: { minutes?: unknown } = {}): Promise<PermissionMode> {
  if (!isPermissionMode(mode)) {
    throw AppError.badRequest('invalid_permission_mode', `mode must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  let minutes: number | null = null;
  if (opts.minutes !== undefined && opts.minutes !== null) {
    minutes = Number(opts.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_POWER_MINUTES) {
      throw AppError.badRequest('invalid_power_mode_duration', `minutes must be a whole number from 1 to ${MAX_POWER_MINUTES}`);
    }
    if (mode === 'ask') minutes = null; // Manual never needs a timer.
  }
  const before = cache.get(userId);
  const previous = effective(before);
  // Fall back to the mode the user had before any Power Mode began.
  const base: PermissionMode = before?.expiresAt && Date.now() < before.expiresAt ? (before.revertTo ?? 'ask') : previous;
  const expiresAt = minutes ? new Date(Date.now() + minutes * 60_000) : null;
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO user_permission_modes (user_id, mode, expires_at, revert_to) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, expires_at = EXCLUDED.expires_at,
         revert_to = EXCLUDED.revert_to, updated_at = now()`,
      [userId, mode, expiresAt, expiresAt ? base : null],
    ),
  );
  cache.set(userId, { mode, at: Date.now(), expiresAt: expiresAt?.getTime() ?? null, revertTo: expiresAt ? base : null });
  await recordAudit({
    action: 'control.permission_mode_changed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'permission_mode',
    resourceId: userId,
    detail: { from: previous, to: mode, ...(expiresAt ? { until: expiresAt.toISOString(), thenBackTo: base } : {}) },
  }).catch(() => undefined);
  return mode;
}

/** Keep the cache fresh for authenticated users (one indexed read per 15s). */
export function permissionModeRefresher() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const userId = req.ctx?.user?.id;
    const cached = userId ? cache.get(userId) : undefined;
    if (userId && (!cached || Date.now() - cached.at > TTL_MS)) {
      try {
        await loadPermissionMode(userId);
      } catch (err) {
        // Fail safe: drop to the strictest mode rather than keep a stale grant.
        cache.set(userId, { mode: 'ask', at: Date.now() });
        logger.warn('permission mode refresh failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // The user's allow/ask/deny rules ride the same refresh. On a failed read
    // the previous rules stay (so deny/ask rules never silently vanish).
    if (userId && rulesStale(userId)) {
      try {
        await loadPermissionRules(userId);
      } catch (err) {
        logger.warn('permission rules refresh failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    next();
  };
}

/** Test seam. */
export function _setPermissionModeForTests(
  userId: string,
  mode: PermissionMode | null,
  power?: { expiresAt: number; revertTo: PermissionMode },
): void {
  if (mode === null) cache.delete(userId);
  else cache.set(userId, { mode, at: Date.now(), expiresAt: power?.expiresAt ?? null, revertTo: power?.revertTo ?? null });
}
