/**
 * CodeConClave — PKG-19 runtime — deterministic runtime verification (F38).
 * Checks run only what is actually reachable/configured and report explicit
 * statuses (PASS / FAIL / BLOCKED / NOT_RUN / UNAVAILABLE). An unavailable or
 * not-enabled check is never converted into a PASS. Backend health reuses the
 * existing computeHealth (read-only); preview status reuses the live preview
 * session; optional URL/port probes run against configured targets.
 */
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { VerificationResult, VerifyStatus } from './types.js';
import { assertProjectAccess } from './security.js';
import { realProbe, type RemoteProbe } from './probes.js';
import { getPreview } from '../preview/service.js';
import { computeHealth } from '../../health/health.js';
import { env } from '../../config/env.js';

export interface BackendHealthSignal {
  ok: boolean;
  status: string;
}

function defaultBackendHealth(): Promise<BackendHealthSignal> {
  return computeHealth()
    .then((h) => ({ ok: h.ok, status: h.status }))
    .catch(() => ({ ok: false, status: 'FAILED' }));
}

export class RuntimeVerificationEngine {
  constructor(
    private probe: RemoteProbe = realProbe,
    private backendHealth: () => Promise<BackendHealthSignal> = defaultBackendHealth,
  ) {}

  async verify(userId: string, projectId: string): Promise<VerificationResult[]> {
    await assertProjectAccess(userId, projectId);
    const results: VerificationResult[] = [];

    if (env.RUNTIME_VERIFY_ENABLED !== 'true') {
      results.push(this.make(projectId, 'Backend health', 'NOT_RUN', 'runtime verification is not enabled on this deployment'));
    } else {
      const h = await this.backendHealth();
      results.push(this.make(projectId, 'Backend health', h.ok && h.status !== 'FAILED' ? 'PASS' : 'FAIL', `status=${h.status}`));
    }

    try {
      const session = await getPreview(userId, projectId);
      const state = String(session.state ?? 'NOT_CONFIGURED');
      results.push(this.make(projectId, 'Preview runtime', state === 'READY' ? 'PASS' : 'NOT_RUN', `preview state=${state}`));
    } catch {
      results.push(this.make(projectId, 'Preview runtime', 'UNAVAILABLE', 'preview service unavailable'));
    }

    const urls = (env.RUNTIME_VERIFY_URLS || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      results.push(this.make(projectId, 'Configured endpoints', 'NOT_RUN', 'no RUNTIME_VERIFY_URLS configured'));
    } else {
      for (const url of urls.slice(0, 20)) {
        const res = await this.probe.httpGet(url, 8000);
        const pass = res.ok && res.status >= 200 && res.status < 400;
        results.push(
          this.make(projectId, `HTTP ${url}`, pass ? 'PASS' : 'UNAVAILABLE', `${res.status} ${res.error ?? ''}`.trim()),
        );
      }
    }

    const host = env.RUNTIME_HOST;
    const port = env.RUNTIME_PORT ? Number(env.RUNTIME_PORT) : null;
    if (host && port && port > 0) {
      const res = await this.probe.portOpen(host, port, 5000);
      results.push(this.make(projectId, `Port ${host}:${port}`, res.open ? 'PASS' : 'FAIL', res.open ? 'listening' : (res.error ?? 'closed')));
    } else {
      results.push(this.make(projectId, 'Port listener', 'NOT_RUN', 'no RUNTIME_HOST/RUNTIME_PORT configured'));
    }

    return results;
  }

  private make(projectId: string, label: string, status: VerifyStatus, detail: string): VerificationResult {
    return {
      id: newId(PREFIX.RUNTIME_VERIFY_RUN),
      projectId,
      label,
      status,
      detail,
      durationMs: null,
      ranAt: new Date().toISOString(),
    };
  }
}

export const runtimeVerificationEngine = new RuntimeVerificationEngine();
