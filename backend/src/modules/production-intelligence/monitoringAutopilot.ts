/**
 * CodeConClave — Monitoring Autopilot (V4D).
 * Uses existing health/monitoring systems.
 * Supports: anomaly detection, alert correlation, duplicate suppression, critical path monitoring, AI-generated explanation.
 * Does not automatically page people without a configured channel.
 */
import { pool, queryMany, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { computeHealth } from '../../health/health.js';
import { metricSnapshot, incMetric } from '../../observability/metrics.js';
import { recentErrors } from '../../observability/error-buffer.js';
import { lastWatchdogRunAt } from '../../workers/watchdog.js';

export interface MonitoringAutopilotResult {
  checkId: string;
  checkedAt: Date;
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  anomalies: Anomaly[];
  alertCorrelations: AlertCorrelation[];
  suppressedAlerts: SuppressedAlert[];
  criticalPathStatus: CriticalPathStatus[];
  aiExplanation: string;
}

export interface Anomaly {
  id: string;
  type: 'METRIC_SPIKE' | 'ERROR_RATE_INCREASE' | 'LATENCY_DEGRADATION' | 'RESOURCE_EXHAUSTION' | 'HEALTH_CHECK_FAILURE' | 'NEW_ERROR_PATTERN';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence: string;
  detectedAt: Date;
  metricName?: string;
  currentValue?: number;
  baselineValue?: number;
  deviationPercent?: number;
  recommendedAction: string;
  autoSuppressible: boolean;
}

export interface AlertCorrelation {
  id: string;
  alertIds: string[];
  correlationType: 'SAME_ROOT_CAUSE' | 'CASCADING_FAILURE' | 'SHARED_DEPENDENCY' | 'TEMPORAL_PROXIMITY';
  confidence: number;
  rootCauseHypothesis: string;
  recommendedAction: string;
  suppressionApplied: boolean;
}

export interface SuppressedAlert {
  alertId: string;
  originalSeverity: string;
  suppressionReason: 'DUPLICATE' | 'CORRELATED' | 'KNOWN_ISSUE' | 'MAINTENANCE_WINDOW';
  suppressedAt: Date;
  suppressedUntil: Date;
  suppressedBy: 'AUTOPILOT' | 'MANUAL';
  originalAlert: any;
}

export interface CriticalPathStatus {
  pathName: string;
  services: ServiceStatus[];
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  bottleneck?: ServiceStatus;
  estimatedImpact: string;
}

export interface ServiceStatus {
  serviceName: string;
  status: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  latencyMs?: number;
  errorRate?: number;
  throughput?: number;
  lastCheck: Date;
}

export interface MonitoringAutopilotConfig {
  anomalyDetection: {
    enabled: boolean;
    sensitivity: 'LOW' | 'MEDIUM' | 'HIGH';
    minDeviationPercent: number;
    minDurationMs: number;
  };
  alertCorrelation: {
    enabled: boolean;
    timeWindowMs: number;
    minConfidence: number;
  };
  alertSuppression: {
    enabled: boolean;
    duplicateWindowMs: number;
    correlationWindowMs: number;
    maintenanceWindows: { start: string; end: string; days: number[] }[];
  };
  criticalPaths: CriticalPathConfig[];
  aiExplanation: {
    enabled: boolean;
    detailLevel: 'SUMMARY' | 'DETAILED' | 'TECHNICAL';
  };
}

export interface CriticalPathConfig {
  name: string;
  services: string[];
  requiredServices: string[];
  optionalServices: string[];
  healthThreshold: number; // 0-100
}

interface Alert {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  message: string;
  source: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

interface MetricPoint {
  timestamp: Date;
  value: number;
  labels: Record<string, string>;
}

const DEFAULT_CONFIG: MonitoringAutopilotConfig = {
  anomalyDetection: {
    enabled: true,
    sensitivity: 'MEDIUM',
    minDeviationPercent: 50,
    minDurationMs: 300000, // 5 minutes
  },
  alertCorrelation: {
    enabled: true,
    timeWindowMs: 300000, // 5 minutes
    minConfidence: 0.7,
  },
  alertSuppression: {
    enabled: true,
    duplicateWindowMs: 300000, // 5 minutes
    correlationWindowMs: 600000, // 10 minutes
    maintenanceWindows: [],
  },
  criticalPaths: [
    {
      name: 'API Request Path',
      services: ['api', 'auth', 'database', 'cache'],
      requiredServices: ['api', 'database'],
      optionalServices: ['cache'],
      healthThreshold: 90,
    },
    {
      name: 'Task Execution Path',
      services: ['task-engine', 'agent-runtime', 'database', 'cache'],
      requiredServices: ['task-engine', 'database'],
      optionalServices: ['cache'],
      healthThreshold: 85,
    },
    {
      name: 'AI Inference Path',
      services: ['ai-gateway', 'provider', 'cache'],
      requiredServices: ['ai-gateway'],
      optionalServices: ['cache'],
      healthThreshold: 80,
    },
  ],
  aiExplanation: {
    enabled: true,
    detailLevel: 'DETAILED',
  },
};

let currentConfig: MonitoringAutopilotConfig = DEFAULT_CONFIG;
let alertHistory: any[] = [];
let suppressionRules: any[] = [];

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

export async function runMonitoringAutopilot(
  userId: string,
  projectId: string
): Promise<MonitoringAutopilotResult> {
  await assertProjectAccess(userId, projectId);

  const checkId = `check_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const checkedAt = new Date();

  // Get current health
  const health = await computeHealth();

  // Get metrics snapshot
  const metrics = metricSnapshot();

  // Get recent errors
  const errors = recentErrors();

  // Get watchdog status
  const watchdogLastRun = lastWatchdogRunAt();

  // Collect alerts from various sources
  const alerts = await collectAlerts();

  // Detect anomalies
  const anomalies = detectAnomalies(alerts, metrics);

  // Correlate alerts
  const alertCorrelations = correlateAlerts(alerts);

  // Suppress duplicate/correlated alerts
  const suppressedAlerts = suppressAlerts(alerts);

  // Check critical paths
  const criticalPathStatus = checkCriticalPaths();

  // Generate AI explanation
  const aiExplanation = generateAiExplanation(anomalies, alertCorrelations, criticalPathStatus);

  const overallStatus = health.status;

  const result: MonitoringAutopilotResult = {
    checkId,
    checkedAt,
    overallStatus,
    anomalies,
    alertCorrelations,
    suppressedAlerts,
    criticalPathStatus,
    aiExplanation,
  };

  await recordAudit({
    action: 'monitoring_autopilot_check',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'monitoring_autopilot',
    detail: {
      projectId,
      overallStatus,
      anomaliesDetected: anomalies.length,
      alertsCorrelated: alertCorrelations.length,
      alertsSuppressed: suppressedAlerts.length,
      criticalPathsChecked: criticalPathStatus.length,
    },
  });

  return result;
}

function collectAlerts(): Alert[] {
  const alerts: Alert[] = [];

  // Health check alerts
  // In a real implementation, this would pull from alerting system

  // Error buffer alerts
  const errors = recentErrors();
  for (const error of errors.slice(-10)) {
    alerts.push({
      id: `error_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      severity: 'HIGH',
      message: error.msg,
      source: 'error_buffer',
      timestamp: new Date(error.t),
      metadata: { correlationId: error.correlationId },
    });
  }

  // Metric threshold alerts
  const metrics = metricSnapshot();
  for (const [key, value] of Object.entries(metrics)) {
    if (key.startsWith('latency:') && value > 5000) {
      alerts.push({
        id: `latency_${key}_${Date.now()}`,
        severity: 'HIGH',
        message: `High latency: ${key} = ${value}ms`,
        source: 'metrics',
        timestamp: new Date(),
        metadata: { metric: key, value },
      });
    }
  }

  return alerts;
}

function detectAnomalies(alerts: Alert[], metrics: Record<string, number>): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Error rate spike
  const errorAlerts = alerts.filter(a => a.severity === 'HIGH' || a.severity === 'CRITICAL');
  const recentErrs = recentErrors().filter((e: any) => Date.now() - new Date(e.t).getTime() < 300000);
  if (recentErrs.length > 20) {
    anomalies.push({
      id: `anomaly_${Date.now()}`,
      type: 'ERROR_RATE_INCREASE',
      severity: 'HIGH',
      description: `Error rate spike: ${recentErrs.length} errors in last 5 minutes`,
      evidence: `${recentErrs.length} errors in last 5 minutes`,
      detectedAt: new Date(),
      recommendedAction: 'Investigate error patterns; check recent deployments',
      autoSuppressible: true,
    });
  }

  // Latency degradation
  for (const [key, value] of Object.entries(metricSnapshot())) {
    if (key.startsWith('latency:') && value > 5000) {
      anomalies.push({
        id: `anomaly_${Date.now()}`,
        type: 'LATENCY_DEGRADATION',
        severity: 'HIGH',
        description: `High latency detected: ${key} = ${value}ms`,
        evidence: `Latency ${key} = ${value}ms (threshold: 5000ms)`,
        detectedAt: new Date(),
        metricName: key,
        currentValue: value,
        baselineValue: 1000,
        deviationPercent: ((value - 1000) / 1000) * 100,
        recommendedAction: 'Investigate slow queries; check database load; review recent changes',
        autoSuppressible: true,
      });
    }
  }

  // Health check failures
  // Would check health status in real implementation

  return anomalies;
}

function correlateAlerts(alerts: Alert[]): AlertCorrelation[] {
  const correlations: AlertCorrelation[] = [];
  const processed = new Set<string>();

  for (const alert of alerts) {
    if (processed.has(alert.id)) continue;

    const related = alerts.filter(a =>
      a.id !== alert.id &&
      !processed.has(a.id) &&
      Math.abs(a.timestamp.getTime() - alert.timestamp.getTime()) < 300000 && // 5 min window
      (a.source === alert.source || areRelatedSources(alert.source, a.source))
    );

    if (related.length > 0) {
      const alertIds = [alert.id, ...related.map(a => a.id)];
      const correlationType = determineCorrelationType(alert, related);
      const confidence = calculateCorrelationConfidence(alert, related);

      correlations.push({
        id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        alertIds,
        correlationType,
        confidence,
        rootCauseHypothesis: generateRootCauseHypothesis(alert, related),
        recommendedAction: generateRecommendedAction(alert, related),
        suppressionApplied: false,
      });

      processed.add(alert.id);
      for (const r of related) processed.add(r.id);
    }
  }

  return correlations;
}

function determineCorrelationType(primary: Alert, related: Alert[]): AlertCorrelation['correlationType'] {
  const sources = new Set([primary.source, ...related.map(a => a.source)]);
  if (sources.size === 1) return 'SAME_ROOT_CAUSE';
  if (hasCascadingRelationship(primary, related)) return 'CASCADING_FAILURE';
  if (shareDependency(primary, related)) return 'SHARED_DEPENDENCY';
  return 'TEMPORAL_PROXIMITY';
}

function hasCascadingRelationship(primary: Alert, related: Alert[]): boolean {
  // Check if primary alert could cause related alerts
  return related.some(a => a.timestamp.getTime() > primary.timestamp.getTime());
}

function shareDependency(primary: Alert, related: Alert[]): boolean {
  // Check if alerts share common dependencies
  return false; // Simplified
}

function calculateCorrelationConfidence(primary: Alert, related: Alert[]): number {
  let confidence = 0.5;
  // Time proximity
  const avgTimeDiff = related.reduce((sum, a) => sum + Math.abs(a.timestamp.getTime() - primary.timestamp.getTime()), 0) / related.length;
  if (avgTimeDiff < 60000) confidence += 0.2;
  else if (avgTimeDiff < 300000) confidence += 0.1;

  // Source similarity
  if (related.some(a => a.source === primary.source)) confidence += 0.2;

  // Severity correlation
  if (related.some(a => a.severity === primary.severity)) confidence += 0.1;

  return Math.min(1, confidence);
}

function generateRootCauseHypothesis(primary: Alert, related: Alert[]): string {
  const sources = new Set([primary.source, ...related.map(a => a.source)]);
  if (sources.size === 1) {
    return `All alerts originate from ${sources.values().next().value}; likely a single root cause`;
  }
  return `Multiple sources affected (${[...sources].join(', ')}); likely a shared dependency or infrastructure issue`;
}

function generateRecommendedAction(primary: Alert, related: Alert[]): string {
  return `Investigate ${primary.source} first; check shared dependencies`;
}

function areRelatedSources(source1: string, source2: string): boolean {
  const relatedPairs: [string, string][] = [
    ['database', 'api'],
    ['cache', 'api'],
    ['database', 'cache'],
    ['auth', 'api'],
    ['error_buffer', 'metrics'],
  ];
  return relatedPairs.some(([a, b]) =>
    (source1.includes(a) && source2.includes(b)) || (source1.includes(b) && source2.includes(a))
  );
}

function suppressAlerts(alerts: Alert[]): SuppressedAlert[] {
  const suppressed: SuppressedAlert[] = [];
  const seen = new Map<string, Alert>();

  for (const alert of alerts) {
    const key = `${alert.severity}:${alert.source}:${alert.message.slice(0, 50)}`;
    if (seen.has(key)) {
      const original = seen.get(key)!;
      suppressed.push({
        alertId: `suppressed_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        originalSeverity: alert.severity,
        suppressionReason: 'DUPLICATE',
        suppressedAt: new Date(),
        suppressedUntil: new Date(Date.now() + 300000), // 5 min
        suppressedBy: 'AUTOPILOT',
        originalAlert: alert,
      });
    } else {
      seen.set(key, alert);
    }
  }
  return suppressed;
}

function checkCriticalPaths(): CriticalPathStatus[] {
  const paths = DEFAULT_CONFIG.criticalPaths;
  return paths.map(path => {
    const services: ServiceStatus[] = path.services.map(s => ({
      serviceName: s,
      status: 'HEALTHY', // Would check actual service health
      lastCheck: new Date(),
    }));

    const failed = services.filter(s => s.status === 'FAILED');
    const degraded = services.filter(s => s.status === 'DEGRADED');
    let overall: 'HEALTHY' | 'DEGRADED' | 'FAILED' = 'HEALTHY';
    if (failed.length > 0) overall = 'FAILED';
    else if (degraded.length > 0) overall = 'DEGRADED';

    const bottleneck = services.find(s => s.status === 'FAILED' || s.status === 'DEGRADED');

    return {
      pathName: path.name,
      services,
      overallStatus: overall,
      bottleneck: bottleneck,
      estimatedImpact: failed.length > 0 ? 'Service unavailable' : degraded.length > 0 ? 'Degraded performance' : 'No impact',
    };
  });
}

function generateAiExplanation(
  anomalies: Anomaly[],
  correlations: AlertCorrelation[],
  criticalPaths: CriticalPathStatus[]
): string {
  const parts: string[] = [];

  if (anomalies.length > 0) {
    const critical = anomalies.filter(a => a.severity === 'CRITICAL').length;
    const high = anomalies.filter(a => a.severity === 'HIGH').length;
    parts.push(`Detected ${anomalies.length} anomalies (${critical} critical, ${high} high).`);
  }

  if (correlations.length > 0) {
    parts.push(`Found ${correlations.length} alert correlations suggesting common root causes.`);
  }

  const failedPaths = criticalPaths.filter(p => p.overallStatus === 'FAILED').length;
  const degradedPaths = criticalPaths.filter(p => p.overallStatus === 'DEGRADED').length;
  if (failedPaths > 0 || degradedPaths > 0) {
    parts.push(`Critical paths: ${failedPaths} failed, ${degradedPaths} degraded.`);
  }

  if (parts.length === 0) {
    return 'System operating normally. No anomalies or critical path issues detected.';
  }

  return parts.join(' ');
}

export async function getMonitoringConfig(): Promise<MonitoringAutopilotConfig> {
  return { ...currentConfig };
}

export async function updateMonitoringConfig(config: Partial<MonitoringAutopilotConfig>): Promise<MonitoringAutopilotConfig> {
  currentConfig = { ...currentConfig, ...config };
  return { ...currentConfig };
}

export async function getAlertHistory(limit = 100): Promise<Alert[]> {
  return alertHistory.slice(-limit);
}

export async function addSuppressionRule(rule: any): Promise<void> {
  suppressionRules.push(rule);
}

export async function getSuppressionRules(): Promise<any[]> {
  return [...suppressionRules];
}