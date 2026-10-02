/**
 * CodeConClave — PKG-19 runtime — smoke-test foundation.
 * Reusable, config-driven smoke suite. Checks are explicit: URL reachable,
 * expected HTTP status, health endpoint, frontend reachable, API reachable,
 * frontend/backend connectivity. Project-specific smokes are defined by config
 * (env JSON), never invented automatically. Results persist per run with
 * name/start/duration/result/evidence/failure-reason. An UNAVAILABLE target is
 * reported UNAVAILABLE — never converted to PASS.
 */
import { withTenant, pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { SmokeConfig, SmokeResult, SmokeRunSummary, SmokeStatus, VerifyStatus } from './types.js';
import { assertProjectAccess } from './security.js';
import { realProbe, type RemoteProbe } from './probes.js';
import { env } from '../../config/env.js';

export function parseSmokeConfig(): SmokeConfig[] {
  const raw = env.RUNTIME_SMOKE_CONFIG || '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SmokeConfig[];
      if (Array.isArray(parsed)) {
        return parsed
          .filter((c) => c && typeof c.name === 'string' && typeof c.url === 'string')
          .map((c) => ({
            name: String(c.name).slice(0, 200),
            method: (String(c.method ?? 'GET').toUpperCase() || 'GET').slice(0, 16),
            url: String(c.url).slice(0, 2000),
            expectedStatus: typeof c.expectedStatus === 'number' ? c.expectedStatus : undefined,
            timeoutMs: typeof c.timeoutMs === 'number' ? c.timeoutMs : 8000,
          }));
      }
    } catch {
      /* invalid config -> treated as none */
    }
  }
  if (env.RUNTIME_SMOKE_BASE_URL) {
    const base = env.RUNTIME_SMOKE_BASE_URL.replace(/\/+$/, '');
    return [
      { name: 'health endpoint', method: 'GET', url: `${base}/health`, expectedStatus: 200, timeoutMs: 8000 },
      { name: 'liveness probe', method: 'GET', url: `${base}/healthz`, expectedStatus: 200, timeoutMs: 8000 },
    ];
  }
  return [];
}

export interface SmokeRun {
  summary: SmokeRunSummary;
  results: SmokeResult[];
}

export class RuntimeSmokeEngine {
  constructor(private probe: RemoteProbe = realProbe) {}

  async run(userId: string, projectId: string, overrides?: SmokeConfig[]): Promise<SmokeRun> {
    await assertProjectAccess(userId, projectId);
    const configs = overrides && overrides.length > 0 ? overrides : parseSmokeConfig();
    const runId = newId(PREFIX.RUNTIME_SMOKE_RUN);
    const startedAt = new Date();

    if (configs.length === 0) {
      const summary: SmokeRunSummary = {
        id: runId,
        projectId,
        name: 'smoke',
        status: 'UNAVAILABLE',
        total: 0,
        passed: 0,
        failed: 0,
        unavailable: 0,
      };
      return { summary, results: [] };
    }

    const results: SmokeResult[] = [];
    for (const c of configs.slice(0, 50)) {
      const resId = newId(PREFIX.RUNTIME_SMOKE_RESULT);
      const t0 = Date.now();
      const res = await this.probe.httpGet(c.url, c.timeoutMs ?? 8000);
      const durationMs = Date.now() - t0;
      const status: VerifyStatus = res.status === 0 ? 'UNAVAILABLE' : c.expectedStatus ? (res.status === c.expectedStatus ? 'PASS' : 'FAIL') : res.ok ? 'PASS' : 'FAIL';
      const statusSafe = (['PASS', 'FAIL', 'BLOCKED', 'UNAVAILABLE'] as string[]).includes(status) ? (status as SmokeStatus) : 'UNAVAILABLE';
      await pool.query(
        `INSERT INTO runtime_smoke_results (id, owner_id, project_id, run_id, name, method, url, expected_status, status, duration_ms, evidence, failure_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          resId, userId, projectId, runId, c.name, c.method, c.url.slice(0, 2000), c.expectedStatus ?? null,
          statusSafe, durationMs,
          statusSafe === 'UNAVAILABLE' ? (res.error ?? 'target unreachable') : `http ${res.status}`,
          statusSafe === 'FAIL' ? `expected ${String(c.expectedStatus ?? '2xx')}, got ${res.status}` : null,
        ],
      );
      results.push({
        id: resId,
        name: c.name,
        method: c.method,
        url: c.url.slice(0, 2000),
        expectedStatus: c.expectedStatus ?? null,
        status: statusSafe,
        durationMs,
        evidence: statusSafe === 'UNAVAILABLE' ? (res.error ?? 'target unreachable') : `http ${res.status}`,
        failureReason: statusSafe === 'FAIL' ? `expected ${String(c.expectedStatus ?? '2xx')}, got ${res.status}` : null,
      });
    }

    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const unavailable = results.filter((r) => r.status === 'UNAVAILABLE').length;
    const overall: SmokeRunSummary['status'] =
      failed > 0 ? 'FAIL'
      : passed === results.length ? 'PASS'
      : results.length === 0 ? 'UNAVAILABLE'
      : 'PARTIAL';

    await pool.query(
      `INSERT INTO runtime_smoke_runs (id, owner_id, project_id, name, status, total, passed, failed, unavailable, started_at, ended_at)
       VALUES ($1,$2,$3,'smoke',$4,$5,$6,$7,$8,$9,now())`,
      [runId, userId, projectId, overall, results.length, passed, failed, unavailable, startedAt],
    );

    return {
      summary: { id: runId, projectId, name: 'smoke', status: overall, total: results.length, passed, failed, unavailable },
      results,
    };
  }

  async history(userId: string, projectId: string, limit = 20): Promise<SmokeRunSummary[]> {
    await assertProjectAccess(userId, projectId);
    const rows = await withTenant<{ id: string; project_id: string; name: string; status: string; total: number; passed: number; failed: number; unavailable: number }[]>(
      userId,
      async (q) =>
        (
          await q.query<{ id: string; project_id: string; name: string; status: string; total: number; passed: number; failed: number; unavailable: number }>(
            `SELECT id, project_id, name, status, total, passed, failed, unavailable FROM runtime_smoke_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2`,
            [projectId, limit],
          )
        ).rows,
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      status: r.status as SmokeRunSummary['status'],
      total: r.total,
      passed: r.passed,
      failed: r.failed,
      unavailable: r.unavailable,
    }));
  }
}

export const runtimeSmokeEngine = new RuntimeSmokeEngine();
