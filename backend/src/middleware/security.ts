/**
 * CodeConClave — security headers, CORS, and error handling.
 */
import type { NextFunction, Request, Response } from 'express';
import { env, corsOrigins, isProd } from '../config/env.js';
import { AppError, isAppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { captureError } from '../observability/sentry.js';
import { incMetric } from '../observability/metrics.js';

/**
 * Structural ZodError detection. The ESM server imports zod's ESM build
 * (index.js) while @codeconclave/shared schemas throw from the CJS build
 * (index.cjs) — two class identities, so `instanceof` is unreliable across
 * module graphs. Shape checks never lie about a validation failure.
 */
export function isZodError(err: unknown): err is { issues: Array<{ path: Array<string | number>; message: string }> } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { constructor?: { name?: string } }).constructor?.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (env.CSP_ENABLED === 'true') {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
      ].join('; '),
    );
  }
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
}

export function cors(_req: Request, res: Response, next: NextFunction): void {
  const origin = _req.headers.origin;
  if (origin && corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (isAppError(err)) {
    res.status(err.status).json({
      error: {
        code: err.errorCode,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }
  if (isZodError(err)) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid request payload',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error('unhandled error', { message, traceId: req.ctx?.traceId, stack: err instanceof Error ? err.stack : undefined });
  incMetric('http_5xx');
  // Real exception routing to Sentry (env-gated, never throws).
  captureError(err, { tags: { traceId: req.ctx?.traceId ?? 'unknown' } });
  // The client sees only a sanitized response: never the message, never a stack.
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}

export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}