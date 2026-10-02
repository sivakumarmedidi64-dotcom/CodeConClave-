/**
 * CodeConClave — CSRF protection (double-submit cookie pattern).
 * Every state-changing request must echo the CSRF cookie in X-CSRF-Token.
 * Exemptions: signature/webhook and Local Agent token endpoints (authenticated
 * by cryptographic secrets, not browser cookies).
 */
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { randomToken } from '../shared/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const EXEMPT_PREFIXES = [
  '/api/v1/payments/webhook',
  '/api/v1/payments/gmail-claim',
  '/api/v1/razorpay/webhook',
  '/api/v1/webhooks',
  '/api/v1/agent/',
  '/agent/',
];

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }
  const cookieToken = req.cookies?.[env.CSRF_COOKIE_NAME];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || typeof headerToken !== 'string' || !constantTimeEqual(cookieToken, headerToken)) {
    next(AppError.forbidden('csrf_mismatch', 'CSRF validation failed'));
    return;
  }
  next();
}

/**
 * Constant-time token comparison. The previous `cookieToken !== headerToken`
 * compared with `===`, which short-circuits on the first differing byte and
 * leaks how much of a guessed token was correct. timingSafeEqual requires equal
 * lengths, so length is compared separately (length is not a secret).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function ensureCsrfCookie(req: Request, res: Response, next: NextFunction): void {
  if (!req.cookies?.[env.CSRF_COOKIE_NAME]) {
    res.cookie(env.CSRF_COOKIE_NAME, randomToken(16), {
      httpOnly: false,
      secure: env.SESSION_COOKIE_SECURE === 'true',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
  next();
}