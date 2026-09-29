/**
 * CodeConClave — Identity (D1/D5): handle + keyword authentication, and the
 * optional Security Key second factor.
 *
 * Design constraints honoured here:
 *  - `users` is FROZEN. Nothing in this module writes users.email, its unique
 *    index, or any other identity column. All new state lives in
 *    user_auth_identities (migration 0133).
 *  - `users.email` stays unique and stays the contact label. The NEW primary
 *    login identifier is `handle`.
 *  - The keyword is stored only as a scrypt hash. It is never logged, never
 *    returned, and never placed in a URL.
 *  - Anti-enumeration: every externally observable failure for a credential
 *    problem is byte-identical (same status, code, message), and an unknown
 *    handle performs the same number of hash operations as a wrong keyword so
 *    timing does not leak account existence.
 *  - TOTP is untouched. The Security Key is an ALTERNATIVE second factor, not
 *    an additional requirement. A user has none, TOTP, a Security Key, or both;
 *    when both are present the user's `preferred_mfa` decides which one is
 *    demanded — never both.
 */
import crypto from 'node:crypto';
import { pool, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { hashSecret, verifyHash, needsRehash, rehashSecret, decryptAtRest, normalizeRecoveryCode, verifyTotp } from '../../shared/crypto.js';
import { cache } from '../../shared/cache.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import type { Request } from 'express';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { incMetric } from '../../observability/metrics.js';
import { createSessionForUser, deviceForRequest, hookSuspiciousSession, rehashRecoveryCodeIfStale } from './service.js';
import { normalizeHandle, validateHandle, validateKeyword } from './identity-policy.js';

const KEYWORD_MIN = 12;
const KEYWORD_MAX = 128;
const HANDLE_MIN = 3;
const HANDLE_MAX = 20;
const RECOVERY_TOKEN_TTL_MIN = 15;
const SECURITY_KEY_CHARS = 32;

/** Unambiguous alphabet: no O/0, I/l/1. 32 chars from 32 symbols = 160 bits. */
const SECURITY_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- helpers

/**
 * Handle + keyword policy lives in identity-policy.ts so registration
 * (auth/service.ts) and this module share one source of truth without an
 * import cycle. Re-exported here because they are part of this module's API.
 */
export { normalizeHandle, validateHandle, validateKeyword } from './identity-policy.js';

/** Uniform CSPRNG draw from the unambiguous alphabet (no modulo bias). */
function randomSecurityKey(): string {
  const out: string[] = [];
  const max = Math.floor(256 / SECURITY_KEY_ALPHABET.length) * SECURITY_KEY_ALPHABET.length;
  while (out.length < SECURITY_KEY_CHARS) {
    for (const byte of crypto.randomBytes(SECURITY_KEY_CHARS)) {
      if (byte >= max) continue; // rejection sampling
      out.push(SECURITY_KEY_ALPHABET[byte % SECURITY_KEY_ALPHABET.length]!);
      if (out.length === SECURITY_KEY_CHARS) break;
    }
  }
  return out.join('');
}

export function generateSecurityKey(): string {
  return randomSecurityKey();
}

export function isWellFormedSecurityKey(key: string): boolean {
  return new RegExp(`^[${SECURITY_KEY_ALPHABET}]{${SECURITY_KEY_CHARS}}$`).test(key.trim().toUpperCase());
}

// ---------------------------------------------------------------- rate limits

/**
 * Per-identifier attempt limiter for credential endpoints. Deliberately shared
 * by login, keyword recovery, and Security Key challenge so an attacker cannot
 * spread guesses across endpoints to multiply the attempt budget.
 */
async function consumeAttempt(bucket: string, identifier: string, max: number, windowMs: number): Promise<number> {
  // cache.incr sets the TTL on first increment, so the window is fixed at the
  // first attempt and cannot be extended by hammering the endpoint.
  return cache.incr(`authid:${bucket}:${identifier}`, windowMs);
}

function genericAuthFailure(): AppError {
  // ONE canonical credential failure. Every path that could leak whether an
  // account exists returns exactly this.
  return AppError.unauthorized('invalid_credentials', 'Sign-in details are incorrect');
}

function genericRecoveryFailure(): AppError {
  return AppError.badRequest('recovery_failed', 'Recovery could not be completed. Check your details and try again.');
}

function fingerprint(identifier: string): string {
  return crypto.createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------- enrollment

export interface EnrolledIdentity {
  userId: string;
  handle: string;
  hasKeyword: boolean;
  securityKeyEnabled: boolean;
  preferredMfa: 'none' | 'totp' | 'security_key';
}

/** Read the auth identity for a user, if enrolled. */
export async function getIdentity(userId: string): Promise<EnrolledIdentity | null> {
  const result = await pool.query(
    `SELECT user_id, handle, keyword_hash, security_key_hash, security_key_enabled, preferred_mfa
       FROM user_auth_identities WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    handle: row.handle,
    hasKeyword: !!row.keyword_hash,
    securityKeyEnabled: !!row.security_key_enabled && !!row.security_key_hash,
    preferredMfa: row.preferred_mfa,
  };
}

/**
 * Enroll a handle + keyword for an EXISTING account. This is the migration
 * path: legacy password, OTP, and Google OAuth users all call this, and no
 * account loses access because the old credential keeps working until a
 * keyword is set.
 */
export async function enrollIdentity(
  userId: string,
  input: { handle: string; keyword: string },
): Promise<{ handle: string }> {
  const handle = validateHandle(input.handle);
  const keyword = validateKeyword(input.keyword);

  const taken = await pool.query(
    'SELECT 1 FROM user_auth_identities WHERE lower(handle) = $1 AND deleted_at IS NULL AND user_id <> $2',
    [handle, userId],
  );
  if (taken.rows[0]) throw AppError.conflict('handle_taken', 'That handle is not available');

  const keywordHash = hashSecret(keyword);
  await pool.query(
    `INSERT INTO user_auth_identities (id, user_id, handle, keyword_hash, preferred_mfa, keyword_changed_at)
     VALUES ($1,$2,$3,$4,'none', now())
     ON CONFLICT (user_id) DO UPDATE
       SET handle = EXCLUDED.handle,
           keyword_hash = EXCLUDED.keyword_hash,
           keyword_changed_at = now(),
           updated_at = now()`,
    [newId(PREFIX.AUTH_IDENTITY), userId, handle, keywordHash],
  );

  await recordAudit({
    action: AuditAction.AUTH_IDENTITY_ENROLLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    detail: { handle },
  });
  return { handle };
}

/** Create the identity for a brand-new account during registration. */
export async function createIdentityForUser(
  userId: string,
  input: { handle: string; keyword: string },
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
): Promise<{ handle: string }> {
  const handle = validateHandle(input.handle);
  const keyword = validateKeyword(input.keyword);
  const keywordHash = hashSecret(keyword);
  await client.query(
    `INSERT INTO user_auth_identities (id, user_id, handle, keyword_hash, preferred_mfa, keyword_changed_at)
     VALUES ($1,$2,$3,$4,'none', now())`,
    [newId(PREFIX.AUTH_IDENTITY), userId, handle, keywordHash],
  );
  return { handle };
}

// ---------------------------------------------------------------- login

export type IdentityLoginResult =
  | { kind: 'authenticated'; userId: string; sessionToken: string; sessionId: string }
  | { kind: 'mfa_required'; method: 'totp' | 'security_key'; challengeToken: string; userId: string };

/**
 * Primary login path: handle + keyword.
 *
 * Anti-enumeration: when the handle is unknown we still perform a scrypt
 * verification against a fixed dummy hash, so response time and status are
 * indistinguishable from a wrong keyword.
 */
export async function loginWithKeyword(
  input: { handle: string; keyword: string },
  req: Request,
): Promise<IdentityLoginResult> {
  const handle = normalizeHandle(input.handle);
  const fp = fingerprint(handle);
  const attempts = await consumeAttempt('login', fp, 20, 15 * 60 * 1000);
  if (attempts > 20) {
    throw AppError.tooMany('rate_limited', 'Too many attempts. Please wait and try again.');
  }

  const result = await pool.query(
    `SELECT i.user_id, i.keyword_hash, i.security_key_enabled, i.security_key_hash, i.preferred_mfa,
            u.mfa_enabled
       FROM user_auth_identities i
       JOIN users u ON u.id = i.user_id AND u.deleted_at IS NULL
      WHERE lower(i.handle) = $1 AND i.deleted_at IS NULL`,
    [handle],
  );
  const row = result.rows[0];

  if (!row?.keyword_hash) {
    // Burn equivalent CPU so timing does not reveal existence.
    verifyHash(DUMMY_KEYWORD_HASH, input.keyword);
    throw genericAuthFailure();
  }

  if (!verifyHash(row.keyword_hash as string, input.keyword)) {
    incMetric('security.auth_failures');
    throw genericAuthFailure();
  }

  // B3: the keyword is presented in plaintext here and only here, so this is
  // the one place a legacy scrypt v1 keyword hash can be transparently upgraded
  // to the current v2 parameters. Never fatal: a failed upgrade must not deny
  // an otherwise valid sign-in.
  if (needsRehash(row.keyword_hash as string)) {
    await pool
      .query(
        `UPDATE user_auth_identities SET keyword_hash = $1, updated_at = now() WHERE user_id = $2`,
        [rehashSecret(row.keyword_hash as string, input.keyword), row.user_id],
      )
      .then(() => incMetric('auth.hash_upgraded'))
      .catch((err) => logger.warn('keyword rehash-upgrade failed', { userId: row.user_id, error: (err as Error).message }));
  }

  return finishIdentityLogin(row.user_id as string, row, req);
}

/**
 * Shared post-credential step. Decides whether a second factor is demanded and
 * which one: `preferred_mfa` picks between TOTP and Security Key so a user who
 * enabled both is never asked for both.
 */
async function finishIdentityLogin(
  userId: string,
  row: Record<string, unknown>,
  req: Request,
): Promise<IdentityLoginResult> {
  const totpEnabled = !!row.mfa_enabled;
  const securityKeyEnabled = !!row.security_key_enabled && !!row.security_key_hash;
  const preferred = (row.preferred_mfa as 'none' | 'totp' | 'security_key') ?? 'none';

  let method: 'totp' | 'security_key' | null = null;
  if (totpEnabled && securityKeyEnabled) {
    method = preferred === 'security_key' ? 'security_key' : 'totp';
  } else if (totpEnabled) {
    method = 'totp';
  } else if (securityKeyEnabled) {
    method = 'security_key';
  }

  if (method) {
    return { kind: 'mfa_required', method, challengeToken: createIdentityMfaChallenge(userId, method), userId };
  }

  const created = await createSessionForUser(userId, req, await deviceForRequest(userId, req));
  await recordAudit({
    action: AuditAction.AUTH_LOGIN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { via: 'keyword' },
  });
  await hookSuspiciousSession(userId, created.sessionId, req).catch((err) => {
    logger.warn('suspicious-session hook failed', { error: (err as Error).message });
  });
  return { kind: 'authenticated', userId, sessionToken: created.token, sessionId: created.sessionId };
}

// A fixed, valid scrypt hash used only to equalize timing on unknown handles.
const DUMMY_KEYWORD_HASH = hashSecret('dummy-keyword-for-constant-time-lookup');

// ---------------------------------------------------------------- security key 2FA

const IDENTITY_MFA_TTL_MS = 10 * 60 * 1000;

export function createIdentityMfaChallenge(userId: string, method: 'totp' | 'security_key'): string {
  const payload = { userId, method, nonce: crypto.randomBytes(12).toString('hex'), exp: Date.now() + IDENTITY_MFA_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', env.JWT_SECRET).update(`identity-mfa:${body}`).digest('base64url');
  return `imfa_${body}.${sig}`;
}

/**
 * Burn a challenge nonce so a captured `imfa_…` token cannot be replayed.
 *
 * `cache.incr` is the single-use primitive already available on both stores and
 * it is ATOMIC on each: Redis INCR and the synchronous memory store both return
 * 1 to exactly one caller, and >1 to every later one. A get-then-set would race
 * and let two concurrent replays both win. The TTL is the challenge's REMAINING
 * lifetime, never a fresh window, so the mark can never outlive the token it
 * protects.
 *
 * A store outage throws. That is deliberately fatal: an unverifiable challenge
 * must not be treated as a fresh one.
 */
async function consumeMfaChallenge(nonce: string, remainingTtlMs: number): Promise<void> {
  const uses = await cache.incr(`authid:mfa-challenge:${nonce}`, Math.max(remainingTtlMs, 1));
  if (uses > 1) {
    throw AppError.unauthorized('mfa_challenge_replayed', 'This verification has already been used');
  }
}

/**
 * Verify a challenge AND burn it. Both MFA completion paths go through here, so
 * a token is good for exactly one verification attempt ever, not for its whole
 * 10-minute window. Burned before the second factor is checked: a wrong TOTP
 * code must not leave the challenge reusable, or a leaked token plus a code
 * guessed later still lands.
 */
export async function verifyIdentityMfaChallenge(
  token: string,
): Promise<{ userId: string; method: 'totp' | 'security_key' }> {
  const match = /^imfa_([^.]+)\.([^.]+)$/.exec(token);
  if (!match) throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid verification challenge');
  const [, body, sig] = match;
  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(`identity-mfa:${body}`).digest('base64url');
  const a = Buffer.from(sig ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid verification challenge');
  }
  let payload: { userId: string; method: 'totp' | 'security_key'; nonce: string; exp: number };
  try {
    payload = JSON.parse(Buffer.from(body!, 'base64url').toString()) as typeof payload;
  } catch {
    throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid verification challenge');
  }
  if (!payload?.nonce || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
    throw AppError.unauthorized('mfa_challenge_expired', 'Verification expired');
  }
  await consumeMfaChallenge(payload.nonce, payload.exp - Date.now());
  return { userId: payload.userId, method: payload.method };
}

/**
 * Begin Security Key enrollment. The plaintext key is returned exactly once,
 * in the response, and only its hash is persisted. The caller must confirm with
 * `confirmSecurityKey` using a paste-back, which is why this is two-phase.
 */
export async function beginSecurityKeyEnrollment(
  userId: string,
  preferredMfa: 'totp' | 'security_key',
): Promise<{ securityKey: string }> {
  const identity = await pool.query('SELECT id FROM user_auth_identities WHERE user_id = $1', [userId]);
  if (!identity.rows[0]) throw AppError.notFound('Identity not enrolled');
  const securityKey = randomSecurityKey();
  await pool.query(
    `UPDATE user_auth_identities
        SET security_key_hash = $1, security_key_enabled = false,
            security_key_created_at = now(), preferred_mfa = $2, updated_at = now()
      WHERE user_id = $3`,
    [hashSecret(securityKey), preferredMfa, userId],
  );
  return { securityKey };
}

/** Confirm enrollment by pasting the key back; enables the second factor. */
export async function confirmSecurityKey(userId: string, securityKey: string): Promise<{ enabled: true }> {
  const normalized = securityKey.trim().toUpperCase();
  if (!isWellFormedSecurityKey(normalized)) {
    throw AppError.badRequest('invalid_security_key', 'Security key format is not recognised');
  }
  const row = await pool.query('SELECT security_key_hash FROM user_auth_identities WHERE user_id = $1', [userId]);
  const stored = row.rows[0]?.security_key_hash as string | undefined;
  if (!stored || !verifyHash(stored, normalized)) {
    throw AppError.badRequest('security_key_mismatch', 'Security key did not match');
  }
  await pool.query(
    `UPDATE user_auth_identities
        SET security_key_enabled = true, security_key_revoked_at = NULL, updated_at = now()
      WHERE user_id = $1`,
    [userId],
  );
  await recordAudit({
    action: AuditAction.AUTH_SECURITY_KEY_ENABLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    detail: { method: 'security_key' },
  });
  return { enabled: true };
}

/** Disable the Security Key, keeping TOTP untouched. */
export async function disableSecurityKey(userId: string): Promise<{ disabled: true }> {
  const row = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [userId]);
  const totpEnabled = !!row.rows[0]?.mfa_enabled;
  await pool.query(
    `UPDATE user_auth_identities
        SET security_key_enabled = false, security_key_hash = NULL,
            security_key_revoked_at = now(),
            preferred_mfa = CASE WHEN $2 THEN 'totp' ELSE 'none' END,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, totpEnabled],
  );
  await recordAudit({
    action: AuditAction.AUTH_SECURITY_KEY_DISABLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
  });
  return { disabled: true };
}

/**
 * Complete a TOTP challenge issued by `loginWithKeyword` and open a session.
 *
 * Bug fix: handle+keyword login could return an `imfa_...` challenge when the
 * user's only (or preferred) second factor is TOTP, but the only completion
 * route was `/mfa/verify`, which validates a legacy `mfa_...` token. A TOTP
 * identity user therefore had no way to finish signing in — the challenge was a
 * dead end. This is the matching verifier: it accepts the identity challenge,
 * keeps TOTP verification and legacy recovery codes exactly as they are (TOTP is
 * untouched by D2), and issues the same normal, audited session.
 */
export async function completeIdentityTotpChallenge(
  token: string,
  input: { code?: string; recoveryCode?: string },
  req: Request,
): Promise<{ sessionToken: string; sessionId: string; userId: string; via: 'totp' | 'recovery_code' }> {
  const challenge = await verifyIdentityMfaChallenge(token);
  if (challenge.method !== 'totp') {
    throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid verification challenge');
  }
  const attempts = await consumeAttempt('identity_totp', fingerprint(challenge.userId), 10, 15 * 60 * 1000);
  if (attempts > 10) {
    throw AppError.tooMany('rate_limited', 'Too many attempts. Please wait and try again.');
  }

  const result = await pool.query(
    'SELECT id, email, mfa_enabled, mfa_secret_encrypted FROM users WHERE id = $1 AND deleted_at IS NULL',
    [challenge.userId],
  );
  const row = result.rows[0];
  if (!row || !row.mfa_enabled) throw AppError.unauthorized('mfa_not_enabled', 'MFA is not enabled');

  let ok = false;
  let via: 'totp' | 'recovery_code' = 'totp';
  if (input.code) {
    ok = verifyTotp(decryptAtRest(row.mfa_secret_encrypted as string), String(input.code).trim());
  } else if (input.recoveryCode) {
    const normalized = normalizeRecoveryCode(String(input.recoveryCode));
    const codes = await pool.query(
      'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [challenge.userId],
    );
    for (const codeRow of codes.rows) {
      if (verifyHash(codeRow.code_hash as string, normalized)) {
        // B3: transparently upgrade a v1 recovery-code hash before consuming it.
        await rehashRecoveryCodeIfStale(codeRow.id as string, normalized);
        await pool.query('UPDATE recovery_codes SET used_at = now() WHERE id = $1', [codeRow.id]);
        ok = true;
        via = 'recovery_code';
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
      detail: { via: 'identity_totp' },
    });
    throw AppError.unauthorized('mfa_failed', 'MFA verification failed');
  }

  const created = await createSessionForUser(challenge.userId, req, await deviceForRequest(challenge.userId, req));
  await recordAudit({
    action: via === 'recovery_code' ? AuditAction.AUTH_RECOVERY_USED : AuditAction.AUTH_LOGIN,
    actorUserId: challenge.userId,
    scope: 'USER',
    tenantId: challenge.userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: via === 'recovery_code' ? { via: 'recovery_code' } : { via: 'identity_totp' },
  });
  await hookSuspiciousSession(challenge.userId, created.sessionId, req).catch((err) => {
    logger.warn('suspicious-session hook failed', { error: (err as Error).message });
  });
  return { sessionToken: created.token, sessionId: created.sessionId, userId: challenge.userId, via };
}

/** Complete a Security Key challenge and open a session. */
export async function completeSecurityKeyChallenge(
  token: string,
  securityKey: string,
  req: Request,
): Promise<{ sessionToken: string; sessionId: string; userId: string }> {
  const challenge = await verifyIdentityMfaChallenge(token);
  if (challenge.method !== 'security_key') {
    throw AppError.unauthorized('mfa_challenge_invalid', 'Invalid verification challenge');
  }
  const normalized = securityKey.trim().toUpperCase();
  const attempts = await consumeAttempt('security_key', fingerprint(challenge.userId), 10, 15 * 60 * 1000);
  if (attempts > 10) {
    throw AppError.tooMany('rate_limited', 'Too many attempts. Please wait and try again.');
  }

  const row = await pool.query(
    'SELECT security_key_hash, security_key_enabled FROM user_auth_identities WHERE user_id = $1',
    [challenge.userId],
  );
  const stored = row.rows[0]?.security_key_hash as string | undefined;
  if (!row.rows[0]?.security_key_enabled || !stored || !verifyHash(stored, normalized)) {
    throw AppError.unauthorized('invalid_credentials', 'Verification details are incorrect');
  }

  const created = await createSessionForUser(challenge.userId, req, await deviceForRequest(challenge.userId, req));
  await recordAudit({
    action: AuditAction.AUTH_LOGIN,
    actorUserId: challenge.userId,
    scope: 'USER',
    tenantId: challenge.userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { via: 'security_key' },
  });
  await hookSuspiciousSession(challenge.userId, created.sessionId, req).catch((err) => {
    logger.warn('suspicious-session hook failed', { error: (err as Error).message });
  });
  return { sessionToken: created.token, sessionId: created.sessionId, userId: challenge.userId };
}

// ---------------------------------------------------------------- recovery

/**
 * Security-Key recovery: handle + security key -> short-lived, single-use,
 * hashed token. There is deliberately NO email-based password reset; a user who
 * loses both the keyword and the security key cannot be recovered, by design.
 */
export async function beginRecovery(
  input: { handle: string; securityKey: string },
): Promise<{ recoveryToken: string }> {
  const handle = normalizeHandle(input.handle);
  const fp = fingerprint(handle);
  const attempts = await consumeAttempt('recovery', fp, 8, 30 * 60 * 1000);
  if (attempts > 8) {
    throw AppError.tooMany('rate_limited', 'Too many attempts. Please wait and try again.');
  }

  const row = await pool.query(
    `SELECT user_id, security_key_hash, security_key_enabled
       FROM user_auth_identities WHERE lower(handle) = $1 AND deleted_at IS NULL`,
    [handle],
  );
  const rec = row.rows[0];
  if (!rec?.security_key_hash || !rec.security_key_enabled) {
    verifyHash(DUMMY_KEYWORD_HASH, input.securityKey);
    throw genericRecoveryFailure();
  }
  if (!verifyHash(rec.security_key_hash as string, input.securityKey.trim().toUpperCase())) {
    throw genericRecoveryFailure();
  }

  // Only one live recovery token per user at a time. The identity row is locked
  // FOR UPDATE so two concurrent `beginRecovery` calls cannot both pass the
  // "revoke the previous token" step and end up with two live PENDING tokens.
  const raw = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await withSystem(async (q) => {
    await q.query('SELECT user_id FROM user_auth_identities WHERE user_id = $1 FOR UPDATE', [rec.user_id]);
    await q.query(
      `UPDATE auth_recovery_tokens SET status = 'REVOKED', used_at = now()
        WHERE user_id = $1 AND status = 'PENDING'`,
      [rec.user_id],
    );
    await q.query(
      `INSERT INTO auth_recovery_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [newId(PREFIX.RECOVERY_TOKEN), rec.user_id, tokenHash, RECOVERY_TOKEN_TTL_MIN],
    );
  });
  await recordAudit({
    action: AuditAction.AUTH_RECOVERY_STARTED,
    actorUserId: rec.user_id,
    scope: 'USER',
    tenantId: rec.user_id,
    detail: { method: 'security_key' },
  });
  return { recoveryToken: raw };
}

/** Exchange a valid recovery token for a new keyword. Revokes all sessions. */
export async function completeRecovery(
  input: { recoveryToken: string; keyword: string },
  req: Request,
): Promise<{ userId: string; sessionToken: string; sessionId: string }> {
  const keyword = validateKeyword(input.keyword);
  const tokenHash = crypto.createHash('sha256').update(input.recoveryToken).digest('hex');
  const fp = fingerprint(tokenHash);

  const attempts = await consumeAttempt('recovery_token', fp, 10, 30 * 60 * 1000);
  if (attempts > 10) {
    throw AppError.tooMany('rate_limited', 'Too many attempts. Please wait and try again.');
  }

  // Atomically CLAIM the token. Bug fix: this used to be a SELECT followed by
  // separate UPDATEs, so two concurrent redemptions of the same token could both
  // observe status='PENDING' and both proceed — defeating single-use. The
  // status/expiry/attempt-cap test and the state change now happen in ONE
  // statement, so exactly one caller can ever win.
  const claim = await pool.query(
    `UPDATE auth_recovery_tokens
        SET attempts = attempts + 1, status = 'USED', used_at = now()
      WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > now() AND attempts < 5
      RETURNING id, user_id`,
    [tokenHash],
  );
  const token = claim.rows[0];
  if (!token) {
    // An exhausted token is burned so it cannot be retried later.
    await pool.query(
      `UPDATE auth_recovery_tokens SET status = 'REVOKED', used_at = now()
        WHERE token_hash = $1 AND status = 'PENDING' AND attempts >= 5`,
      [tokenHash],
    );
    verifyHash(DUMMY_KEYWORD_HASH, input.keyword);
    throw genericRecoveryFailure();
  }

  const keywordHash = hashSecret(keyword);
  await pool.query(
    `UPDATE user_auth_identities SET keyword_hash = $1, keyword_changed_at = now(), updated_at = now()
      WHERE user_id = $2`,
    [keywordHash, token.user_id],
  );
  await revokeAllSessions(token.user_id as string);

  const created = await createSessionForUser(token.user_id as string, req, null);
  await recordAudit({
    action: AuditAction.AUTH_KEYWORD_CHANGED,
    actorUserId: token.user_id,
    scope: 'USER',
    tenantId: token.user_id,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { via: 'recovery' },
  });
  return { userId: token.user_id as string, sessionToken: created.token, sessionId: created.sessionId };
}

// ---------------------------------------------------------------- credential changes

/** Change the keyword. Requires the current keyword; revokes all sessions. */
export async function changeKeyword(
  userId: string,
  input: { currentKeyword: string; newKeyword: string },
  req: Request,
): Promise<{ changed: true }> {
  const newKeyword = validateKeyword(input.newKeyword);
  const row = await pool.query(
    'SELECT keyword_hash FROM user_auth_identities WHERE user_id = $1',
    [userId],
  );
  const stored = row.rows[0]?.keyword_hash as string | undefined;
  if (!stored || !verifyHash(stored, input.currentKeyword)) {
    throw genericAuthFailure();
  }
  await pool.query(
    `UPDATE user_auth_identities SET keyword_hash = $1, keyword_changed_at = now(), updated_at = now()
      WHERE user_id = $2`,
    [hashSecret(newKeyword), userId],
  );
  await revokeAllSessions(userId);
  await recordAudit({
    action: AuditAction.AUTH_KEYWORD_CHANGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { via: 'change' },
  });
  return { changed: true };
}

/** Rotate the Security Key. The old key stops working immediately. */
export async function rotateSecurityKey(
  userId: string,
  currentKey: string,
  preferredMfa: 'totp' | 'security_key',
): Promise<{ securityKey: string }> {
  const row = await pool.query(
    'SELECT security_key_hash, security_key_enabled FROM user_auth_identities WHERE user_id = $1',
    [userId],
  );
  const stored = row.rows[0]?.security_key_hash as string | undefined;
  if (!stored || !verifyHash(stored, currentKey.trim().toUpperCase())) {
    throw AppError.badRequest('security_key_mismatch', 'Security key did not match');
  }
  const securityKey = randomSecurityKey();
  await pool.query(
    `UPDATE user_auth_identities
        SET security_key_hash = $1, security_key_enabled = false,
            security_key_created_at = now(), preferred_mfa = $2, updated_at = now()
      WHERE user_id = $3`,
    [hashSecret(securityKey), preferredMfa, userId],
  );
  await recordAudit({
    action: AuditAction.AUTH_SECURITY_KEY_ROTATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
  });
  return { securityKey };
}

/**
 * Theft report. Requires the current keyword so a session thief cannot use it
 * to lock the owner out, then revokes every session AND invalidates the
 * Security Key so the attacker loses the second factor too.
 */
export async function reportSecurityKeyTheft(
  userId: string,
  currentKeyword: string,
  req: Request,
): Promise<{ sessionsRevoked: number; securityKeyRevoked: boolean }> {
  const row = await pool.query('SELECT keyword_hash FROM user_auth_identities WHERE user_id = $1', [userId]);
  const stored = row.rows[0]?.keyword_hash as string | undefined;
  if (!stored || !verifyHash(stored, currentKeyword)) {
    throw genericAuthFailure();
  }
  const revoked = await revokeAllSessions(userId);
  const hadKey = await pool.query(
    'SELECT security_key_enabled FROM user_auth_identities WHERE user_id = $1',
    [userId],
  );
  await pool.query(
    `UPDATE user_auth_identities
        SET security_key_enabled = false, security_key_hash = NULL,
            security_key_revoked_at = now(), updated_at = now()
      WHERE user_id = $1`,
    [userId],
  );
  await recordAudit({
    action: AuditAction.AUTH_SECURITY_KEY_STOLEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
    detail: { sessionsRevoked: revoked, hadSecurityKey: !!hadKey.rows[0]?.security_key_enabled },
  });
  return { sessionsRevoked: revoked, securityKeyRevoked: true };
}

/** Revoke every active session for a user. Returns the number revoked. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE sessions SET state = 'REVOKED', revoked_at = now()
      WHERE user_id = $1 AND state = 'ACTIVE'`,
    [userId],
  );
  return result.rowCount ?? 0;
}
