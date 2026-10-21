/**
 * CodeConClave — process-level safety net for unhandled promise rejections.
 *
 * Every known background path (worker pump, watchdog, sweeps, WebSocket hubs)
 * catches its own errors; this is defence in depth, not a substitute. A stray
 * rejection (typically a pg pool connect timeout during a DB outage) is LOGGED
 * loudly and counted — never swallowed silently — and the process keeps
 * serving so /health and /ready can report the outage honestly (they probe the
 * database themselves) instead of the whole server disappearing.
 *
 * Synchronous uncaught exceptions are deliberately NOT intercepted: process
 * state after one is undefined, so Node's default crash-and-restart stands.
 */
import { incMetric } from '../observability/metrics.js';
import { logger } from './logger.js';

let installed = false;

export function handleUnhandledRejection(reason: unknown): void {
  incMetric('process.unhandled_rejection');
  logger.error('unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
}

/** Idempotent: safe to call from every process entrypoint. */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', handleUnhandledRejection);
}
