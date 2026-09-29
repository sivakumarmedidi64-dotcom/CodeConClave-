/**
 * CodeConClave — passwordless email OTP authentication.
 * Security contract (matches the password rail — never weaker):
 * - codes are 6 CSPRNG digits; they are never stored, returned, or logged raw
 *   (only a scrypt password-grade hash persists, same primitive as passwords)
 * - single-use: consumption is an atomic PENDING -> USED transition
 * - expiry: 10 minutes, enforced server-side
 * - max 5 verification attempts per code (then revoked)
 * - resend cooldown 60s per email + hard caps per email and per IP (3 and 10
 *   per hour respectively) — all fail closed when the limit store is down
 * - issuing a new code revokes any still-active previous code
 * - MFA is never bypassed: enabled accounts enter the standard TOTP challenge
 * - every request/success/failure is audited; responses are anti-enumeration
 *   (identical behaviour for known and unknown addresses)
 * - delivery reuses the existing outbox -> Resend rail (never faked)
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { pool, withTenant } from '../../shared/db.js';
import { cache } from '../../shared/cache.js';
import { AppError } from '../../shared/errors.js';
import { hashSecret, verifyHash } from '../../shared/crypto.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { wrapEmailHtml } from '../email/brand.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { enqueueOutbox } from '../outbox/service.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, Timeouts } from '@codeconclave/shared';
import { createMfaChallenge, createSessionForUser, getUserById, hookSuspiciousSession } from './service.js';
import type { AuthResult } from './service.js';

export const OTP_TTL_MS = env.OTP_TTL_MINUTES * 60_000;
export const RESEND_MIN_INTERVAL_MS = Timeouts.OTP_RESEND_MIN_INTERVAL_MS;
export const MAX_SENDS_PER_HOUR = Timeouts.OTP_MAX_SENDS_PER_HOUR;
export const MAX_ATTEMPTS = Timeouts.OTP_MAX_ATTEMPTS;
export const IP_MAX_PER_HOUR = Timeouts.OTP_IP_MAX_PER_HOUR;

const HOUR_MS = 60 * 60 * 1000;
const GENERIC_INVALID = 'This code is invalid or has expired. Request a new one.';

export interface OtpRequestResult {
  sent: boolean;
  resendableAfterMs: number;
  expiresInSeconds: number;
}

interface OtpRow {
  id: string;
  email: string;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: Date;
}

export type OtpVerifyResult = AuthResult | { mfaRequired: true; challengeToken: string; userId: string };

function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// Rate-limit store access FAILS CLOSED for auth: a store outage must deny OTP
// issuance rather than silently disable brute-force protection.
async function cacheGetOrThrow(key: string): Promise<string | null> {
  try {
    return await cache.get(key);
  } catch {
    throw AppError.unavailable('rate_limit_unavailable', 'Sign-in is temporarily unavailable; try again shortly');
  }
}

async function cacheIncrOrThrow(key: string, ttlMs: number): Promise<number> {
  try {
    return await cache.incr(key, ttlMs);
  } catch {
    throw AppError.unavailable('rate_limit_unavailable', 'Sign-in is temporarily unavailable; try again shortly');
  }
}

async function cacheSetOrThrow(key: string, value: string, ttlMs: number): Promise<void> {
  try {
    await cache.set(key, value, ttlMs);
  } catch {
    throw AppError.unavailable('rate_limit_unavailable', 'Sign-in is temporarily unavailable; try again shortly');
  }
}

function auditBase(req: Request, userId: string | null) {
  return {
    scope: 'USER' as const,
    tenantId: userId ?? null,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.ctx?.correlationId ?? null,
  };
}

async function auditOtpFailure(userId: string | null, reason: string, req: Request): Promise<void> {
  await recordAudit({
    action: AuditAction.AUTH_OTP_FAILED,
    actorUserId: userId ?? null,
    resourceType: 'email_otp',
    detail: { reason },
    ...auditBase(req, userId),
  });
}

async function accountIdFor(email: string): Promise<string | null> {
  const result = await pool.query('SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [email]);
  return (result.rows[0]?.id as string | undefined) ?? null;
}

/**
 * Issue a one-time sign-in code. The response is identical for known and
 * unknown addresses (anti-enumeration); only the audit trail distinguishes.
 */
export async function requestOtp(input: { email: string }, req: Request): Promise<OtpRequestResult> {
  const email = input.email.trim().toLowerCase();

  // Per-email resend cooldown.
  const lastSent = await cacheGetOrThrow(`otp:last:${email}`);
  if (lastSent && Date.now() - Number(lastSent) < RESEND_MIN_INTERVAL_MS) {
    throw AppError.tooMany('otp_throttled', 'Try again shortly.');
  }

  // Hard caps: per email and per IP, both hourly.
  const hourCount = await cacheIncrOrThrow(`otp:email:${email}`, HOUR_MS);
  if (hourCount > MAX_SENDS_PER_HOUR) {
    throw AppError.tooMany('otp_rate_limited', 'Too many requests. Try again in an hour.');
  }
  const ipCount = await cacheIncrOrThrow(`otp:ip:${req.ip ?? 'unknown'}`, HOUR_MS);
  if (ipCount > IP_MAX_PER_HOUR) {
    throw AppError.tooMany('otp_ip_rate_limited', 'Too many requests from this network. Try again in an hour.');
  }

  const existingUserId = await accountIdFor(email);

  // A new code invalidates any still-active previous code.
  await pool.query(
    `UPDATE email_otps SET status = 'REVOKED', used_at = now() WHERE lower(email) = $1 AND status = 'PENDING'`,
    [email],
  );

  const code = generateOtpCode();
  await pool.query(
    `INSERT INTO email_otps (id, email, code_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' milliseconds')::interval)`,
    [newId(PREFIX.OTP), email, hashSecret(code), OTP_TTL_MS],
  );
  await cacheSetOrThrow(`otp:last:${email}`, String(Date.now()), HOUR_MS);

  await enqueueOutbox('auth.email_otp', {
    channel: 'email',
    to: email,
    userId: existingUserId ?? undefined,
    subject: 'Your CodeConClave sign-in code',
    html: wrapEmailHtml(
      'Sign in to CodeConClave',
      `<p>Your one-time sign-in code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#111">${code}</p>
<p class="cc-muted">This code expires in 10 minutes and can only be used once. If you did not request it, you can safely ignore this email.</p>`,
    ),
  });

  await recordAudit({
    action: AuditAction.AUTH_OTP_REQUESTED,
    actorUserId: existingUserId ?? null,
    resourceType: 'email_otp',
    detail: { expiresInSeconds: OTP_TTL_MS / 1000 },
    ...auditBase(req, existingUserId),
  });

  logger.info('otp requested', { email, expiresInSeconds: OTP_TTL_MS / 1000 });
  return { sent: true, resendableAfterMs: RESEND_MIN_INTERVAL_MS, expiresInSeconds: OTP_TTL_MS / 1000 };
}

async function revokeOtp(id: string): Promise<void> {
  await pool.query(`UPDATE email_otps SET status = 'REVOKED', used_at = now() WHERE id = $1 AND status = 'PENDING'`, [id]);
}

async function failGeneric(reason: string, req: Request, email: string): Promise<never> {
  const existingUserId = await accountIdFor(email);
  await auditOtpFailure(existingUserId, reason, req);
  throw AppError.badRequest('otp_invalid', GENERIC_INVALID);
}

/**
 * Consume an OTP code and sign the user in. New emails auto-provision a full
 * account (user + FREE entitlement + preferences, email pre-verified). MFA is
 * never skipped: enabled accounts get the standard challenge instead of a
 * session.
 */
export async function verifyOtp(input: { email: string; code: string }, req: Request): Promise<OtpVerifyResult> {
  const email = input.email.trim().toLowerCase();
  const existingUserId = await accountIdFor(email);

  const result = await pool.query(
    `SELECT * FROM email_otps WHERE lower(email) = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const row = result.rows[0] as OtpRow | undefined;
  if (!row) return failGeneric('no_active_code', req, email);

  if (row.expires_at.getTime() <= Date.now()) {
    await revokeOtp(row.id);
    return failGeneric('expired', req, email);
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await revokeOtp(row.id);
    return failGeneric('attempts_exhausted', req, email);
  }
  if (!verifyHash(row.code_hash, input.code)) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) await revokeOtp(row.id);
    else await pool.query(`UPDATE email_otps SET attempts = $2 WHERE id = $1`, [row.id, row.attempts + 1]);
    return failGeneric('invalid_code', req, email);
  }

  // Atomic single-use consume (race-safe).
  const consumed = await pool.query(
    `UPDATE email_otps SET status = 'USED', used_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING id`,
    [row.id],
  );
  if (!consumed.rows[0]) return failGeneric('already_used', req, email);

  let userId = existingUserId;
  if (!userId) {
    userId = newId(PREFIX.USER);
    await withTenant(null, async (q) => {
      await q.query(`INSERT INTO users (id, email, email_verified) VALUES ($1,$2,true)`, [userId, email]);
      await q.query(
        `INSERT INTO entitlements (id, user_id, plan_id, state) VALUES ($1,$2,'free','FREE')`,
        [newId(PREFIX.ENTITLEMENT), userId],
      );
      await q.query(
        `INSERT INTO user_preferences (id, owner_id, prefs) VALUES ($1,$2,'{}'::jsonb)`,
        [newId(PREFIX.PREFERENCE), userId],
      );
    });
  } else {
    // OTP proves possession of the address — mark it verified.
    await pool.query(`UPDATE users SET email_verified = true WHERE id = $1`, [userId]);
  }

  const user = await getUserById(userId);
  if (user.mfaEnabled) {
    return { mfaRequired: true, challengeToken: createMfaChallenge(userId), userId };
  }

  const created = await createSessionForUser(userId, req);
  await recordAudit({
    action: AuditAction.AUTH_OTP_VERIFIED,
    actorUserId: userId,
    resourceType: 'user',
    resourceId: userId,
    detail: { via: 'otp' },
    ...auditBase(req, userId),
  });
  await hookSuspiciousSession(userId, created.sessionId, req).catch((err) => {
    logger.warn('suspicious-session hook failed', { error: (err as Error).message });
  });
  return { user, sessionToken: created.token, sessionId: created.sessionId };
}