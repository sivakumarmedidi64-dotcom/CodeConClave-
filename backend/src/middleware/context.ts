/**
 * CodeConClave — request context.
 * Trace id, client identity, and structured request logging. The context is the
 * only place auth reads write to; modules never trust client-supplied identity.
 */
import type { NextFunction, Request, Response } from 'express';
import { randomToken } from '../shared/crypto.js';
import { logger } from '../shared/logger.js';

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  googleSub: string | null;
  mfaEnabled: boolean;
  rbacRole: 'owner' | 'admin' | 'member' | 'viewer';
  planId: 'free' | 'pro' | 'team' | 'enterprise';
  entitlementState: 'FREE' | 'PRO_PENDING' | 'PRO_VERIFIED' | 'PRO_EXPIRED' | 'PRO_REFUNDED';
}

export interface RequestCtx {
  traceId: string;
  ip: string | null;
  userAgent: string | null;
  user: AuthUser | null;
  sessionId: string | null;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestCtx;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const traceId = randomToken(8);
  req.ctx = {
    traceId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    user: null,
    sessionId: null,
    startedAt: Date.now(),
  };
  // Correlation id for clients and logs: every response carries its traceId.
  res.setHeader('X-Request-Id', traceId);
  next();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('http', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      traceId: req.ctx?.traceId,
      userId: req.ctx?.user?.id ?? null,
    });
  });
  next();
}