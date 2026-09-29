/**
 * CodeConClave — API Rate Limit Awareness (#22, PKG-15).
 * Reuses the existing security-intelligence `apiSecurity` scan (which already
 * enforces project ownership + persistence) and aggregates per-endpoint rate
 * limit coverage into an operational "awareness" report: which endpoints are
 * rate limited, their strategy/limits/window, fail-closed vs fail-open, and
 * overall coverage. Read-only and advisory.
 */
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { runApiSecurityScan } from '../security-intelligence/apiSecurity.js';
import type {
  EndpointRateLimitAwareness,
  RateLimitAssessment,
  RateLimitAwarenessReport,
  TruthfulnessState,
} from './types.js';

export async function assessRateLimitAwareness(
  userId: string,
  input: RateLimitAssessment,
): Promise<RateLimitAwarenessReport> {
  // runApiSecurityScan enforces project ownership (RLS) and persists its result.
  const scan = await runApiSecurityScan(userId, input.projectId, {
    includeInternal: true,
    minSeverity: input.minSeverity ?? 'LOW',
    checkCors: true,
    checkCsrf: true,
    checkRateLimit: true,
    checkAuth: true,
    checkDataExposure: true,
  });

  const endpoints: EndpointRateLimitAwareness[] = [];
  let rateLimited = 0;

  for (const ep of scan.endpoints) {
    const rl = ep.security.rateLimit;
    const isLimited = !!rl && rl.enabled === true;
    if (isLimited) rateLimited++;
    const state: TruthfulnessState =
      rl && rl.strategy !== 'none' && rl.enabled ? 'VERIFIED' : 'HEURISTIC';
    endpoints.push({
      method: ep.method,
      path: ep.path,
      rateLimited: isLimited,
      strategy: rl?.strategy ?? 'none',
      limits: (rl?.limits ?? []).slice(0, 50),
      failClosed: rl?.failClosed ?? false,
      riskLevel: ep.security.riskLevel,
      state,
      evidence: isLimited
        ? `rate limit enabled (${rl!.strategy}); limits=${(rl!.limits ?? []).length}`
        : 'no rate limit configured for this endpoint',
    });
  }

  const total = Math.max(1, scan.endpoints.length);
  const coveragePercent = Math.round((rateLimited / total) * 100);
  const failClosedEndpoints = endpoints.filter((e) => e.failClosed).length;
  const failOpenEndpoints = endpoints.filter((e) => e.rateLimited && !e.failClosed).length;

  const overall = coveragePercent === 100 ? 'COVERED' : coveragePercent >= 50 ? 'PARTIAL' : 'UNCOVERED';

  return {
    id: newId(PREFIX.SECOPS_RATE_AWARENESS),
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    totalEndpoints: scan.endpoints.length,
    rateLimitedEndpoints: rateLimited,
    uncoveredEndpoints: scan.endpoints.length - rateLimited,
    coveragePercent,
    failClosedEndpoints,
    failOpenEndpoints,
    overall,
    endpoints,
  };
}
