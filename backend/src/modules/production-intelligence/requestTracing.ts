/**
 * CodeConClave — Request Tracing (V4D).
 * Extends existing correlation IDs.
 * Shows: request path, service, timing, failure, task relationship.
 * Does not fake distributed tracing if only one service is observable.
 */
import { withTenant } from '../../shared/db.js';
import pg from 'pg';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';

export interface RequestTrace {
  traceId: string;
  requestId: string;
  method: string;
  path: string;
  userId?: string;
  projectId: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'CANCELLED';
  statusCode?: number;
  correlationId: string;
  servicePath: ServiceHop[];
  taskRelationship?: TaskRelationship;
  error?: TraceError;
  metadata: Record<string, unknown>;
}

export interface ServiceHop {
  service: string;
  operation: string;
  startedAt: Date;
  durationMs?: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  error?: string;
  metadata: Record<string, unknown>;
}

export interface TaskRelationship {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  correlationId: string;
  isPrimary: boolean;
}

export interface TraceError {
  message: string;
  code?: string;
  stackTrace?: string;
  timestamp: Date;
  service: string;
  operation: string;
}

export interface RequestTraceSearchOptions {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  projectId?: string;
  method?: string;
  path?: string;
  status?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface RequestTraceSearchResult {
  traces: RequestTrace[];
  total: number;
}

export interface RequestTraceStats {
  totalRequests: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  errorRate: number;
  topErrors: { message: string; count: number }[];
  topEndpoints: { method: string; path: string; count: number; avgDurationMs: number }[];
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ ok: string } | null>(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

export async function traceRequest(
  userId: string,
  projectId: string,
  options: RequestTraceSearchOptions
): Promise<RequestTraceSearchResult> {
  await assertProjectAccess(userId, projectId);

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const conditions: string[] = ['hr.project_id = $1'];
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.requestId) {
    conditions.push(`hr.id = $${paramIndex++}`);
    params.push(options.requestId);
  }
  if (options.correlationId) {
    conditions.push(`hr.correlation_id = $${paramIndex++}`);
    params.push(options.correlationId);
  }
  if (options.userId) {
    conditions.push(`hr.user_id = $${paramIndex++}`);
    params.push(options.userId);
  }
  if (options.method) {
    conditions.push(`hr.method = $${paramIndex++}`);
    params.push(options.method);
  }
  if (options.path) {
    conditions.push(`hr.path ILIKE $${paramIndex++}`);
    params.push(`%${options.path}%`);
  }
  if (options.status) {
    conditions.push(`hr.status = $${paramIndex++}`);
    params.push(options.status);
  }
  if (options.since) {
    conditions.push(`hr.started_at >= $${paramIndex++}`);
    params.push(options.since.toISOString());
  }
  if (options.until) {
    conditions.push(`hr.completed_at <= $${paramIndex++}`);
    params.push(options.until.toISOString());
  }

  const whereClause = conditions.join(' AND ');
  const countQuery = `SELECT count(*)::int FROM http_requests hr WHERE ${whereClause}`;

  const rows = await withTenant(userId, async (q) => {
    const countResult = await q.query(countQuery, params);
    const total = countResult.rows[0]?.count ?? 0;

    const dataParams = [...params, limit, offset];
    const dataQuery = `
      SELECT hr.*, t.id as task_id, t.title as task_title, t.status as task_status, t.correlation_id
      FROM http_requests hr
      LEFT JOIN tasks t ON t.correlation_id = hr.correlation_id
      WHERE ${whereClause}
      ORDER BY hr.started_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const rows = (await q.query<any>(dataQuery, dataParams)).rows;

    const traces: RequestTrace[] = [];
    for (const row of rows) {
      const servicePath = await buildServicePath(q, row.correlation_id);
      const taskRelationship = row.task_id ? {
        taskId: row.task_id,
        taskTitle: row.task_title,
        taskStatus: row.task_status,
        correlationId: row.correlation_id,
        isPrimary: true,
      } : undefined;

      const trace: RequestTrace = {
        traceId: row.id,
        requestId: row.id,
        method: row.method,
        path: row.path,
        userId: row.user_id,
        projectId: row.project_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
        status: row.status,
        statusCode: row.status_code,
        correlationId: row.correlation_id,
        servicePath,
        taskRelationship,
        error: row.error ? { message: row.error, timestamp: row.completed_at || new Date(), service: 'api', operation: row.method } : undefined,
        metadata: { correlationId: row.correlation_id },
      };
      traces.push(trace);
    }

    return { traces, total };
  });

  return rows;
}

async function buildServicePath(q: pg.PoolClient, correlationId: string): Promise<ServiceHop[]> {
  const hops: ServiceHop[] = [];

  // Find all service interactions for this correlation ID
  const tasks = (await q.query<{
    id: string;
    title: string;
    status: string;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, title, status, created_at, completed_at
     FROM tasks
     WHERE correlation_id = $1
     ORDER BY created_at ASC`,
    [correlationId]
  )).rows;

  for (const task of tasks) {
    hops.push({
      service: 'task-engine',
      operation: `Task: ${hops[0]?.operation || 'execute'}`,
      startedAt: hops[0] ? new Date() : new Date(),
      durationMs: undefined,
      status: 'SUCCESS',
      metadata: { taskId: task.id, title: task.title, status: task.status },
    });

    // Add agent runs
    const agentRuns = (await q.query<{
      id: string;
      agent_id: string;
      status: string;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT ar.id, ar.agent_id, ar.status, ar.created_at, ar.completed_at
       FROM agent_runs ar
       WHERE ar.task_id = $1
       ORDER BY ar.created_at ASC`,
      [task.id]
    )).rows;

    for (const agentRun of agentRuns) {
      hops.push({
        service: 'agent-runtime',
        operation: `Agent: ${agentRun.agent_id}`,
        startedAt: agentRun.created_at,
        durationMs: agentRun.completed_at && agentRun.created_at ? new Date(agentRun.completed_at).getTime() - new Date(agentRun.created_at).getTime() : undefined,
        status: agentRun.status === 'COMPLETED' ? 'SUCCESS' : agentRun.status === 'FAILED' ? 'FAILED' : 'PENDING',
        metadata: { agentRunId: task.id, agentId: agentRun.agent_id },
      });
    }

    // Add deployments
    const deployments = (await q.query<{
      id: string;
      status: string;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id, status, created_at, completed_at
       FROM deployments
       WHERE task_id = $1
       ORDER BY created_at ASC`,
      [task.id]
    )).rows;

    for (const deploy of deployments) {
      hops.push({
        service: 'deployment',
        operation: 'deploy',
        startedAt: deploy.created_at,
        durationMs: deploy.completed_at && deploy.created_at ? new Date(deploy.completed_at).getTime() - new Date(deploy.created_at).getTime() : undefined,
        status: deploy.status === 'SUCCESS' ? 'SUCCESS' : deploy.status === 'FAILED' ? 'FAILED' : 'PENDING',
        metadata: { deploymentId: task.id },
      });
    }
  }

  return hops;
}

export async function getRequestTrace(
  userId: string,
  projectId: string,
  traceId: string
): Promise<RequestTrace | null> {
  await assertProjectAccess(userId, projectId);

  const result = await withTenant<RequestTrace | null>(userId, async (q) => {
    const row = await q.query(
      `SELECT hr.*, t.id as task_id, t.title as task_title, t.status as task_status, t.correlation_id
       FROM http_requests hr
       LEFT JOIN tasks t ON t.correlation_id = hr.correlation_id
       WHERE hr.id = $1 AND hr.project_id = $2`,
      [traceId, projectId]
    );

    if (!row.rows[0]) return null;

    const rowData = row.rows[0];
    const servicePath = await buildServicePath(q, rowData.correlation_id);
    const taskRelationship = rowData.task_id ? {
      taskId: rowData.task_id,
      taskTitle: rowData.task_title,
      taskStatus: rowData.task_status,
      correlationId: rowData.correlation_id,
      isPrimary: true,
    } : undefined;

    return {
      traceId: rowData.id,
      requestId: rowData.id,
      method: rowData.method,
      path: rowData.path,
      userId: rowData.user_id,
      projectId: rowData.project_id,
      startedAt: rowData.started_at,
      completedAt: rowData.completed_at,
      durationMs: rowData.duration_ms,
      status: rowData.status,
      statusCode: rowData.status_code,
      correlationId: rowData.correlation_id,
      servicePath: await buildServicePath(q, rowData.correlation_id),
      taskRelationship,
      error: rowData.error ? { message: rowData.error, timestamp: rowData.completed_at || new Date(), service: 'api', operation: rowData.method } : undefined,
      metadata: { correlationId: rowData.correlation_id },
    };
  });

  return result;
}

export async function getRequestTraceStats(
  userId: string,
  projectId: string,
  options: { since?: Date; until?: Date } = {}
): Promise<RequestTraceStats> {
  await assertProjectAccess(userId, projectId);

  const conditions: string[] = ['hr.project_id = $1'];
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.since) {
    conditions.push(`hr.started_at >= $${paramIndex++}`);
    params.push(options.since.toISOString());
  }
  if (options.until) {
    conditions.push(`hr.completed_at <= $${paramIndex++}`);
    params.push(options.until.toISOString());
  }

  const whereClause = conditions.join(' AND ');

  const filter: string[] = [];
  const filterParams: unknown[] = [];
  let p = 2;
  if (options.since) {
    filter.push(`started_at >= $${p}`);
    filterParams.push(options.since.toISOString());
    p++;
  }
  if (options.until) {
    filter.push(`completed_at <= $${p}`);
    filterParams.push(options.until.toISOString());
    p++;
  }
  const filterSql = filter.length ? ` AND ${filter.join(' AND ')}` : '';

  return withTenant(userId, async (q) => {
    const stats = await q.query(
      `SELECT 
       count(*)::int as total_requests,
       count(*) FILTER (WHERE status = 'SUCCESS')::int as success_count,
       avg(duration_ms)::numeric(10,2) as avg_duration_ms,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) as p50_duration_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration_ms,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_duration_ms,
       count(*) FILTER (WHERE status != 'SUCCESS')::int / nullif(count(*),0)::numeric as error_rate
     FROM http_requests hr
     WHERE ${whereClause}`,
      params
    );

    const topErrors = (await q.query<{ message: string; count: number }>(
      `SELECT error as message, count(*)::int as count
       FROM http_requests
       WHERE project_id = $1 AND error IS NOT NULL${filterSql}
       GROUP BY error
       ORDER BY count DESC LIMIT 10`,
      [projectId, ...filterParams]
    )).rows;

    const topEndpoints = (await q.query<{ method: string; path: string; count: number; avg_duration_ms: number }>(
      `SELECT method, path, count(*)::int as count, avg(duration_ms)::numeric(10,2) as avg_duration_ms
       FROM http_requests
       WHERE project_id = $1${filterSql}
       GROUP BY method, path
       ORDER BY count DESC LIMIT 10`,
      [projectId, ...filterParams]
    )).rows;

    const row = stats.rows[0];
    const total = row?.total_requests ?? 0;
    const success = row?.success_count ?? 0;
    const errorRate = total > 0 ? (total - success) / total : 0;

    return {
      totalRequests: total,
      successRate: total > 0 ? success / total : 1,
      avgDurationMs: row?.avg_duration_ms ? parseFloat(row.avg_duration_ms) : 0,
      p50DurationMs: row?.p50_duration_ms ? parseFloat(row.p50_duration_ms) : 0,
      p95DurationMs: row?.p95_duration_ms ? parseFloat(row.p95_duration_ms) : 0,
      p99DurationMs: row?.p99_duration_ms ? parseFloat(row.p99_duration_ms) : 0,
      errorRate,
      topErrors: topErrors.map(e => ({ message: e.message, count: e.count })),
      topEndpoints: topEndpoints.map(e => ({ method: e.method, path: e.path, count: e.count, avgDurationMs: e.avg_duration_ms ?? 0 })),
    };
  });
}
