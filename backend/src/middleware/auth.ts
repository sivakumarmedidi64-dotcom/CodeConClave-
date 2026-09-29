/**
 * CodeConClave — authentication middleware (opaque session tokens).
 * Cookie `cc_session` carries a random 32-byte token; only its SHA-256 hash is
 * stored server-side in `sessions`. Client state is never the authentication
 * authority.
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { sha256Hex } from '../shared/crypto.js';
import { pool } from '../shared/db.js';
import type { AuthUser } from './context.js';
import { logger } from '../shared/logger.js';

export const SESSION_COOKIE = 'cc_session';
const THROTTLE_LAST_SEEN_MS = 5 * 60 * 1000;

export interface SessionRow {
  id: string;
  state: string;
  expires_at: Date;
  user_id: string;
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

async function loadSession(token: string, req: Request): Promise<AuthUser | null> {
  if (!token) return null;
  const result = await pool.query<SessionRow>(
    `SELECT s.id, s.state, s.expires_at, u.id AS user_id, u.email, u.email_verified,
            u.display_name, u.avatar_url, u.google_sub, u.role, u.primary_use_case,
            u.mfa_enabled, u.rbac_role,
            u.plan_id, u.entitlement_state
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [sha256Hex(token)],
  );
  const row = result.rows[0];
  if (!row || row.state !== 'ACTIVE' || row.expires_at.getTime() <= Date.now()) return null;
  if (!req.ctx) return null;

  const user: AuthUser = {
    id: row.user_id,
    email: row.email,
    emailVerified: row.email_verified,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    googleSub: row.google_sub,
    role: row.role ?? null,
    primaryUseCase: row.primary_use_case ?? null,
    mfaEnabled: row.mfa_enabled,
    rbacRole: row.rbac_role,
    planId: row.plan_id,
    entitlementState: row.entitlement_state,
  };
  req.ctx.sessionId = row.id;
  return user;
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] ?? undefined;
  loadSession(token ?? '', req)
    .then((user) => {
      if (user && req.ctx) req.ctx.user = user;
      next();
    })
    .catch((err) => {
      // FAIL CLOSED: a session lookup failure must never silently demote a
      // valid session to anonymous. Honest degradation — the caller sees 503.
      logger.error('session load failed', { error: (err as Error).message });
      next(AppError.unavailable('auth_unavailable', 'Authentication service is temporarily unavailable'));
    });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.ctx?.user) {
    next(AppError.unauthorized());
    return;
  }
  next();
}

export async function touchSession(sessionId: string, req: Request): Promise<void> {
  if (!sessionId) return;
  const key = `last_seen:${sessionId}`;
  const now = Date.now();
  const last = await import('../shared/cache.js').then((m) => m.cache.get(key));
  if (last && now - Number(last) < THROTTLE_LAST_SEEN_MS) return;
  await import('../shared/cache.js').then((m) => m.cache.set(key, String(now), THROTTLE_LAST_SEEN_MS));
  pool
    .query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId])
    .catch(() => undefined);
}

export function setSessionCookie(res: Response, token: string): void {
  const maxAgeDays = env.AUTH_SESSION_TTL_DAYS;
  const cookieOpts: Record<string, unknown> = {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeDays * 24 * 60 * 60 * 1000,
  };
  if (env.AUTH_COOKIE_DOMAIN) {
    cookieOpts.domain = env.AUTH_COOKIE_DOMAIN;
  }
  res.cookie(SESSION_COOKIE, token, cookieOpts);
}

/**
 * Clear the session cookie. The attributes MUST match setSessionCookie exactly
 * (domain in particular): a browser only drops a cookie when the clearing
 * cookie's name/domain/path match, so omitting `domain` here left the session
 * cookie in place on configured-domain deployments and logout was a no-op.
 */
export function clearSessionCookie(res: Response): void {
  const cookieOpts: Record<string, unknown> = {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
  };
  if (env.AUTH_COOKIE_DOMAIN) {
    cookieOpts.domain = env.AUTH_COOKIE_DOMAIN;
  }
  res.clearCookie(SESSION_COOKIE, cookieOpts);
}

export function tokenFromReq(req: Request): string {
  return (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? '';
}

export function makeAuthError(): AppError {
  return AppError.unauthorized();
}