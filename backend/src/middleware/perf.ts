/**
 * CodeConClave — per-route API latency instrumentation (Phase 16).
 * Measures handler wall time via the response 'finish' event and records it
 * under the route PATTERN (method + express route path) — never user content,
 * never raw URLs. Exported standalone so tests can mount it on a tiny app.
 */
import type { Request, Response, NextFunction } from 'express';
import { recordLatencyMetric } from '../observability/metrics.js';

export function apiLatency(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const route = (req as { route?: { path?: string } }).route?.path ?? 'unknown';
      recordLatencyMetric(`api_${req.method}_${route}`, Date.now() - startedAt);
    });
    next();
  };
}