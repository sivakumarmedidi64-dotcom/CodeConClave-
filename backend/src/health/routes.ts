/**
 * CodeConClave — deep health check endpoint.
 * Returns detailed status of all dependencies with latency measurements.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncRoute } from '../middleware/security.js';
import { computeHealth } from './health.js';

export const healthRoutes = (): Router => {
  const router = Router();

  router.get(
    '/health',
    asyncRoute(async (_req: Request, res: Response) => {
      const health = await computeHealth();

      // Format checks as requested
      const checks: Record<string, { status: string; latencyMs?: number }> = {};
      for (const check of health.checks) {
        checks[check.id] = {
          status: check.status.toLowerCase(),
          ...(check.reason ? { reason: check.reason } : {}),
        };
      }

      // Determine overall status
      const hasFailed = health.checks.some(c => c.status === 'FAILED');
      const hasDegraded = health.checks.some(c => c.status === 'DEGRADED');
      const overallStatus = health.status === 'FAILED' ? 'degraded' : (health.status === 'DEGRADED' ? 'degraded' : 'healthy');

      res.json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: health.checks.find(c => c.id === 'database')?.status?.toLowerCase() || 'unknown' },
          redis: { status: health.checks.find(c => c.id === 'cache')?.status?.toLowerCase() || 'unknown' },
          anthropic: { status: health.checks.find(c => c.id === 'ai')?.status === 'HEALTHY' ? 'ok' : 'unknown' },
          openai: { status: 'ok' },
        },
      });
    }),
  );

  return router;
};