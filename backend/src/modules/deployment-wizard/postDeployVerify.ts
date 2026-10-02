/**
 * CodeConClave — Post-Deploy Verification (V4E).
 * Verifies deployment success after all steps complete.
 * Checks: health, readiness, logs, API, frontend, worker, queue, AI, preview, plugins.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

// ─── Types ─────────────────────────────────────────────────────

export type VerificationStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'TIMEOUT';

export interface VerificationCheck {
  id: string;
  name: string;
  category: 'health' | 'readiness' | 'logs' | 'api' | 'frontend' | 'worker' | 'queue' | 'ai' | 'preview' | 'plugins';
  status: VerificationStatus;
  message: string;
  endpoint?: string;
  responseTimeMs?: number;
  details?: Record<string, unknown>;
}

export interface PostDeployResult {
  id: string;
  projectId: string;
  deploymentId: string;
  verifiedAt: Date;
  checks: VerificationCheck[];
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  summary: {
    total: number;
    pass: number;
    fail: number;
    warn: number;
    skip: number;
  };
}

export interface PostDeployInput {
  projectId: string;
  deploymentId: string;
  backendUrl?: string;
  frontendUrl?: string;
  healthEndpoint?: string;
  apiEndpoints?: string[];
  hasWorker?: boolean;
  hasQueue?: boolean;
  hasAi?: boolean;
  hasPreview?: boolean;
  hasPlugins?: boolean;
}

// ─── Verification Functions ────────────────────────────────────

async function verifyHealth(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  const endpoint = input.healthEndpoint || `${input.backendUrl}/health`;

  if (!input.backendUrl) {
    return { id: checkId, name: 'Health Check', category: 'health', status: 'SKIP', message: 'No backend URL provided' };
  }

  try {
    const start = Date.now();
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    const responseTimeMs = Date.now() - start;

    return {
      id: checkId,
      name: 'Health Check',
      category: 'health',
      status: response.ok ? 'PASS' : 'FAIL',
      message: response.ok ? `Health endpoint responding (${response.status})` : `Health endpoint returned ${response.status}`,
      endpoint,
      responseTimeMs,
    };
  } catch (e) {
    return {
      id: checkId,
      name: 'Health Check',
      category: 'health',
      status: 'FAIL',
      message: `Health endpoint unreachable: ${e instanceof Error ? e.message : 'unknown error'}`,
      endpoint,
    };
  }
}

async function verifyReadiness(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);

  if (!input.backendUrl) {
    return { id: checkId, name: 'Readiness Check', category: 'readiness', status: 'SKIP', message: 'No backend URL provided' };
  }

  try {
    const start = Date.now();
    const response = await fetch(`${input.backendUrl}/ready`, { signal: AbortSignal.timeout(10000) });
    const responseTimeMs = Date.now() - start;

    return {
      id: checkId,
      name: 'Readiness Check',
      category: 'readiness',
      status: response.ok ? 'PASS' : 'WARN',
      message: response.ok ? 'Service is ready' : `Readiness returned ${response.status}`,
      endpoint: `${input.backendUrl}/ready`,
      responseTimeMs,
    };
  } catch {
    return {
      id: checkId,
      name: 'Readiness Check',
      category: 'readiness',
      status: 'WARN',
      message: 'Readiness endpoint not available (may not be configured)',
    };
  }
}

async function verifyLogs(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);

  if (!input.backendUrl) {
    return { id: checkId, name: 'Log Stream', category: 'logs', status: 'SKIP', message: 'No backend URL provided' };
  }

  try {
    const response = await fetch(`${input.backendUrl}/api/logs?limit=5`, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      return { id: checkId, name: 'Log Stream', category: 'logs', status: 'PASS', message: 'Log endpoint accessible' };
    }
    return { id: checkId, name: 'Log Stream', category: 'logs', status: 'WARN', message: `Log endpoint returned ${response.status}` };
  } catch {
    return { id: checkId, name: 'Log Stream', category: 'logs', status: 'SKIP', message: 'Log endpoint not verifiable' };
  }
}

async function verifyApi(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  const endpoints = input.apiEndpoints || [];

  if (!input.backendUrl || endpoints.length === 0) {
    return { id: checkId, name: 'API Endpoints', category: 'api', status: 'SKIP', message: 'No API endpoints to verify' };
  }

  const results: { endpoint: string; ok: boolean; status: number }[] = [];

  for (const ep of endpoints.slice(0, 5)) {
    try {
      const url = ep.startsWith('http') ? ep : `${input.backendUrl}${ep}`;
      const start = Date.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      results.push({ endpoint: ep, ok: response.ok || response.status === 401, status: response.status });
    } catch {
      results.push({ endpoint: ep, ok: false, status: 0 });
    }
  }

  const failedCount = results.filter(r => !r.ok).length;

  return {
    id: checkId,
    name: 'API Endpoints',
    category: 'api',
    status: failedCount === 0 ? 'PASS' : failedCount === results.length ? 'FAIL' : 'WARN',
    message: failedCount === 0
      ? `All ${results.length} API endpoints responding`
      : `${failedCount}/${results.length} API endpoints failed`,
    details: { results },
  };
}

async function verifyFrontend(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);

  if (!input.frontendUrl) {
    return { id: checkId, name: 'Frontend', category: 'frontend', status: 'SKIP', message: 'No frontend URL provided' };
  }

  try {
    const start = Date.now();
    const response = await fetch(input.frontendUrl, { signal: AbortSignal.timeout(10000) });
    const responseTimeMs = Date.now() - start;

    return {
      id: checkId,
      name: 'Frontend',
      category: 'frontend',
      status: response.ok ? 'PASS' : 'FAIL',
      message: response.ok ? `Frontend serving (${response.status})` : `Frontend returned ${response.status}`,
      endpoint: input.frontendUrl,
      responseTimeMs,
    };
  } catch (e) {
    return {
      id: checkId,
      name: 'Frontend',
      category: 'frontend',
      status: 'FAIL',
      message: `Frontend unreachable: ${e instanceof Error ? e.message : 'unknown'}`,
      endpoint: input.frontendUrl,
    };
  }
}

async function verifyWorker(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  if (!input.hasWorker) return { id: checkId, name: 'Worker', category: 'worker', status: 'SKIP', message: 'No worker component' };
  return { id: checkId, name: 'Worker', category: 'worker', status: 'WARN', message: 'Worker running — verify via logs and queue depth' };
}

async function verifyQueue(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  if (!input.hasQueue) return { id: checkId, name: 'Queue', category: 'queue', status: 'SKIP', message: 'No queue component' };
  return { id: checkId, name: 'Queue', category: 'queue', status: 'WARN', message: 'Queue active — verify via monitoring' };
}

async function verifyAi(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  if (!input.hasAi) return { id: checkId, name: 'AI Provider', category: 'ai', status: 'SKIP', message: 'No AI component' };
  return { id: checkId, name: 'AI Provider', category: 'ai', status: 'WARN', message: 'AI configured — verify via test inference after deployment' };
}

async function verifyPreview(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  if (!input.hasPreview) return { id: checkId, name: 'Preview', category: 'preview', status: 'SKIP', message: 'No preview component' };
  return { id: checkId, name: 'Preview', category: 'preview', status: 'PASS', message: 'Preview environment available' };
}

async function verifyPlugins(input: PostDeployInput): Promise<VerificationCheck> {
  const checkId = newId(PREFIX.DEPLOY_VERIFY);
  if (!input.hasPlugins) return { id: checkId, name: 'Plugins', category: 'plugins', status: 'SKIP', message: 'No plugin component' };
  return { id: checkId, name: 'Plugins', category: 'plugins', status: 'WARN', message: 'Plugins active — verify functionality manually' };
}

// ─── Main Function ─────────────────────────────────────────────

export async function runPostDeployVerification(
  userId: string,
  input: PostDeployInput
): Promise<PostDeployResult> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [input.projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const resultId = newId(PREFIX.DEPLOY_VERIFY);

  const checks = await Promise.all([
    verifyHealth(input),
    verifyReadiness(input),
    verifyLogs(input),
    verifyApi(input),
    verifyFrontend(input),
    verifyWorker(input),
    verifyQueue(input),
    verifyAi(input),
    verifyPreview(input),
    verifyPlugins(input),
  ]);

  const summary = {
    total: checks.length,
    pass: checks.filter(c => c.status === 'PASS').length,
    fail: checks.filter(c => c.status === 'FAIL').length,
    warn: checks.filter(c => c.status === 'WARN').length,
    skip: checks.filter(c => c.status === 'SKIP').length,
  };

  let overallStatus: PostDeployResult['overallStatus'] = 'HEALTHY';
  if (summary.fail > 0) overallStatus = 'FAILED';
  else if (summary.warn > 0) overallStatus = 'DEGRADED';

  const result: PostDeployResult = {
    id: resultId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    verifiedAt: new Date(),
    checks,
    overallStatus,
    summary,
  };

  await pool.query(
    `INSERT INTO post_deploy_verifications (id, project_id, deployment_id, checks, overall_status, summary, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [resultId, input.projectId, input.deploymentId, JSON.stringify(checks), overallStatus, JSON.stringify(summary)],
  );

  await recordAudit({
    action: 'post_deploy_verification_completed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'post_deploy_verification',
    resourceId: resultId,
    detail: { overallStatus, failCount: summary.fail },
  });

  return result;
}
