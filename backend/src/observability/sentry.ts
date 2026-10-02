/**
 * CodeConClave — observability bootstrap (Sentry, env-gated, no fakes).
 * When SENTRY_DSN + SENTRY_ENABLED=true are provided, initialize; otherwise
 * this is a no-op that keeps the rest of the code path identical.
 * captureError() routes real exceptions to Sentry when enabled and is a
 * guaranteed no-op (never throws) when it is not — Sentry availability must
 * never take the application down.
 */
import { env, isProd } from '../config/env.js';
import { logger } from '../shared/logger.js';

let initialized = false;
let captureImpl: ((err: unknown, ctx: Record<string, unknown>) => void) | null = null;

function sentryModule(): { captureException?: (e: unknown, c?: Record<string, unknown>) => void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@sentry/node') as { captureException?: (e: unknown, c?: Record<string, unknown>) => void };
    return mod.captureException ? mod : null;
  } catch {
    return null;
  }
}

export function initializeSentry(): void {
  if (initialized) return;
  initialized = true;
  if (!env.SENTRY_DSN || env.SENTRY_ENABLED !== 'true') {
    logger.info('sentry disabled (SENTRY_ENABLED or SENTRY_DSN missing)');
    return;
  }
  void isProd;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { init } = require('@sentry/node') as { init: (opts: Record<string, unknown>) => void };
    init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    });
    const mod = sentryModule();
    if (mod?.captureException) {
      const capture = mod.captureException;
      captureImpl = (err, ctx) => {
        capture(err, ctx);
      };
    } else {
      captureImpl = null;
    }
    logger.info('sentry initialized');
  } catch (err) {
    logger.warn('sentry init skipped (package not installed)', { err: err instanceof Error ? err.message : err });
  }
}

/**
 * Capture an exception with Sentry when enabled. Never throws and never logs
 * raw error objects to the application logs: when disabled this is a no-op,
 * and when the package is missing the call is dropped silently.
 */
export function captureError(
  err: unknown,
  context: { level?: 'error' | 'warning'; tags?: Record<string, string>; extra?: Record<string, unknown> } = {},
): void {
  if (!env.SENTRY_DSN || env.SENTRY_ENABLED !== 'true' || !captureImpl) return;
  try {
    captureImpl(err, {
      level: context.level ?? 'error',
      ...(context.tags ? { tags: context.tags } : {}),
      ...(context.extra ? { extra: context.extra } : {}),
    });
  } catch {
    /* never let Sentry failures take the request down */
  }
}