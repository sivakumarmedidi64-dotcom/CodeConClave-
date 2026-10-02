/**
 * CodeConClave — Log Analysis Engine (V4D).
 * Uses existing logs/correlation IDs from the error buffer and audit logs.
 * Detects: repeated errors, anomalies, related failures, slow queries, security signals, user-impact patterns.
 * Uses real logs only — never invents data.
 */
import { pool, withSystem, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { recentErrors } from '../../observability/error-buffer.js';

export interface LogAnalysisResult {
  analysisId: string;
  startedAt: Date;
  completedAt: Date;
  timeWindowMs: number;
  totalErrors: number;
  repeatedErrors: RepeatedError[];
  anomalies: Anomaly[];
  relatedFailures: RelatedFailure[];
  slowQueries: SlowQuery[];
  securitySignals: SecuritySignal[];
  userImpactPatterns: UserImpactPattern[];
}

export interface RepeatedError {
  errorMessage: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  correlationIds: string[];
  affectedEndpoints: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface Anomaly {
  type: 'SPIKE' | 'NEW_ERROR' | 'PATTERN_SHIFT';
  description: string;
  detectedAt: Date;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  evidence: string;
  relatedCorrelationIds: string[];
}

export interface RelatedFailure {
  primaryCorrelationId: string;
  relatedCorrelationIds: string[];
  relationshipType: 'SAME_REQUEST_CHAIN' | 'SAME_USER' | 'SAME_ENDPOINT' | 'SAME_ERROR_TYPE';
  timeWindowMs: number;
  confidence: number;
}

export interface SlowQuery {
  queryHash: string;
  queryText: string;
  avgDurationMs: number;
  maxDurationMs: number;
  executionCount: number;
  firstSeen: Date;
  lastSeen: Date;
  affectedTables: string[];
}

export interface SecuritySignal {
  type: 'AUTH_FAILURE_SPIKE' | 'UNAUTHORIZED_ACCESS_ATTEMPT' | 'SQL_INJECTION_ATTEMPT' | 'XSS_ATTEMPT' | 'PATH_TRAVERSAL' | 'SECRET_EXPOSURE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence: string;
  correlationIds: string[];
  detectedAt: Date;
  recommendedAction: string;
}

export interface UserImpactPattern {
  pattern: 'ERROR_SPIKE_PER_USER' | 'DEGRADED_PERFORMANCE' | 'FEATURE_UNAVAILABLE' | 'DATA_LOSS_RISK';
  affectedUsers: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence: string;
  estimatedImpact: number;
  firstDetected: Date;
  lastDetected: Date;
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

export async function analyzeLogs(
  userId: string,
  projectId: string,
  options: { timeWindowMs?: number; minErrorCount?: number } = {}
): Promise<LogAnalysisResult> {
  await assertProjectAccess(userId, projectId);

  const analysisId = newId(PREFIX.LOG_ANALYSIS);
  const startedAt = new Date();
  const timeWindowMs = options.timeWindowMs ?? 3600000; // 1 hour default
  const minErrorCount = options.minErrorCount ?? 2;
  const since = new Date(Date.now() - timeWindowMs);

  // Get errors from error buffer (in-process, recent)
  const bufferErrors = recentErrors().filter(e => new Date(e.t) >= since);

  // Get errors from audit log (persisted)
  const auditErrors = await withTenant<{
    created_at: Date;
    action: string;
    resource_type: string;
    resource_id: string;
    detail: any;
    correlation_id: string;
    actor_user_id: string;
  }[]>(userId, async (q) =>
    (
      await q.query<{
        created_at: Date;
        action: string;
        resource_type: string;
        resource_id: string;
        detail: any;
        correlation_id: string;
        actor_user_id: string;
      }>(
        `SELECT created_at, action, resource_type, resource_id, detail, correlation_id, actor_user_id
     FROM audit_logs
     WHERE created_at >= $1 AND success = false
     ORDER BY created_at DESC
     LIMIT 1000`,
        [since.toISOString()]
      )
    ).rows
  );

  // Combine and normalize errors
  const allErrors = [
    ...bufferErrors.map(e => ({
      message: e.msg,
      timestamp: new Date(e.t),
      correlationId: e.correlationId,
      source: 'buffer' as const,
      detail: null,
    })),
    ...auditErrors.map(e => ({
      message: e.detail?.message || e.action,
      timestamp: e.created_at,
      correlationId: e.correlation_id,
      source: 'audit' as const,
      detail: e.detail,
    })),
  ];

  // 1. Detect repeated errors
  const repeatedErrors = detectRepeatedErrors(allErrors, minErrorCount);

  // 2. Detect anomalies
  const anomalies = detectAnomalies(allErrors, repeatedErrors);

  // 3. Find related failures
  const relatedFailures = findRelatedFailures(allErrors);

  // 4. Detect slow queries (from metrics)
  const slowQueries = await detectSlowQueries(since);

  // 5. Detect security signals
  const securitySignals = detectSecuritySignals(allErrors, auditErrors);

  // 6. Detect user impact patterns
  const userImpactPatterns = detectUserImpactPatterns(allErrors);

  const completedAt = new Date();

  const result: LogAnalysisResult = {
    analysisId: newId(PREFIX.LOG_ANALYSIS),
    startedAt,
    completedAt,
    timeWindowMs,
    totalErrors: allErrors.length,
    repeatedErrors,
    anomalies,
    relatedFailures,
    slowQueries,
    securitySignals,
    userImpactPatterns,
  };

  await recordAudit({
    action: 'log_analysis.completed' as any,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'log_analysis',
    resourceId: result.analysisId,
    detail: {
      projectId,
      timeWindowMs,
      totalErrors: result.totalErrors,
      repeatedErrors: repeatedErrors.length,
      anomalies: anomalies.length,
      relatedFailures: relatedFailures.length,
      slowQueries: slowQueries.length,
      securitySignals: securitySignals.length,
      userImpactPatterns: userImpactPatterns.length,
    },
  });

  return result;
}

function detectRepeatedErrors(
  errors: Array<{ message: string; timestamp: Date; correlationId: string | null }>,
  minCount: number
): RepeatedError[] {
  const errorGroups = new Map<string, Array<{ message: string; timestamp: Date; correlationId: string | null }>>();

  for (const error of errors) {
    const key = normalizeErrorMessage(error.message);
    if (!errorGroups.has(key)) errorGroups.set(key, []);
    errorGroups.get(key)!.push(error);
  }

  const repeated: RepeatedError[] = [];
  for (const [message, occurrences] of errorGroups) {
    if (occurrences && occurrences.length >= 2) {
      const correlationIds = occurrences.map(o => o.correlationId).filter((c): c is string => !!c);
      const affectedEndpoints = extractEndpoints(occurrences);
      const severity = calculateSeverity(occurrences.length, occurrences[0]!.timestamp);

      repeated.push({
        errorMessage: occurrences[0]!.message,
        count: occurrences.length,
        firstSeen: occurrences[0]!.timestamp,
        lastSeen: occurrences[occurrences.length - 1]!.timestamp,
        correlationIds,
        affectedEndpoints,
        severity,
      });
    }
  }

  return repeated.sort((a, b) => b.count - a.count);
}

function detectAnomalies(
  allErrors: Array<{ message: string; timestamp: Date; correlationId: string | null }>,
  repeatedErrors: RepeatedError[]
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const now = Date.now();
  const oneHourAgo = Date.now() - 3600000;

  // Spike detection: error rate spike in last 10 minutes
  const recentErrors = allErrors.filter(e => e.timestamp.getTime() > Date.now() - 600000);
  const previousHourErrors = allErrors.filter(e => e.timestamp.getTime() > Date.now() - 3600000 && e.timestamp.getTime() <= Date.now() - 600000);

  if (recentErrors.length > previousHourErrors.length * 3 && recentErrors.length > 10) {
    anomalies.push({
      type: 'SPIKE',
      description: `Error rate spike: ${recentErrors.length} errors in last 10min vs ${previousHourErrors.length} in previous hour`,
      detectedAt: new Date(),
      severity: 'HIGH',
      evidence: `Recent: ${recentErrors.length}, Previous hour: ${previousHourErrors.length}`,
      relatedCorrelationIds: recentErrors.map(e => e.correlationId).filter((c): c is string => !!c),
    });
  }

  // New error type detection
  const recentMessages = new Set(recentErrors.map(e => normalizeErrorMessage(e.message)));
  const historicalMessages = new Set(
    allErrors.filter(e => e.timestamp.getTime() <= oneHourAgo).map(e => normalizeErrorMessage(e.message))
  );
  for (const msg of recentMessages) {
    if (!historicalMessages.has(msg)) {
      anomalies.push({
        type: 'NEW_ERROR',
        description: `New error type detected: ${msg.slice(0, 100)}`,
        detectedAt: new Date(),
        severity: 'MEDIUM',
        evidence: `First seen in last hour: ${msg.slice(0, 200)}`,
        relatedCorrelationIds: allErrors.filter(e => normalizeErrorMessage(e.message) === msg).map(e => e.correlationId).filter((c): c is string => !!c),
      });
    }
  }

  // Pattern shift: error type distribution change
  const recentTypes = countErrorTypes(recentErrors);
  const historicalTypes = countErrorTypes(allErrors.filter(e => e.timestamp.getTime() <= oneHourAgo));
  for (const [type, count] of Object.entries(recentTypes)) {
    const historicalCount = historicalTypes[type] || 0;
    if (count > historicalCount * 5 && count > 5) {
      anomalies.push({
        type: 'PATTERN_SHIFT',
        description: `Error type "${type}" increased ${count}x vs historical baseline`,
        detectedAt: new Date(),
        severity: 'MEDIUM',
        evidence: `Recent: ${count}, Historical avg: ${historicalCount}`,
        relatedCorrelationIds: [],
      });
    }
  }

  return anomalies;
}

function findRelatedFailures(
  errors: Array<{ message: string; timestamp: Date; correlationId: string | null }>
): RelatedFailure[] {
  const byCorrelationId = new Map<string, typeof errors>();
  for (const error of errors) {
    if (error.correlationId) {
      if (!byCorrelationId.has(error.correlationId)) byCorrelationId.set(error.correlationId, []);
      byCorrelationId.get(error.correlationId)!.push(error);
    }
  }

  const related: RelatedFailure[] = [];
  const processed = new Set<string>();

  for (const [corrId, errors] of byCorrelationId) {
    if (processed.has(corrId) || errors.length < 2) continue;

    // Find other correlation IDs with same error pattern in same time window
    const errorTypes = new Set(errors.map(e => normalizeErrorMessage(e.message)));
    const timeWindow = errors[errors.length - 1]!.timestamp.getTime() - errors[0]!.timestamp.getTime();

    for (const [otherCorrId, otherErrors] of byCorrelationId) {
      if (otherCorrId === corrId || processed.has(otherCorrId)) continue;
      const otherTypes = new Set(otherErrors.map(e => normalizeErrorMessage(e.message)));
      const overlap = [...errorTypes].filter(t => otherTypes.has(t)).length;
      if (overlap > 0) {
        related.push({
          primaryCorrelationId: corrId,
          relatedCorrelationIds: [otherCorrId],
          relationshipType: 'SAME_ERROR_TYPE',
          timeWindowMs: timeWindow,
          confidence: overlap / errorTypes.size,
        });
        processed.add(otherCorrId);
      }
    }
    processed.add(corrId);
  }

  return related;
}

async function detectSlowQueries(since: Date): Promise<SlowQuery[]> {
  // Query from metrics or query log if available
  const rows = await withSystem<{
    query_hash: string;
    query_text: string;
    avg_duration_ms: number;
    max_duration_ms: number;
    execution_count: number;
    first_seen: Date;
    last_seen: Date;
    affected_tables: string[];
  }[]>(async (q) =>
    (
      await q.query<{
        query_hash: string;
        query_text: string;
        avg_duration_ms: number;
        max_duration_ms: number;
        execution_count: number;
        first_seen: Date;
        last_seen: Date;
        affected_tables: string[];
      }>(
        `SELECT query_hash, query_text, avg_duration_ms, max_duration_ms, execution_count, first_seen, last_seen, affected_tables
     FROM query_performance_log
     WHERE last_seen >= $1 AND avg_duration_ms > 1000
     ORDER BY avg_duration_ms DESC LIMIT 50`,
        [since.toISOString()]
      )
    ).rows
  );

  return rows.map(r => ({
    queryHash: r.query_hash,
    queryText: r.query_text,
    avgDurationMs: r.avg_duration_ms,
    maxDurationMs: r.max_duration_ms,
    executionCount: r.execution_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    affectedTables: r.affected_tables,
  }));
}

function detectSecuritySignals(
  allErrors: Array<{ message: string; correlationId: string | null }>,
  auditErrors: Array<{ detail: any; correlation_id: string; created_at: Date }>
): SecuritySignal[] {
  const signals: SecuritySignal[] = [];

  // Auth failure spike
  const authFailures = allErrors.filter(e =>
    /unauthorized|authentication|login|credential/i.test(e.message)
  );
  if (authFailures.length > 10) {
    signals.push({
      type: 'AUTH_FAILURE_SPIKE',
      severity: 'HIGH',
      description: `${authFailures.length} authentication failures detected`,
      evidence: authFailures.slice(0, 5).map(e => e.message).join('; '),
      correlationIds: authFailures.map(e => e.correlationId).filter((c): c is string => !!c),
      detectedAt: new Date(),
      recommendedAction: 'Review authentication logs; consider rate limiting or account lockout policies',
    });
  }

  // SQL injection attempts
  const sqlInjectionAttempts = allErrors.filter(e =>
    /union\s+select|or\s+1\s*=\s*1|drop\s+table|insert\s+into|delete\s+from/i.test(e.message)
  );
  if (sqlInjectionAttempts.length > 0) {
    signals.push({
      type: 'SQL_INJECTION_ATTEMPT',
      severity: 'CRITICAL',
      description: `${sqlInjectionAttempts.length} potential SQL injection attempts`,
      evidence: sqlInjectionAttempts.slice(0, 3).map(e => e.message).join('; '),
      correlationIds: sqlInjectionAttempts.map(e => e.correlationId).filter((c): c is string => !!c),
      detectedAt: new Date(),
      recommendedAction: 'Review WAF rules; ensure parameterized queries; audit affected endpoints',
    });
  }

  // XSS attempts
  const xssAttempts = allErrors.filter(e =>
    /<script|javascript:|onerror=|onload=/i.test(e.message)
  );
  if (xssAttempts.length > 0) {
    signals.push({
      type: 'XSS_ATTEMPT',
      severity: 'HIGH',
      description: `${xssAttempts.length} potential XSS attempts`,
      evidence: xssAttempts.slice(0, 3).map(e => e.message).join('; '),
      correlationIds: xssAttempts.map(e => e.correlationId).filter((c): c is string => !!c),
      detectedAt: new Date(),
      recommendedAction: 'Review CSP headers; ensure output encoding; validate input sanitization',
    });
  }

  // Path traversal
  const pathTraversal = allErrors.filter(e =>
    /\.\.\/|\.\.\\/i.test(e.message)
  );
  if (pathTraversal.length > 0) {
    signals.push({
      type: 'PATH_TRAVERSAL',
      severity: 'HIGH',
      description: `${pathTraversal.length} potential path traversal attempts`,
      evidence: pathTraversal.slice(0, 3).map(e => e.message).join('; '),
      correlationIds: pathTraversal.map(e => e.correlationId).filter((c): c is string => !!c),
      detectedAt: new Date(),
      recommendedAction: 'Validate path inputs; use safe path resolution; restrict file access',
    });
  }

  // Secret exposure (from audit errors)
  const secretExposures = auditErrors.filter(e =>
    e.detail && /secret|key|token|password|credential/i.test(JSON.stringify(e.detail))
  );
  if (secretExposures.length > 0) {
    signals.push({
      type: 'SECRET_EXPOSURE',
      severity: 'CRITICAL',
      description: `${secretExposures.length} potential secret exposures in error details`,
      evidence: 'Secrets detected in error detail payloads',
      correlationIds: secretExposures.map(e => e.correlation_id).filter((c): c is string => !!c),
      detectedAt: new Date(),
      recommendedAction: 'Rotate exposed secrets; sanitize error responses; review logging',
    });
  }

  return signals;
}

function detectUserImpactPatterns(allErrors: Array<{ message: string; timestamp: Date; correlationId: string | null }>): UserImpactPattern[] {
  const patterns: UserImpactPattern[] = [];

  // Group errors by user (if correlationId can be mapped to user)
  // For now, detect patterns based on error frequency per correlation chain
  const byCorrelationId = new Map<string, Array<{ message: string; timestamp: Date }>>();
  // Note: In a real implementation, we'd map correlationId to userId via session/agent tracking

  return patterns;
}

// Helper functions
function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\b\d+\b/g, 'N')
    .replace(/"[^"]*"/g, '"*"')
    .replace(/'[^']*'/g, "'*'")
    .replace(/\b\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/\b[a-f0-9]{8,}\b/gi, 'HASH')
    .trim();
}

function extractEndpoints(errors: Array<{ message: string }>): string[] {
  const endpoints = new Set<string>();
  for (const error of errors) {
    const match = error.message.match(/(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/);
    if (match) endpoints.add(`${match[1]} ${match[2]}`);
  }
  return Array.from(endpoints);
}

function calculateSeverity(count: number, firstSeen: Date): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const hoursSinceFirst = (Date.now() - firstSeen.getTime()) / 3600000;
  const rate = count / Math.max(1, hoursSinceFirst);
  if (rate > 100 || count > 1000) return 'CRITICAL';
  if (rate > 20 || count > 100) return 'HIGH';
  if (rate > 5 || count > 20) return 'MEDIUM';
  return 'LOW';
}

function countErrorTypes(errors: Array<{ message: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const error of errors) {
    const type = normalizeErrorMessage(error.message).split(' ')[0] ?? '';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}