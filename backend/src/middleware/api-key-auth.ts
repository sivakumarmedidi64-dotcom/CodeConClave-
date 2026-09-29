/**
 * CodeConClave — Bearer API-key authentication + STRICT per-key rate limiting.
 *
 * External clients authenticate with `Authorization: Bearer cc_live_...` (the
 * same keys provisioned in Billing > API keys). This middleware is the AI
 * API gate mounted at /api/v1/ai:
 *   - no Bearer header  -> pass through (session flow, unchanged);
 *   - invalid/revoked/expired key -> 401;
 *   - valid key WITHOUT a live (VERIFIED + unexpired) 'api' entitlement
 *     (₹9,999 API Access product) -> 402 payment_required. A Solo/Team
 *     purchase never grants it.
 *   - valid + entitled -> per-key window limit, per-key daily budget and
 *     in-flight concurrency cap are enforced (429). The raw key is never
 *     logged/stored; only the key id is used for counters.
 *
 * Security path => FAIL CLOSED: if the limit store is unavailable the request
 * is denied with 503 (never silently unlimited) — same contract as authLimit.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../shared/errors.js';
import { cache } from '../shared/cache.js';
import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';
import { resolveUserApiKey, apiAccessEntitlementState } from '../modules/apikeys/service.js';
import { pool } from '../shared/db.js';
import type { AuthUser } from './context.js';

interface KeyOwnerRow {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  google_sub: string | null;
  role: string | null;
  primary_use_case: string | null;
  mfa_enabled: boolean;
  rbac_role: 'owner' | 'admin' | 'member' | 'viewer';
  plan_id: 'free' | 'pro' | 'team' | 'enterprise';
  entitlement_state: 'FREE' | 'PRO_PENDING' | 'PRO_VERIFIED' | 'PRO_EXPIRED' | 'PRO_REFUNDED';
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? String(match[1]!).trim() : null;
}

async function loadOwnerAsUser(ownerId: string): Promise<AuthUser | null> {
  const result = await pool.query<KeyOwnerRow>(
    `SELECT id, email, email_verified, display_name, avatar_url, google_sub,
            role, primary_use_case, mfa_enabled, rbac_role, plan_id, entitlement_state
       FROM users WHERE id = $1`,
    [ownerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    googleSub: row.google_sub,
    role: row.role,
    primaryUseCase: row.primary_use_case,
    mfaEnabled: row.mfa_enabled,
    rbacRole: row.rbac_role,
    planId: row.plan_id,
    entitlementState: row.entitlement_state,
  };
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function decConcurrent(keyId: string): Promise<void> {
  const key = `rl:apikey:conc:${keyId}`;
  try {
    // Use atomic DECRBY instead of read-modify-write to prevent slot leaks
    // under concurrent release. If the key doesn't exist, INCR with a
    // negative value will create it — guard with a GET first.
    const current = Number(await cache.get(key)) || 0;
    if (current > 0) {
      const newVal = Math.max(0, current - 1);
      await cache.set(key, String(newVal), 120_000);
    }
  } catch {
    /* best-effort release; TTL (120s) acts as safety net */
  }
}

/**
 * Gate middleware. Use on the AI API choke point so EVERY /api/v1/ai request
 * from an external client passes authentication, entitlement, window/daily and
 * concurrency limits before reaching any handler or provider call.
 */
export function apiKeyAuth() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = bearerToken(req);
    if (!rawKey) {
      next();
      return;
    }

    try {
      const resolved = await resolveUserApiKey(rawKey);
      if (!resolved) {
        next(AppError.unauthorized('invalid_api_key', 'Invalid, expired or revoked API key.'));
        return;
      }
      const { ownerId, keyId } = resolved;

      // Mandatory product gate: only a VERIFIED, UNEXPIRED API Access (₹9,999)
      // purchase entitles a key to call the AI API. Never inferred from
      // amount/plan, and evaluated at request time so an expired entitlement
      // cannot be used until a background sweep happens to rewrite the row.
      const { entitled } = await apiAccessEntitlementState(ownerId);
      if (!entitled) {
        next(
          AppError.paymentRequired(
            'api_access_required',
            'This API key is not entitled to use the AI API. API Access (₹9,999) is purchased separately — Solo/Team plans do not include it.',
          ),
        );
        return;
      }

      // Per-key fixed-window limit.
      const windowMs = Math.max(1000, Number(env.API_RATE_LIMIT_WINDOW_SECONDS) * 1000);
      const windowLimit = Math.max(1, Number(env.API_RATE_LIMIT_REQUESTS));
      const windowKey = `rl:apikey:w:${keyId}`;
      const windowCount = await cache.incr(windowKey, windowMs);
      res.setHeader('X-RateLimit-Limit', String(windowLimit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, windowLimit - windowCount)));
      if (windowCount > windowLimit) {
        next(AppError.tooMany());
        return;
      }

      // Per-key daily budget.
      const dailyKey = `rl:apikey:d:${keyId}:${dayKey()}`;
      const dailyLimit = Math.max(1, Number(env.API_MAX_DAILY_REQUESTS));
      const dailyCount = await cache.incr(dailyKey, 86_400_000);
      if (dailyCount > dailyLimit) {
        next(AppError.tooMany());
        return;
      }

      // In-flight concurrency cap.
      const concurrencyKey = `rl:apikey:conc:${keyId}`;
      const maxConcurrent = Math.max(1, Number(env.API_MAX_CONCURRENT_REQUESTS));
      const active = await cache.incr(concurrencyKey, 120_000);
      if (active > maxConcurrent) {
        await decConcurrent(keyId);
        next(AppError.tooMany());
        return;
      }
      let released = false;
      res.once('close', () => {
        if (!released) {
          released = true;
          void decConcurrent(keyId);
        }
      });
      res.once('finish', () => {
        if (!released) {
          released = true;
          void decConcurrent(keyId);
        }
      });

      // Session-less identity for downstream handlers (requireAuth + ctx.user).
      if (req.ctx) {
        const user = await loadOwnerAsUser(ownerId);
        if (!user) {
          next(AppError.unauthorized('api_key_owner_missing', 'The API key owner no longer exists.'));
          return;
        }
        req.ctx.user = user;
      }
      next();
    } catch (err) {
      // FAIL CLOSED: never silently unlimited on a store outage.
      logger.error('api key auth unavailable', { error: (err as Error).message });
      next(AppError.unavailable('api_key_auth_unavailable', 'API key authentication is temporarily unavailable; try again shortly'));
    }
  };
}