/**
 * CodeConClave — rate limiting (server-side; per user, per client, per identity).
 * Redis-backed when available, honest in-memory fallback for dev.
 * Security-sensitive paths (auth, agent pairing) FAIL CLOSED when the limit
 * store is unavailable: a 503 is honest — silently disabling brute-force
 * protection is not.
 *
 * Identity model for unauthenticated traffic: keying only on the client IP is
 * insufficient once the app runs behind a shared proxy. Conversely keying only on
 * the submitted identifier lets an attacker rotate identifiers to escape
 * limiting, and lets one abusive client consume a victim's bucket by guessing
 * their handle. `identityAwareLimit` therefore enforces BOTH an independent
 * per-IP bucket and an independent per-identifier bucket, so neither dimension
 * can be used to starve the other.
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

/**
 * The authenticated principal, or the resolved client address for anonymous
 * traffic. `req.ip` is only as trustworthy as the resolved TRUST_PROXY model:
 * with no trusted proxy it is the socket peer (the load balancer), and with a
 * trusted proxy it is the rightmost untrusted hop in X-Forwarded-For.
 */
function principalKey(req: Request): string {
  return req.ctx?.user?.id ?? `ip:${req.ip ?? 'unknown'}`;
}

export function rateLimit(opts: RateLimitOptions) {
  const keyFn = opts.keyFn ?? principalKey;
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

/**
 * Fields a client may submit that identify the account being targeted. Used to
 * spread anonymous auth traffic across independent buckets so one client cannot
 * exhaust another's allowance, without ever trusting the value for anything
 * other than bucketing.
 *
 * Body fields only — deliberately NOT headers. A header is just as
 * client-controlled as a body field, but a header is invisible to the route
 * handler's own validation and is the obvious next place an attacker reaches
 * for to mint unlimited rate-limit identities.
 */
const IDENTITY_FIELDS = ['handle', 'email', 'identifier', 'phone', 'keyId', 'intentId'] as const;

function readIdentifier(req: Request): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const field of IDENTITY_FIELDS) {
      const raw = body[field];
      if (typeof raw === 'string' && raw.trim().length > 0) {
        return raw.trim().toLowerCase().slice(0, 200);
      }
    }
  }
  return null;
}

/**
 * Enforce two independent budgets for anonymous identity traffic:
 *   - `perClient`  keyed on the resolved client address
 *   - `perIdentity` keyed on the submitted identifier (falls back to the client
 *     address when none was submitted, so a request can never escape both)
 *
 * A request must satisfy BOTH. This is what makes "Client A must not consume
 * Client B's entire auth bucket" true, while still capping an attacker who
 * rotates identifiers on every request.
 */
export function identityAwareLimit(opts: {
  name: string;
  perClient: number;
  perIdentity: number;
  windowMs: number;
}) {
  const clientLimiter = rateLimit({
    name: `${opts.name}:client`,
    limit: opts.perClient,
    windowMs: opts.windowMs,
    keyFn: (req) => `ip:${req.ip ?? 'unknown'}`,
    failClosed: true,
  });
  const identityLimiter = rateLimit({
    name: `${opts.name}:identity`,
    limit: opts.perIdentity,
    windowMs: opts.windowMs,
    keyFn: (req) => {
      const identifier = readIdentifier(req);
      return identifier === null ? `ip:${req.ip ?? 'unknown'}` : `id:${identifier}`;
    },
    failClosed: true,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    clientLimiter(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      identityLimiter(req, res, next);
    });
  };
}

export const globalLimit = () =>
  rateLimit({ name: 'global', limit: env.RATE_LIMIT_GLOBAL_PER_MIN, windowMs: 60_000, failClosed: true });

export const authLimit = () =>
  identityAwareLimit({
    name: 'auth',
    perClient: env.RATE_LIMIT_AUTH_PER_MIN,
    perIdentity: env.RATE_LIMIT_AUTH_IDENTITY_PER_MIN,
    windowMs: 60_000,
  });

export const chatLimit = () =>
  rateLimit({ name: 'chat', limit: env.RATE_LIMIT_CHAT_PER_MIN, windowMs: 60_000, failClosed: true });
