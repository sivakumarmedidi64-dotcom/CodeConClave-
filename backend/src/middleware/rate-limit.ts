/**
 * CodeConClave — rate limiting (server-side; per user and per endpoint).
 * Redis-backed when available, honest in-memory fallback for dev.
 * Security-sensitive paths (auth, agent pairing) FAIL CLOSED when the limit
 * store is unavailable: a 503 is honest — silently disabling brute-force
 * protection is not.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../shared/errors.js';
import { cache } from '../shared/cache.js';
import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowMs: number;
  keyFn?: (req: Request) => string;
  /** When true, a store outage denies the request (503) instead of allowing it. */
  failClosed?: boolean;
}

export function rateLimit(opts: RateLimitOptions) {
  const keyFn = opts.keyFn ?? ((req: Request) => req.ctx?.user?.id ?? `ip:${req.ip ?? 'unknown'}`);
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const key = `rl:${opts.name}:${keyFn(req)}`;
    try {
      const count = await cache.incr(key, opts.windowMs);
      _res.setHeader('X-RateLimit-Limit', String(opts.limit));
      _res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.limit - count)));
      if (count > opts.limit) {
        next(AppError.tooMany());
        return;
      }
      next();
    } catch (err) {
      if (opts.failClosed) {
        logger.error('rate limit store unavailable', { error: (err as Error).message });
        next(AppError.unavailable('rate_limit_unavailable', 'Rate limiting is temporarily unavailable; try again shortly'));
        return;
      }
      // Non-security paths may continue without limiting during a store outage.
      next();
    }
  };
}

export const globalLimit = () =>
  rateLimit({ name: 'global', limit: env.RATE_LIMIT_GLOBAL_PER_MIN, windowMs: 60_000 });

export const authLimit = () =>
  rateLimit({ name: 'auth', limit: env.RATE_LIMIT_AUTH_PER_MIN, windowMs: 60_000, failClosed: true });

export const chatLimit = () =>
  rateLimit({ name: 'chat', limit: env.RATE_LIMIT_CHAT_PER_MIN, windowMs: 60_000 });