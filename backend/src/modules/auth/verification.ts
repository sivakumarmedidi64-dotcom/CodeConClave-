/**
 * CodeConClave — email verification (PHASE 2).
 * Server-side authority only:
 * - tokens are random 32-byte values, only SHA-256 hashes persist
 * - single-use: a verified token can never be reused
 * - expiry: tokens expire server-side after 24h
 * - rate limited: min interval between sends + hourly cap, per user
 * - delivery via the outbox/Resend pipeline (never faked)
 * - every send/verify/failure is audited
 */
import type { Request } from 'express';
import { pool, withTenant } from '../../shared/db.js';
import { cache } from '../../shared/cache.js';
import { AppError } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { enqueueOutbox } from '../outbox/service.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESEND_MIN_INTERVAL_MS = 60 * 1000;
export const MAX_SENDS_PER_HOUR = 3;

export interface SendVerificationResult {
  sent: boolean;
  alreadyVerified: boolean;
  resendableAfterMs: number;
}

export async function sendVerificationEmail(userId: string, req: Request): Promise<SendVerificationResult> {
  const user = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [userId]);
  const row = user.rows[0] as { email: string; email_verified: boolean } | undefined;
  if (!row) throw AppError.notFound('User');
  if (row.email_verified) {
    return { sent: false, alreadyVerified: true, resendableAfterMs: 0 };
  }

  // Per-user resend interval: at most one email per RESEND_MIN_INTERVAL_MS.
  const lastSent = await cache.get(`verif:last:${userId}`);
  if (lastSent) {
    const elapsed = Date.now() - Number(lastSent);
    if (elapsed < RESEND_MIN_INTERVAL_MS) {
      throw AppError.tooMany('verification_throttled', 'A verification email was just sent. Try again shortly.');
    }
  }

  // Hourly cap per user.
  const hourCount = await cache.incr(`verif:count:${userId}`, 60 * 60 * 1000);
  if (hourCount > MAX_SENDS_PER_HOUR) {
    throw AppError.tooMany('verification_rate_limited', 'Too many verification emails. Try again in an hour.');
  }

  const token = randomToken(32);
  await pool.query(
    `INSERT INTO email_verifications (id, user_id, token_hash, expires_at)
     VALUES ($1,$2,$3, now() + ($4 || ' milliseconds')::interval)`,
    [newId(PREFIX.USER), userId, sha256Hex(token), VERIFICATION_TOKEN_TTL_MS],
  );
  await cache.set(`verif:last:${userId}`, String(Date.now()), 60 * 60 * 1000);

  const verifyUrl = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await enqueueOutbox('auth.email_verification', {
    channel: 'email',
    to: row.email,
    subject: 'Verify your CodeConClave email',
    html: `<p>Confirm this address to finish setting up your CodeConClave account.</p>
<p><a href="${verifyUrl}">Verify email</a></p>
<p class="cc-muted">This link expires in 24 hours and can be used once.</p>`,
    data: { userId },
  });

  await recordAudit({
    action: AuditAction.AUTH_EMAIL_VERIFICATION_SENT,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'email_verification',
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    traceId: req.ctx?.traceId ?? null,
    detail: { expiresInHours: VERIFICATION_TOKEN_TTL_MS / 3_600_000 },
  });

  logger.info('verification email sent', { userId, ttlHours: VERIFICATION_TOKEN_TTL_MS / 3_600_000 });
  return { sent: true, alreadyVerified: false, resendableAfterMs: RESEND_MIN_INTERVAL_MS };
}

async function auditFailure(userId: string | null, reason: string, req: Request): Promise<void> {
  await recordAudit({
    action: AuditAction.AUTH_EMAIL_VERIFICATION_FAILED,
    actorUserId: userId ?? null,
    scope: 'USER',
    tenantId: userId ?? null,
    resourceType: 'email_verification',
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    traceId: req.ctx?.traceId ?? null,
    detail: { reason },
  });
}

/**
 * Verify a token — single use. A token can only transition PENDING → USED;
 * the user row is marked verified inside the same tenant-scoped transaction.
 */
export async function verifyEmailToken(token: string, req: Request): Promise<void> {
  const result = await pool.query(
    `SELECT id, user_id, status, expires_at FROM email_verifications WHERE token_hash = $1`,
    [sha256Hex(token)],
  );
  const row = result.rows[0] as
    | { id: string; user_id: string; status: string; expires_at: Date }
    | undefined;
  if (!row) {
    await auditFailure(null, 'invalid_token', req);
    throw AppError.badRequest('verification_invalid', 'This verification link is not valid.');
  }
  if (row.status !== 'PENDING') {
    await auditFailure(row.user_id, 'already_used', req);
    throw AppError.badRequest('verification_used', 'This verification link has already been used.');
  }
  if (row.expires_at.getTime() <= Date.now()) {
    await auditFailure(row.user_id, 'expired', req);
    throw AppError.badRequest('verification_expired', 'This verification link has expired. Request a new one.');
  }

  await withTenant(row.user_id, async (q) => {
    const marked = await q.query(
      `UPDATE email_verifications SET status = 'USED', used_at = now()
       WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [row.id],
    );
    if (!marked.rows[0]) {
      throw AppError.badRequest('verification_used', 'This verification link has already been used.');
    }
    await q.query('UPDATE users SET email_verified = true WHERE id = $1', [row.user_id]);
  });

  await recordAudit({
    action: AuditAction.AUTH_EMAIL_VERIFIED,
    actorUserId: row.user_id,
    scope: 'USER',
    tenantId: row.user_id,
    resourceType: 'user',
    resourceId: row.user_id,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    traceId: req.ctx?.traceId ?? null,
  });
}

export interface VerificationStatus {
  emailVerified: boolean;
  lastSentAt: string | null;
  lastExpiresAt: string | null;
}

export async function verificationStatus(userId: string): Promise<VerificationStatus> {
  const [user, latest] = await Promise.all([
    pool.query('SELECT email_verified FROM users WHERE id = $1', [userId]),
    pool.query(
      `SELECT created_at, expires_at FROM email_verifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
  ]);
  const row = user.rows[0] as { email_verified: boolean } | undefined;
  if (!row) throw AppError.notFound('User');
  const last = latest.rows[0] as { created_at: Date; expires_at: Date } | undefined;
  return {
    emailVerified: row.email_verified,
    lastSentAt: last?.created_at.toISOString() ?? null,
    lastExpiresAt: last?.expires_at.toISOString() ?? null,
  };
}