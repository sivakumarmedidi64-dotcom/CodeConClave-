/**
 * CodeConClave — Google OAuth (existing client; do not create a second one).
 * Enabled APIs: Gmail, Drive, Sheets, Calendar.
 * Refresh tokens are stored server-side, AES-256-GCM encrypted, and never
 * exposed to the frontend.
 */
import { env, enabledGoogleScopes } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { outboundSignal } from '../../shared/http-timeout.js';
import { encryptAtRest, decryptAtRest, randomToken, sha256Hex } from '../../shared/crypto.js';
import { pool, withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import type { Request } from 'express';
import { createHmac } from 'node:crypto';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

export function googleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: enabledGoogleScopes.join(' '),
    access_type: 'offline',
    prompt: env.GOOGLE_OAUTH_CONSENT_MODE,
    state,
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

function googleStateToken(nonce: string): string {
  const body = Buffer.from(JSON.stringify({ nonce, exp: Date.now() + 10 * 60 * 1000 })).toString('base64url');
  const sig = createHmac('sha256', env.JWT_SECRET).update(`google-oauth:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyGoogleState(token: string): void {
  const [body, sig] = token.split('.');
  if (!body || !sig || createHmac('sha256', env.JWT_SECRET).update(`google-oauth:${body}`).digest('base64url') !== sig) {
    throw AppError.badRequest('google_state_invalid', 'Invalid OAuth state');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { exp: number };
  if (payload.exp <= Date.now()) throw AppError.badRequest('google_state_expired', 'OAuth state expired');
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string | null }> {
  if (!googleConfigured()) {
    throw AppError.unavailable('google_not_configured', 'Google OAuth is not configured on the server');
  }
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
      signal: outboundSignal(),
    });
  } catch {
    throw AppError.unavailable('google_token_timeout', 'Google token exchange timed out');
  }
  if (!response.ok) {
    const text = await response.text();
    throw AppError.badRequest('google_token_failed', 'Google token exchange failed');
  }
  const payload = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token ?? null };
}

async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: outboundSignal(),
    });
  } catch {
    throw AppError.unavailable('google_userinfo_timeout', 'Google profile fetch timed out');
  }
  if (!response.ok) throw AppError.badRequest('google_userinfo_failed', 'Failed to fetch Google profile');
  return (await response.json()) as GoogleUserInfo;
}

async function upsertGoogleUser(
  info: GoogleUserInfo,
  tokens: { refreshToken: string | null; accessToken: string | null; expiresInSeconds: number | null },
): Promise<string> {
  const result = await withTenant(null, async (q) => {
    const insert = await q.query(
      `INSERT INTO users (id, email, email_verified, google_sub, display_name, avatar_url, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6, NULL)
       ON CONFLICT (google_sub) DO UPDATE
         SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
             display_name = COALESCE(users.display_name, EXCLUDED.display_name),
             avatar_url = COALESCE(users.avatar_url, EXCLUDED.avatar_url)
       RETURNING id`,
      [newId(PREFIX.USER), info.email.toLowerCase(), info.email_verified ?? false, info.sub, info.name ?? null, info.picture ?? null],
    );
    const userId = insert.rows[0]?.id as string | undefined;
    if (!userId) throw new Error('idempotent user upsert failed');
    await q.query(
      `INSERT INTO entitlements (id, user_id, plan_id, state) VALUES ($1,$2,'free','FREE')
       ON CONFLICT (user_id, plan_id) DO NOTHING`,
      [newId(PREFIX.ENTITLEMENT), userId],
    );
    await q.query(
      `INSERT INTO user_preferences (id, owner_id, prefs) VALUES ($1,$2,'{}'::jsonb)
       ON CONFLICT (owner_id) DO NOTHING`,
      [newId(PREFIX.PREFERENCE), userId],
    );
    // Server-side OAuth connection: refresh token AES-256-GCM at rest, never exposed.
    const expiresAt = tokens.expiresInSeconds
      ? new Date(Date.now() + tokens.expiresInSeconds * 1000)
      : null;
    await q.query(
      `INSERT INTO google_connections
         (id, user_id, google_sub, scopes, refresh_token_encrypted, access_token_encrypted, token_expires_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET
         google_sub = EXCLUDED.google_sub,
         scopes = EXCLUDED.scopes,
         refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, google_connections.refresh_token_encrypted),
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         token_expires_at = EXCLUDED.token_expires_at`,
      [
        newId(PREFIX.USER),
        userId,
        info.sub,
        JSON.stringify(enabledGoogleScopes),
        tokens.refreshToken ? encryptAtRest(tokens.refreshToken) : null,
        tokens.accessToken ? encryptAtRest(tokens.accessToken) : null,
        expiresAt,
      ],
    );
    return userId;
  });
  return result;
}

export async function googleCallback(code: string): Promise<{ userId: string; isNewUser: boolean }> {
  if (!googleConfigured()) throw AppError.unavailable('google_not_configured', 'Google OAuth is not configured');
  const { accessToken, refreshToken } = await exchangeCode(code);
  const info = await fetchUserInfo(accessToken);
  if (!info.email) throw AppError.badRequest('google_no_email', 'Google account has no email');
  const existing = await pool.query('SELECT id FROM users WHERE google_sub = $1', [info.sub]);
  const isNewUser = !existing.rows[0];
  const userId = await upsertGoogleUser(info, { refreshToken, accessToken, expiresInSeconds: null });
  return { userId, isNewUser };
}

export async function createSessionForGoogleUser(userId: string, req: Request): Promise<string> {
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '30 days')`,
    [newId(PREFIX.SESSION), userId, sha256Hex(token), req.ip ?? null, req.headers['user-agent'] ?? null],
  );
  await recordAudit({
    action: AuditAction.AUTH_GOOGLE_LOGIN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    traceId: req.ctx?.traceId ?? null,
  });
  return token;
}

export function authResultFromUser(user: {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  google_sub: string | null;
  mfa_enabled: boolean;
  rbac_role: string;
  plan_id: string;
  entitlement_state: string;
}) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    googleSub: user.google_sub,
    mfaEnabled: user.mfa_enabled,
    rbacRole: user.rbac_role,
    planId: user.plan_id,
    entitlementState: user.entitlement_state,
  };
}

export { GOOGLE_TOKEN_ENDPOINT, GOOGLE_AUTH_ENDPOINT, googleStateToken };