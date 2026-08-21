/**
 * CodeConClave — operator diagnostics (Phase 15).
 * Authorized operators only (owner/admin). Aggregates health checks, queue
 * depth (task DLQ + outbox backlog), security/operational event metrics, and
 * recent critical errors (message + traceId only). NEVER includes secrets,
 * raw connection strings, user content, or per-user data.
 */
import { createRequire } from 'node:module';
import { queryMany } from '../../shared/db.js';
import { computeHealth, type HealthReport } from '../../health/health.js';
import { metricSnapshot } from '../../observability/metrics.js';
import { recentErrors, type BufferedError } from '../../observability/error-buffer.js';

const require = createRequire(import.meta.url);

export interface DiagnosticsReport {
  version: string;
  generatedAt: string;
  health: HealthReport;
  queue: { dlqDepth: number; outboxPending: number };
  metrics: Record<string, number>;
  recentErrors: BufferedError[];
}

function appVersion(): string {
  // Resolve the repo package.json from either the src tree (tests) or dist (built).
  for (const rel of ['../../../package.json', '../../package.json']) {
    try {
      const pkg = require(rel) as { version?: string };
      return pkg.version ?? 'unknown';
    } catch {
      // try the next candidate
    }
  }
  return 'unknown';
}

export async function diagnosticsReport(): Promise<DiagnosticsReport> {
  const [health, dlqRows, outboxRows] = await Promise.all([
    computeHealth(),
    queryMany<{ n: number }>('SELECT count(*)::int AS n FROM task_dlq'),
    queryMany<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'PENDING'`),
  ]);
  return {
    version: appVersion(),
    generatedAt: new Date().toISOString(),
    health,
    queue: {
      dlqDepth: dlqRows[0]?.n ?? 0,
      outboxPending: outboxRows[0]?.n ?? 0,
    },
    metrics: metricSnapshot(),
    recentErrors: recentErrors(),
  };
}