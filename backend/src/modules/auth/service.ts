/**
 * CodeConClave — auth module.
 * Registration, password login, MFA (TOTP), recovery codes, sessions, devices.
 * Server is the single authority: sessions are opaque tokens, hashed at rest.
 */
import { createHmac, randomInt } from 'node:crypto';
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import {
  encryptAtRest,
  decryptAtRest,
  generateRecoveryCodes,
  hashSecret,
  normalizeRecoveryCode,
  randomToken,
  sha256Hex,
  totpSecret,
  totpUrl,
  verifyHash,
  verifyTotp,
} from '../../shared/crypto.js';
import { cache } from '../../shared/cache.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import type { Request } from 'express';
import { setSessionCookie } from '../../middleware/auth.js';
import type { AuthUser } from '../../middleware/context.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, ONBOARDING_ROLES, ONBOARDING_USE_CASES } from '@codeconclave/shared';
import type { Response } from 'express';
import { incMetric } from '../../observability/metrics.js';
import { isFounderAccount, isFounderEmail } from '../entitlements/service.js';
import { validateHandle, validateKeyword } from './identity-policy.js';

/** Upgrade a legacy scrypt v1 hash to the current v2 parameters after a
 *  successful authentication. Never throws: a failed upgrade must not deny an
 *  otherwise valid sign-in. */
async function rehashIfStale(
  table: 'users' | 'recovery_codes',
  column: string,
  userId: string,
  rowId: string,
  plaintext: string,
  attempts: 0 | 1 = 1,
): Promise<boolean> {
  try {
    const { needsRehash, rehashSecret } = await import('../../shared/crypto.js');
    const current = await pool.query<{ hash: string }>(
      `SELECT ${column} AS hash FROM ${table} WHERE id = $1`,
      [rowId],
    );
    const stored = current.rows[0]?.hash;
    if (!stored || !needsRehash(stored)) return false;
    if (attempts === 1) {
      await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [rehashSecret(stored, plaintext), rowId]);
      incMetric('auth.hash_upgraded');
      return true;
    }
    return needsRehash(stored);
  } catch (err) {
    logger.warn('scrypt rehash-upgrade failed', { userId, error: (err as Error).message });
    return false;
  }
}

const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * B3: upgrade a legacy scrypt v1 recovery-code hash to the current v2
 * parameters once it has been presented successfully. Exposed for the identity
 * (handle+keyword) TOTP path, which resolves recovery codes through identity.ts
 * rather than through completeMfa.
 */
export function rehashRecoveryCodeIfStale(rowId: string, plaintext: string, userId = 'unknown'): Promise<boolean> {
  return rehashIfStale('recovery_codes', 'code_hash', userId, rowId, plaintext);
}

// ---------------------------------------------------------------- MFA challenge tokens

interface MfaChallenge {
  userId: string;
  nonce: string;
  exp: number;
}

export function createMfaChallenge(userId: string): string {
  const payload: MfaChallenge = {
    userId,
    nonce: randomToken(8),
    exp: Date.now() + MFA_CHALLENGE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(body);
  return `mfa_${body}.${sig}`;
}

export function verifyMfaChallenge(token: string): MfaChallenge {
  const match = /^mfa_([^.]+)\.([^.]+)$/.exec(token);
  if (!match) throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid MFA challenge');
  const [, body, sig] = match;
  if (sign(body!) !== sig) throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid MFA challenge');
  const payload = JSON.parse(Buffer.from(body!, 'base64url').toString()) as MfaChallenge;
  if (payload.exp <= Date.now()) throw AppError.unauthorized('mfa_challenge_expired', 'MFA challenge expired');
  return payload;
}

function sign(body: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`mfa-challenge:${body}`).digest('base64url');
}

function hmacSign(body: string, purpose: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`${purpose}:${body}`).digest('base64url');
}

export function signedToken(payload: unknown, purpose: string, ttlMs: number): string {
  const body = Buffer.from(
    JSON.stringify({ ...(payload as Record<string, unknown>), exp: Date.now() + ttlMs }),
  ).toString('base64url');
  return `${body}.${hmacSign(body, purpose)}`;
}

export function verifySignedToken<T>(token: string, purpose: string): T {
  const [body, sig] = token.split('.');
  if (!body || !sig || hmacSign(body, purpose) !== sig) {
    throw AppError.unauthorized('token_invalid', 'Invalid token');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp: number };
  if (payload.exp <= Date.now()) throw AppError.unauthorized('token_expired', 'Token expired');
  return payload;
}

// ---------------------------------------------------------------- sessions

/** Associate a session with a PAIRED device presented via x-device-token. */
export async function deviceForRequest(userId: string, req: Request): Promise<string | null> {
  const token = req.headers['x-device-token'];
  if (typeof token !== 'string' || !token) return null;
  const result = await pool.query(
    `SELECT id FROM devices WHERE user_id = $1 AND state = 'PAIRED' AND token_hash = $2`,
    [userId, sha256Hex(token)],
  );
  return result.rows[0]?.id ?? null;
}

export async function createSessionForUser(
  userId: string,
  req: Request,
  deviceId: string | null = null,
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const sessionId = newId(PREFIX.SESSION);
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, device_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval)`,
    [sessionId, userId, tokenHash, req.ip ?? null, req.headers['user-agent'] ?? null, deviceId, env.AUTH_SESSION_TTL_DAYS],
  );
  return { token, sessionId };
}

/**
 * Suspicious-session hook: when a login arrives from an IP the user has never
 * used before (within the retention window), flag the session and emit
 * auth.suspicious_login. Non-blocking — a login is never refused by this hook.
 */
export async function hookSuspiciousSession(userId: string, sessionId: string, req: Request): Promise<void> {
  if (!req.ip) return;
  const result = await pool.query(
    `SELECT ip FROM (
       SELECT DISTINCT ON (ip) ip, last_seen_at FROM sessions
       WHERE user_id = $1 AND ip IS NOT NULL
         AND id <> $2 AND created_at > now() - interval '90 days'
       ORDER BY ip, last_seen_at DESC
     ) recent_ips
     ORDER BY last_seen_at DESC LIMIT 10`,
    [userId, sessionId],
  );
  const known = new Set((result.rows as { ip: string }[]).map((r) => r.ip));
  if (known.has(req.ip)) return;
  incMetric('security.suspicious_logins');
  await pool.query(
    `UPDATE sessions SET risk_flags = risk_flags || $2::jsonb WHERE id = $1`,
    [sessionId, JSON.stringify(['new_ip'])],
  );
  await recordAudit({
    action: AuditAction.AUTH_SUSPICIOUS_LOGIN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { reason: 'new_ip', ip: req.ip },
  });
}

/** Sweep: mark ACTIVE sessions whose TTL elapsed as EXPIRED. Returns count. */
export async function expireStaleSessions(): Promise<number> {
  const result = await pool.query(
    `UPDATE sessions SET state = 'EXPIRED', revoked_at = now()
     WHERE state = 'ACTIVE' AND expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

/**
 * Session rotation after a privilege change (MFA enabled/disabled).
 * Revokes every ACTIVE session (including the current one and sessions on
 * other devices) and issues a single fresh session. Returns the new token so
 * the caller can set the cookie — the old token is dead immediately.
 */
export async function rotateSessionsAfterPrivilegeChange(
  userId: string,
  currentSessionId: string | null,
  req: Request,
): Promise<string> {
  await pool.query(
    `UPDATE sessions SET state = 'REVOKED', revoked_at = now()
     WHERE user_id = $1 AND state = 'ACTIVE' AND id <> $2`,
    [userId, currentSessionId ?? ''],
  );
  const created = await createSessionForUser(userId, req, await deviceForRequest(userId, req));
  await recordAudit({
    action: 'auth.session_rotated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'session',
    resourceId: created.sessionId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
  });
  return created.token;
}

export interface AuthResult {
  user: AuthUser;
  sessionToken: string;
  sessionId: string;
}

function toAuthUser(row: Record<string, unknown>): AuthUser {
  return {
    id: row.id as string,
    email: row.email as string,
    emailVerified: (row.email_verified as boolean) ?? false,
    displayName: (row.display_name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    googleSub: (row.google_sub as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    primaryUseCase: (row.primary_use_case as string | null) ?? null,
    mfaEnabled: (row.mfa_enabled as boolean) ?? false,
    rbacRole: (row.rbac_role as AuthUser['rbacRole']) ?? 'member',
    planId: (row.plan_id as AuthUser['planId']) ?? 'free',
    entitlementState: (row.entitlement_state as AuthUser['entitlementState']) ?? 'FREE',
  };
}

/**
 * PostgreSQL 23505 (unique_violation) on a specific constraint. The unique
 * index on lower(handle) is authoritative for handle collisions: a concurrent
 * registration can win the race between the pre-check and the insert.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === constraint;
}

export async function register(input: {
  email: string;
  password: string;
  handle?: string;
  keyword?: string;
  displayName?: string;
  role?: string;
  primaryUseCase?: string;
}, req: Request): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  // D1: handle + keyword are the primary credentials. Validate them BEFORE any
  // row is written, so an invalid handle cannot leave a half-registered
  // account, and reject a half-pair outright rather than silently creating an
  // account with only half of its primary login.
  const wantsIdentity = input.handle !== undefined || input.keyword !== undefined;
  if (wantsIdentity && (input.handle === undefined || input.keyword === undefined)) {
    throw AppError.badRequest('identity_pair_required', 'handle and keyword must be provided together');
  }
  const identity = wantsIdentity
    ? { handle: validateHandle(input.handle as string), keyword: validateKeyword(input.keyword as string) }
    : null;

  const existing = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (existing.rows[0]) throw AppError.conflict('email_taken', 'An account with this email already exists');

  if (identity) {
    const taken = await pool.query('SELECT 1 FROM user_auth_identities WHERE lower(handle) = $1', [identity.handle]);
    if (taken.rows[0]) throw AppError.conflict('handle_taken', 'That handle is not available');
  }

  // Security fix (founder squat): the configured founder address is reserved.
  // Founder entitlement requires users.is_founder + a verified email, so an
  // unverified registration could no longer unlock a Team workspace — but it
  // could still permanently lock the real founder out of their own address.
  // Reserve it at registration instead of provisioning a founder account here:
  // no founder row is ever auto-created by this path.
  if (isFounderEmail(email)) {
    throw AppError.conflict('email_taken', 'An account with this email already exists');
  }

  const userId = newId(PREFIX.USER);
  try {
    await withTenant(null, async (q) => {
      // is_founder is explicitly false for every self-service registration.
      await q.query(
        `INSERT INTO users (id, email, password_hash, display_name, role, primary_use_case, email_verified, is_founder)
       VALUES ($1,$2,$3,$4,$5,$6,false,false)`,
        [userId, email, hashSecret(input.password), input.displayName ?? null, input.role ?? null, input.primaryUseCase ?? null],
      );
      // The identity row is written in the SAME transaction, so an account can
      // never exist with a half-written identity, and a failed handle insert
      // rolls the account back instead of orphaning it. The SQL mirrors
      // createIdentityForUser() in identity.ts; it is inlined here because
      // identity.ts already imports from this module and the reverse edge would
      // create a require cycle.
      if (identity) {
        await q.query(
          `INSERT INTO user_auth_identities (id, user_id, handle, keyword_hash, preferred_mfa, keyword_changed_at)
           VALUES ($1,$2,$3,$4,'none', now())`,
          [newId(PREFIX.AUTH_IDENTITY), userId, identity.handle, hashSecret(identity.keyword)],
        );
      }
      await q.query(
        `INSERT INTO entitlements (id, user_id, plan_id, state) VALUES ($1,$2,'free','FREE')`,
        [newId(PREFIX.ENTITLEMENT), userId],
      );
      await q.query(
        `INSERT INTO user_preferences (id, owner_id, prefs) VALUES ($1,$2,'{}'::jsonb)`,
        [newId(PREFIX.PREFERENCE), userId],
      );
    });
  } catch (err) {
    // The unique index on lower(handle) is authoritative: a concurrent
    // registration can win the race between the pre-check and the insert.
    if (isUniqueViolation(err, 'uq_auth_identity_handle')) {
      throw AppError.conflict('handle_taken', 'That handle is not available');
    }
    throw err;
  }

  const created = await createSessionForUser(userId, req, await deviceForRequest(userId, req));
  const user = await getUserById(userId);
  await recordAudit({
    action: identity ? AuditAction.AUTH_IDENTITY_ENROLLED : AuditAction.AUTH_LOGIN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'user',
    resourceId: userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: identity ? { handle: identity.handle, via: 'registration' } : undefined,
  });
  return { user, sessionToken: created.token, sessionId: created.sessionId };
}

/**
 * Founder access — explicit founder-only entry for the designated account
 * configured via PAYMENT_FOUNDER_EMAIL. The founder signs in with the
 * account's existing password (no OTP, no typed-email magic). MUST fail
 * closed:
 *  - the address must match the configured founder email, AND
 *  - the account must already exist (never auto-provisioned), AND
 *  - the provided password must verify against that account's hash.
 * Every failure returns the SAME forbidden error (anti-enumeration: the
 * response never reveals whether an address is the founder or whether the
 * account exists). MFA is never bypassed. When PAYMENT_FOUNDER_EMAIL is not
 * configured this can never succeed.
 */
export async function founderAccess(
  input: { email: string; password: string },
  req: Request,
): Promise<AuthResult | { mfaRequired: true; challengeToken: string; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const result = await pool.query('SELECT * FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [email]);
  const row = result.rows[0];
  // Founder sign-in requires the PROVISIONED founder account (users.is_founder),
  // a VERIFIED founder email, and the correct credential. Previously this used
  // only the email string, so an unverified account registered with the founder
  // address could sign in. MFA below is still never bypassed.
  const founderOk = await isFounderAccount(row?.id, {
    email: row?.email ?? email,
    emailVerified: row?.email_verified,
  });
  const valid = !!row && founderOk && !!row.password_hash && verifyHash(row.password_hash as string, input.password);
  if (!valid) {
    incMetric('security.auth_failures');
    await recordAudit({
      action: AuditAction.AUTH_LOGIN_FAILED,
      actorUserId: (row?.id as string | undefined) ?? null,
      scope: 'USER',
      tenantId: (row?.id as string | undefined) ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      correlationId: req.ctx?.correlationId ?? null,
      detail: { reason: 'founder_access_denied' },
    });
    throw AppError.forbidden('founder_access_denied', 'Founder access is not authorized');
  }

  if (row.mfa_enabled) {
    return { mfaRequired: true, challengeToken: createMfaChallenge(row.id as string), userId: row.id as string };
  }

  await rehashIfStale('users', 'password_hash', row.id as string, row.id as string, input.password);

  const created = await createSessionForUser(row.id as string, req, await deviceForRequest(row.id as string, req));
  const user = toAuthUser(row);
  await recordAudit({
    action: AuditAction.AUTH_LOGIN,
    actorUserId: row.id as string,
    scope: 'USER',
    tenantId: row.id as string,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { via: 'founder' },
  });
  await hookSuspiciousSession(row.id as string, created.sessionId, req).catch((err) => {
    logger.warn('suspicious-session hook failed', { error: (err as Error).message });
  });
  return { user, sessionToken: created.token, sessionId: created.sessionId };
}

export async function login(
  input: { email: string; password: string },
  req: Request,
): Promise<AuthResult | { mfaRequired: true; challengeToken: string; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const result = await pool.query(
    `SELECT * FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
    [email],
  );
  const row = result.rows[0];
  if (!row || !row.password_hash || !verifyHash(row.password_hash as string, input.password)) {
    incMetric('security.auth_failures');
    await recordAudit({
      action: AuditAction.AUTH_LOGIN_FAILED,
      actorUserId: row?.id ?? null,
      scope: 'USER',
      tenantId: (row?.id as string | undefined) ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      correlationId: req.ctx?.correlationId ?? null,
      detail: { reason: 'bad_credentials' },
    });
    throw AppError.unauthorized('bad_credentials', 'Incorrect email or password');
  }

  if (row.mfa_enabled) {
    return { mfaRequired: true, challengeToken: createMfaChallenge(row.id as string), userId: row.id as string };
  }

  await rehashIfStale('users', 'password_hash', row.id as string, row.id as string, input.password);

  const created = await createSessionForUser(row.id as string, req, await deviceForRequest(row.id as string, req));
  const user = toAuthUser(row);
  await recordAudit({
    action: AuditAction.AUTH_LOGIN,
    actorUserId: row.id as string,
    scope: 'USER',
    tenantId: row.id as string,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
  });
  await hookSuspiciousSession(row.id as string, created.sessionId, req).catch((err) => {
    logger.warn('suspicious-session hook failed', { error: (err as Error).message });
  });
  return { user, sessionToken: created.token, sessionId: created.sessionId };
}

export async function completeMfa(input: {
  challengeToken: string;
  code?: string;
  recoveryCode?: string;
}, req: Request): Promise<AuthResult> {
  const challenge = verifyMfaChallenge(input.challengeToken);
  const attemptsKey = `mfa_attempts:${sha256Hex(input.challengeToken).slice(0, 16)}`;
  const attempts = await cache.incr(attemptsKey, MFA_CHALLENGE_TTL_MS);
  if (attempts > env.MFA_MAX_ATTEMPTS) {
    throw AppError.unauthorized('mfa_attempts_exhausted', 'Too many MFA attempts; please login again');
  }
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [challenge.userId]);
  const row = result.rows[0];
  if (!row || !row.mfa_enabled) throw AppError.unauthorized('mfa_not_enabled', 'MFA is not enabled');

  let ok = false;
  let usedRecovery = false;
  if (input.code) {
    const secret = decryptAtRest(row.mfa_secret_encrypted as string);
    ok = verifyTotp(secret, input.code);
  } else if (input.recoveryCode) {
    const normalized = normalizeRecoveryCode(input.recoveryCode);
    const codes = await pool.query(
      'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [challenge.userId],
    );
    for (const codeRow of codes.rows) {
      if (verifyHash(codeRow.code_hash as string, normalized)) {
        // B3: transparently upgrade a v1 recovery-code hash before consuming it.
        await rehashIfStale('recovery_codes', 'code_hash', challenge.userId, codeRow.id as string, normalized);
        await pool.query('UPDATE recovery_codes SET used_at = now() WHERE id = $1', [codeRow.id]);
        ok = true;
        usedRecovery = true;
        break;
      }
    }
  }

  if (!ok) {
    await recordAudit({
      action: 'auth.mfa_failed',
      actorUserId: challenge.userId,
      scope: 'USER',
      tenantId: challenge.userId,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      correlationId: req.ctx?.correlationId ?? null,
    });
    throw AppError.unauthorized('mfa_failed', 'MFA verification failed');
  }

  const created = await createSessionForUser(challenge.userId, req);
  await recordAudit({
    action: usedRecovery ? AuditAction.AUTH_RECOVERY_USED : AuditAction.AUTH_LOGIN,
    actorUserId: challenge.userId,
    scope: 'USER',
    tenantId: challenge.userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: usedRecovery ? { via: 'recovery_code' } : undefined,
  });
  return { user: toAuthUser(row), sessionToken: created.token, sessionId: created.sessionId };
}

export async function logout(userId: string, sessionId: string, req: Request): Promise<void> {
  await pool.query(`UPDATE sessions SET state = 'REVOKED', revoked_at = now() WHERE id = $1 AND user_id = $2`, [
    sessionId,
    userId,
  ]);
  await recordAudit({
    action: AuditAction.AUTH_LOGOUT,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
  });
}

export async function getUserById(userId: string): Promise<AuthUser> {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  if (!row) throw AppError.notFound('User');
  return toAuthUser(row);
}

export async function updateProfile(userId: string, input: { displayName?: string | null; role?: string | null; primaryUseCase?: string | null }): Promise<AuthUser> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.displayName !== undefined) {
    const displayName = input.displayName === null ? null : String(input.displayName).trim().slice(0, 80);
    if (displayName !== null && displayName.length < 2) {
      throw AppError.badRequest('display_name_short', 'Display name must be at least 2 characters');
    }
    sets.push(`display_name = $${params.length + 1}`);
    params.push(displayName);
  }
  if (input.role !== undefined) {
    const role = input.role === null ? null : String(input.role).trim();
    if (role !== null && !ONBOARDING_ROLES.includes(role)) {
      throw AppError.badRequest('invalid_role', `role must be one of: ${ONBOARDING_ROLES.join(', ')}`);
    }
    sets.push(`role = $${params.length + 1}`);
    params.push(role);
  }
  if (input.primaryUseCase !== undefined) {
    const primaryUseCase = input.primaryUseCase === null ? null : String(input.primaryUseCase).trim();
    if (primaryUseCase !== null && !ONBOARDING_USE_CASES.includes(primaryUseCase)) {
      throw AppError.badRequest('invalid_use_case', `primaryUseCase must be one of: ${ONBOARDING_USE_CASES.join(', ')}`);
    }
    sets.push(`primary_use_case = $${params.length + 1}`);
    params.push(primaryUseCase);
  }
  if (sets.length) {
    params.push(userId);
    await pool.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  return getUserById(userId);
}

export async function listSessions(userId: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT id, ip, user_agent, state, created_at, last_seen_at, expires_at FROM sessions
     WHERE user_id = $1 ORDER BY last_seen_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function revokeSession(userId: string, sessionId: string, req?: Request): Promise<void> {
  const result = await pool.query(
    `UPDATE sessions SET state = 'REVOKED', revoked_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
    [sessionId, userId],
  );
  if (!result.rows[0]) throw AppError.notFound('Session');
  await recordAudit({
    action: AuditAction.SESSION_REVOKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'session',
    resourceId: sessionId,
    ip: req?.ip ?? null,
    userAgent: req?.headers['user-agent'] ?? null,
    correlationId: req?.ctx?.correlationId ?? null,
  });
}

// ---------------------------------------------------------------- MFA setup

export async function setupMfa(userId: string): Promise<{ secretOtpAuthUrl: string; secretBase32: string }> {
  const secret = totpSecret();
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = result.rows[0]?.email ?? 'user';
  await pool.query('UPDATE users SET mfa_secret_encrypted = $1 WHERE id = $2', [
    encryptAtRest(secret),
    userId,
  ]);
  return {
    secretOtpAuthUrl: totpUrl(secret, email, env.AUTH_ISSUER),
    secretBase32: secret,
  };
}

export async function confirmMfa(userId: string, code: string, req: Request): Promise<{ recoveryCodes: string[]; sessionToken: string }> {
  const result = await pool.query('SELECT mfa_secret_encrypted FROM users WHERE id = $1', [userId]);
  const encrypted = result.rows[0]?.mfa_secret_encrypted;
  if (!encrypted) throw AppError.badRequest('mfa_not_setup', 'MFA setup was not started');
  const secret = decryptAtRest(encrypted);
  if (!verifyTotp(secret, code)) throw AppError.badRequest('mfa_code_invalid', 'Invalid TOTP code');

  const recoveryCodes = generateRecoveryCodes(env.RECOVERY_CODE_COUNT);
  const codesHash = hashSecret(recoveryCodes.join('\n'), 16);
  await pool.query(
    `UPDATE users SET mfa_enabled = true, recovery_codes_hash = $1 WHERE id = $2`,
    [codesHash, userId],
  );
  await withTenant(userId, async (q) => {
    for (const code of recoveryCodes) {
      await q.query('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1,$2,$3)', [
        newId(PREFIX.USER), // arbitrary id prefix is fine for recovery rows
        userId,
        hashSecret(code, 16),
      ]);
    }
  });
  await recordAudit({
    action: AuditAction.AUTH_MFA_ENABLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
  });
  // Privilege change: rotate every session; only the fresh session survives.
  const sessionToken = await rotateSessionsAfterPrivilegeChange(userId, req.ctx?.sessionId ?? null, req);
  return { recoveryCodes, sessionToken };
}

export async function disableMfa(userId: string, code: string, req?: Request): Promise<{ sessionToken: string } | null> {
  const result = await pool.query('SELECT mfa_secret_encrypted FROM users WHERE id = $1', [userId]);
  const encrypted = result.rows[0]?.mfa_secret_encrypted;
  if (!encrypted) throw AppError.badRequest('mfa_not_enabled', 'MFA is not enabled');
  const secret = decryptAtRest(encrypted);
  if (!verifyTotp(secret, code)) throw AppError.badRequest('mfa_code_invalid', 'Invalid TOTP code');
  await pool.query(
    `UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL, recovery_codes_hash = NULL WHERE id = $1`,
    [userId],
  );
  await withTenant(userId, async (q) => {
    await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
  });
  await recordAudit({
    action: AuditAction.AUTH_MFA_DISABLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req?.ip ?? null,
    userAgent: req?.headers['user-agent'] ?? null,
    correlationId: req?.ctx?.correlationId ?? null,
  });
  // Privilege change: rotate every session so no old session outlives the change.
  if (!req) return null;
  const sessionToken = await rotateSessionsAfterPrivilegeChange(userId, req.ctx?.sessionId ?? null, req);
  return { sessionToken };
}

export async function rotateRecoveryCodes(userId: string, code: string, req?: Request): Promise<string[]> {
  const result = await pool.query('SELECT mfa_secret_encrypted FROM users WHERE id = $1', [userId]);
  const encrypted = result.rows[0]?.mfa_secret_encrypted;
  if (!encrypted) throw AppError.badRequest('mfa_not_enabled', 'MFA is not enabled');
  if (!verifyTotp(decryptAtRest(encrypted), code)) {
    throw AppError.badRequest('mfa_code_invalid', 'Invalid TOTP code');
  }
  const recoveryCodes = generateRecoveryCodes(env.RECOVERY_CODE_COUNT);
  await withTenant(userId, async (q) => {
    await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const recoveryCode of recoveryCodes) {
      await q.query('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1,$2,$3)', [
        newId(PREFIX.USER),
        userId,
        hashSecret(recoveryCode, 16),
      ]);
    }
  });
  await pool.query(
    `UPDATE users SET recovery_codes_hash = $1 WHERE id = $2`,
    [hashSecret(recoveryCodes.join('\n'), 16), userId],
  );
  await recordAudit({
    action: AuditAction.AUTH_MFA_RECOVERY_ROTATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req?.ip ?? null,
    userAgent: req?.headers['user-agent'] ?? null,
    correlationId: req?.ctx?.correlationId ?? null,
  });
  return recoveryCodes;
}

// ---------------------------------------------------------------- devices (pairing)

export const MAX_PAIRED_DEVICES = 3;

export async function createDevice(userId: string, name: string): Promise<{ deviceId: string; pairingCode: string; expiresInSeconds: number }> {
  const count = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND state = 'PAIRED'`,
    [userId],
  );
  if ((count.rows[0]?.n ?? 0) >= MAX_PAIRED_DEVICES) {
    throw AppError.badRequest('device_limit_reached', `Maximum ${MAX_PAIRED_DEVICES} paired devices allowed`);
  }
  const pairingCode = String(100000 + randomInt(0, 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const deviceId = newId(PREFIX.DEVICE);
  await pool.query(
    `INSERT INTO devices (id, user_id, name, pairing_code_hash, state)
     VALUES ($1,$2,$3,$4,'PENDING_PAIRING')`,
    [deviceId, userId, name, `${hashSecret(pairingCode, 16)}$${expiresAt}`],
  );
  return { deviceId, pairingCode, expiresInSeconds: 600 };
}

/**
 * Verify a pairing code; optionally mint the device token for /agent WS auth.
 * The raw token is returned exactly once; only its SHA-256 is stored.
 */
export async function verifyDevicePairing(userId: string, deviceId: string, code: string, opts?: { grantToken?: boolean }): Promise<{ token?: string }> {
  const result = await pool.query(
    'SELECT pairing_code_hash, state, failed_pairing_attempts FROM devices WHERE id = $1 AND user_id = $2',
    [deviceId, userId],
  );
  const row = result.rows[0];
  if (!row || row.state !== 'PENDING_PAIRING') throw AppError.badRequest('device_not_pending', 'Device is not awaiting pairing');
  if ((row.failed_pairing_attempts as number) >= 5) {
    throw AppError.badRequest('pairing_attempts_exhausted', 'Too many failed pairing attempts; create a new device');
  }
  // pairing_code_hash = `scrypt$v1$${salt}$${hash}$${expiresAtMs}` (5 segments).
  const parts = (row.pairing_code_hash as string).split('$');
  const storedHash = [parts[0], parts[1], parts[2], parts[3]].join('$');
  const expiresAt = Number(parts[4]);
  if (parts.length !== 5 || !parts[3] || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw AppError.badRequest('pairing_code_expired', 'Pairing code expired (10-minute limit)');
  }
  if (!verifyHash(storedHash, code)) {
    await pool.query('UPDATE devices SET failed_pairing_attempts = failed_pairing_attempts + 1 WHERE id = $1', [deviceId]);
    throw AppError.badRequest('pairing_code_invalid', 'Invalid pairing code');
  }
  const rawToken = opts?.grantToken ? randomToken(32) : undefined;
  await pool.query(
    `UPDATE devices SET state = 'PAIRED', paired_at = now(), pairing_code_hash = NULL,
            failed_pairing_attempts = 0, last_seen_at = now(), token_hash = $2
     WHERE id = $1`,
    [deviceId, rawToken ? sha256Hex(rawToken) : null],
  );
  await recordAudit({
    action: AuditAction.DEVICE_PAIRED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'device',
    resourceId: deviceId,
  });
  return rawToken ? { token: rawToken } : {};
}

export async function listDevices(userId: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT id, name, state, paired_at, last_seen_at, created_at, capabilities FROM devices
     WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function revokeDevice(userId: string, deviceId: string, req?: Request): Promise<void> {
  const result = await pool.query(
    `UPDATE devices SET state = 'REVOKED', revoked_at = now(), pairing_code_hash = NULL, token_hash = NULL
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [deviceId, userId],
  );
  if (!result.rows[0]) throw AppError.notFound('Device');
  // Device revocation cascades to every session created from that device.
  await pool.query(
    `UPDATE sessions SET state = 'REVOKED', revoked_at = now() WHERE device_id = $1 AND state = 'ACTIVE'`,
    [deviceId],
  );
  // Immediate revocation: drop a live agent socket so nothing keeps executing.
  const { agentWs } = await import('../agent/ws.js');
  agentWs().disconnectDevice(userId, deviceId);
  await recordAudit({
    action: AuditAction.DEVICE_REVOKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'device',
    resourceId: deviceId,
    ip: req?.ip ?? null,
    userAgent: req?.headers['user-agent'] ?? null,
    correlationId: req?.ctx?.correlationId ?? null,
  });
}

export function applyAuthResponse(res: Response, result: AuthResult): void {
  setSessionCookie(res, result.sessionToken);
}

export { logger };