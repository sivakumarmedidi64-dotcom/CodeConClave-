/**
 * CodeConClave — CSRF protection (double-submit cookie pattern).
 * Every state-changing request must echo the CSRF cookie in X-CSRF-Token.
 * Exemptions: signature/webhook and Local Agent token endpoints (authenticated
 * by cryptographic secrets, not browser cookies).
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { randomToken } from '../shared/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const EXEMPT_PREFIXES = [
  '/api/v1/payments/webhook',
  '/api/v1/razorpay/webhook',
  '/api/v1/webhooks',
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
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    next(AppError.forbidden('csrf_mismatch', 'CSRF validation failed'));
    return;
  }
  next();
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