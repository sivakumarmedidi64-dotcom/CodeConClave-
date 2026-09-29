/**
 * CodeConClave — Database Performance Monitor (V4D).
 * Uses actual DB metrics where accessible.
 * Detects: slow queries, missing indexes, long transactions, connection pressure, lock patterns.
 * Does not automatically change the database. Provides recommendations.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';

export interface DbPerformanceReport {
  reportId: string;
  projectId: string;
  generatedAt: Date;
  timeWindowMs: number;
  slowQueries: SlowQuery[];
  missingIndexes: MissingIndex[];
  longTransactions: LongTransaction[];
  connectionPressure: ConnectionPressure;
  lockPatterns: LockPattern[];
  tableStats: TableStat[];
  recommendations: Recommendation[];
}

export interface SlowQuery {
  queryHash: string;
  queryText: string;
  avgDurationMs: number;
  maxDurationMs: number;
  executionCount: number;
  rowsExamined: number;
  rowsReturned: number;
  tablesScanned: string[];
  recommendedIndexes: string[];
}

export interface MissingIndex {
  tableName: string;
  columns: string[];
  reason: string;
  estimatedBenefit: 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedIndex: string;
}

export interface LongTransaction {
  transactionId: string;
  pid: number;
  userId?: string;
  query: string;
  durationMs: number;
  state: string;
  locksHeld: number;
  blockingPids: number[];
}

export interface ConnectionPressure {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
  maxConnections: number;
  usagePercent: number;
  waitEvents: { event: string; count: number }[];
}

export interface LockPattern {
  lockType: string;
  tableName: string;
  mode: string;
  count: number;
  avgDurationMs: number;
  maxDurationMs: number;
  blockedQueries: number;
}

export interface TableStat {
  tableName: string;
  sizeBytes: number;
  rowCount: number;
  sequentialScans: number;
  indexScans: number;
  indexUsagePercent: number;
  deadTuples: number;
  lastVacuum: Date | null;
  lastAnalyze: Date | null;
}

export interface Recommendation {
  type: 'INDEX' | 'VACUUM' | 'ANALYZE' | 'CONFIG' | 'QUERY_REWRITE' | 'PARTITION' | 'ARCHIVE';
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  sql?: string;
  affectedTables: string[];
  estimatedBenefit: string;
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ ok: string } | null>(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

export async function generateDbPerformanceReport(
  userId: string,
  projectId: string,
  options: { timeWindowMs?: number } = {}
): Promise<DbPerformanceReport> {
  const reportId = newId(PREFIX.DB_PERF_REPORT);
  const timeWindowMs = options.timeWindowMs ?? 3600000;
  const since = new Date(Date.now() - timeWindowMs);

  const [
    slowQueries,
    missingIndexes,
    longTransactions,
    connectionPressure,
    lockPatterns,
    tableStats,
  ] = await Promise.all([
    getSlowQueries(since),
    findMissingIndexes(),
    getLongTransactions(),
    getConnectionPressure(),
    getLockPatterns(since),
    getTableStats(),
  ]);

  const recommendations = generateRecommendations(slowQueries, missingIndexes, longTransactions, connectionPressure, lockPatterns, tableStats);

  const report: DbPerformanceReport = {
    reportId: newId(PREFIX.DB_PERF_REPORT),
    projectId,
    generatedAt: new Date(),
    timeWindowMs,
    slowQueries,
    missingIndexes,
    longTransactions,
    connectionPressure,
    lockPatterns,
    tableStats,
    recommendations,
  };

  await recordAudit({
    action: 'db_performance_report_generated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'db_performance_report',
    resourceId: reportId,
    detail: {
      projectId,
      timeWindowMs,
      slowQueries: slowQueries.length,
      missingIndexes: missingIndexes.length,
      longTransactions: longTransactions.length,
      recommendations: recommendations.length,
    },
  });

  return report;
}

async function getSlowQueries(since: Date) {
  // Query from pg_stat_statements or performance log
  const rows = await withSystem(async (q) => (
    await q.query<{
      query_hash: string;
      query_text: string;
      avg_duration_ms: number;
      max_duration_ms: number;
      execution_count: number;
      rows_examined: number;
      rows_returned: number;
      tables_scanned: string[];
    }>(
      `SELECT 
       query_hash,
       query_text,
       avg_duration_ms,
       max_duration_ms,
       execution_count,
       rows_examined,
       rows_returned,
       tables_scanned
     FROM query_performance_log
     WHERE last_seen >= $1 AND avg_duration_ms > 100
     ORDER BY avg_duration_ms DESC LIMIT 50`,
      [since.toISOString()]
    )
  ).rows);

  return rows.map(r => ({
    queryHash: r.query_hash,
    queryText: r.query_text,
    avgDurationMs: r.avg_duration_ms,
    maxDurationMs: r.max_duration_ms,
    executionCount: r.execution_count,
    rowsExamined: r.rows_examined,
    rowsReturned: r.rows_returned,
    tablesScanned: r.tables_scanned,
    recommendedIndexes: suggestIndexes(r.query_text, r.tables_scanned),
  }));
}

async function findMissingIndexes() {
  const rows = await withSystem(async (q) => (
    await q.query<{
      table_name: string;
      column_name: string;
      seq_scan: number;
      idx_scan: number;
      seq_tup_read: number;
      idx_tup_fetch: number;
    }>(
      `SELECT 
       schemaname || '.' || relname as table_name,
       attname as column_name,
       seq_scan,
       idx_scan,
       seq_tup_read,
       idx_tup_fetch
     FROM pg_stat_user_tables
     JOIN pg_attribute ON attrelid = relid
     WHERE schemaname = 'public'
       AND attnum > 0
       AND NOT attisdropped
       AND seq_scan > 100
       AND idx_scan = 0
     ORDER BY seq_tup_read DESC LIMIT 50`
    )
  ).rows);

  return rows.map(r => ({
    tableName: r.table_name,
    columns: [r.column_name],
    reason: `Sequential scan on ${r.table_name}.${r.column_name} (${r.seq_scan} scans, 0 index scans)`,
    estimatedBenefit: 'HIGH' as const,
    suggestedIndex: `CREATE INDEX ON ${r.table_name} (${r.column_name});`,
  }));
}

async function getLongTransactions() {
  const rows = await withSystem(async (q) => (
    await q.query<{
      pid: number;
      query: string;
      state: string;
      duration_ms: number;
      locks_held: number;
      blocking_pids: number[];
      user_id: string;
    }>(
      `SELECT 
       pid,
       query,
       state,
       EXTRACT(EPOCH FROM (now() - xact_start)) * 1000 as duration_ms,
       (SELECT count(*) FROM pg_locks WHERE pid = pg_stat_activity.pid) as locks_held,
       (SELECT array_agg(pid) FROM pg_blocking_pids(pid)) as blocking_pids,
       usename as user_id
     FROM pg_stat_activity
     WHERE state IN ('active', 'idle in transaction')
       AND xact_start < now() - interval '30 seconds'
       AND query NOT LIKE '%pg_stat_activity%'
     ORDER BY duration_ms DESC LIMIT 20`
    )
  ).rows);

  return rows.map(r => ({
    transactionId: `pid-${r.pid}`,
    pid: r.pid,
    userId: r.user_id,
    query: r.query,
    durationMs: r.duration_ms,
    state: r.state,
    locksHeld: r.locks_held,
    blockingPids: r.blocking_pids || [],
  }));
}

async function getConnectionPressure(): Promise<any> {
  return withSystem(async (q) => {
    const maxConn = await q.query('SHOW max_connections');
    const stats = (await q.query<{
      total: number;
      active: number;
      idle: number;
      waiting: number;
      wait_event: string;
    }>(
      `SELECT 
       count(*)::int as total,
       count(*) FILTER (WHERE state = 'active')::int as active,
       count(*) FILTER (WHERE state = 'idle')::int as idle,
       count(*) FILTER (WHERE wait_event_type IS NOT NULL)::int as waiting,
       wait_event
     FROM pg_stat_activity
     WHERE datname = current_database()
     GROUP BY wait_event`
    )).rows;

    const max = parseInt(maxConn.rows[0]?.max_connections || '100');
    const total = stats.reduce((sum, s) => sum + s.total, 0);
    const active = stats.reduce((sum, s) => sum + s.active, 0);
    const idle = stats.reduce((sum, s) => sum + s.idle, 0);
    const waiting = stats.reduce((sum, s) => sum + s.waiting, 0);

    const waitEvents = stats.filter(s => s.wait_event).map(s => ({ event: s.wait_event, count: s.total }));

    return {
      totalConnections: total,
      activeConnections: active,
      idleConnections: idle,
      waitingConnections: waiting,
      maxConnections: max,
      usagePercent: max > 0 ? Math.round((total / max) * 100) : 0,
      waitEvents,
    };
  });
}

async function getLockPatterns(since: Date) {
  const rows = await withSystem(async (q) => (
    await q.query<{
      lock_type: string;
      relname: string;
      mode: string;
      count: number;
      avg_duration_ms: number;
      max_duration_ms: number;
      blocked_queries: number;
    }>(
      `SELECT 
       locktype as lock_type,
       relname as table_name,
       mode,
       count(*)::int as count,
       0 as avg_duration_ms,
       0 as max_duration_ms,
       0 as blocked_queries
     FROM pg_locks l
     LEFT JOIN pg_class c ON c.oid = l.relation
     WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND l.granted = false
     GROUP BY locktype, relname, mode
     ORDER BY count DESC LIMIT 20`
    )
  ).rows);

  return rows.map(r => ({
    lockType: r.lock_type,
    tableName: r.relname,
    mode: r.mode,
    count: r.count,
    avgDurationMs: r.avg_duration_ms,
    maxDurationMs: r.max_duration_ms,
    blockedQueries: r.blocked_queries,
  }));
}

async function getTableStats() {
  const rows = await withSystem(async (q) => (
    await q.query<{
      table_name: string;
      size_bytes: number;
      row_count: number;
      seq_scan: number;
      idx_scan: number;
      dead_tuples: number;
      last_vacuum: Date | null;
      last_analyze: Date | null;
    }>(
      `SELECT 
       relname as table_name,
       pg_total_relation_size(relid) as size_bytes,
       n_live_tup as row_count,
       seq_scan,
       idx_scan,
       n_dead_tup as dead_tuples,
       last_vacuum,
       last_analyze
     FROM pg_stat_user_tables
     WHERE schemaname = 'public'
     ORDER BY pg_total_relation_size(relid) DESC LIMIT 50`
    )
  ).rows);

  return rows.map(r => ({
    tableName: r.table_name,
    sizeBytes: r.size_bytes,
    rowCount: r.row_count,
    sequentialScans: r.seq_scan,
    indexScans: r.idx_scan,
    indexUsagePercent: r.seq_scan + r.idx_scan > 0 ? Math.round((r.idx_scan / (r.seq_scan + r.idx_scan)) * 100) : 0,
    deadTuples: r.dead_tuples,
    lastVacuum: r.last_vacuum,
    lastAnalyze: r.last_analyze,
  }));
}

function generateRecommendations(
  slowQueries: any[],
  missingIndexes: any[],
  longTransactions: any[],
  connectionPressure: any,
  lockPatterns: any[],
  tableStats: any[]
): any[] {
  const recommendations: any[] = [];

  // Index recommendations
  for (const idx of missingIndexes.slice(0, 10)) {
    recommendations.push({
      type: 'INDEX',
      priority: idx.estimatedBenefit === 'HIGH' ? 'HIGH' : 'MEDIUM',
      title: `Missing index on ${idx.tableName}.${idx.columns.join(', ')}`,
      description: idx.reason,
      impact: idx.estimatedBenefit,
      effort: 'LOW',
      sql: idx.suggestedIndex,
      affectedTables: [idx.tableName],
      estimatedBenefit: `Reduce sequential scans by ~${idx.estimatedBenefit === 'HIGH' ? '90%' : '50%'}`,
    });
  }

  // Slow query recommendations
  for (const query of slowQueries.slice(0, 5)) {
    if (query.recommendedIndexes.length > 0) {
      recommendations.push({
        type: 'QUERY_REWRITE',
        priority: query.avgDurationMs > 5000 ? 'CRITICAL' : query.avgDurationMs > 1000 ? 'HIGH' : 'MEDIUM',
        title: `Optimize slow query (${Math.round(query.avgDurationMs)}ms avg)`,
        description: `Query executed ${query.executionCount} times with avg ${Math.round(query.avgDurationMs)}ms`,
        impact: query.avgDurationMs > 5000 ? 'HIGH' : 'MEDIUM',
        effort: 'MEDIUM',
        sql: query.recommendedIndexes[0],
        affectedTables: query.tablesScanned,
        estimatedBenefit: `Reduce avg duration by ~${Math.min(90, Math.round(query.avgDurationMs / 100))}%`,
      });
    }
  }

  // Long transaction recommendations
  if (longTransactions.length > 0) {
    recommendations.push({
      type: 'QUERY_REWRITE',
      priority: 'HIGH',
      title: 'Long-running transactions detected',
      description: `${longTransactions.length} transactions running >30s`,
      impact: 'HIGH',
      effort: 'MEDIUM',
      affectedTables: longTransactions.map(t => 'multiple').filter((v, i, a) => a.indexOf(v) === i),
      estimatedBenefit: 'Prevent lock contention and connection pool exhaustion',
    });
  }

  // Connection pressure
  if (connectionPressure.usagePercent > 80) {
    recommendations.push({
      type: 'CONFIG',
      priority: 'CRITICAL',
      title: 'Connection pool near exhaustion',
      description: `${connectionPressure.usagePercent}% of max connections in use`,
      impact: 'HIGH',
      effort: 'LOW',
      affectedTables: [],
      estimatedBenefit: 'Prevent connection pool exhaustion and request failures',
    });
  }

  // Table maintenance
  for (const table of tableStats.slice(0, 10)) {
    if (table.deadTuples > table.rowCount * 0.1 && table.rowCount > 1000) {
      recommendations.push({
        type: 'VACUUM',
        priority: 'MEDIUM',
        title: `Table ${table.tableName} needs vacuum`,
        description: `${table.deadTuples} dead tuples (${Math.round(table.deadTuples / table.rowCount * 100)}% of table)`,
        impact: 'MEDIUM',
        effort: 'LOW',
        sql: `VACUUM ANALYZE ${table.tableName};`,
        affectedTables: [table.tableName],
        estimatedBenefit: 'Reclaim space and improve query performance',
      });
    }
    if (!table.lastVacuum || (Date.now() - new Date(table.lastVacuum).getTime()) > 7 * 24 * 3600 * 1000) {
      recommendations.push({
        type: 'VACUUM',
        priority: 'LOW',
        title: `Table ${table.tableName} hasn't been vacuumed recently`,
        description: `Last vacuum: ${table.lastVacuum || 'never'}`,
        impact: 'LOW',
        effort: 'LOW',
        sql: `VACUUM ANALYZE ${table.tableName};`,
        affectedTables: [table.tableName],
        estimatedBenefit: 'Maintain statistics for query planner',
      });
    }
  }

  // Sort by priority
  const priorityOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return recommendations.sort((a, b) => priorityOrder[a.priority]! - priorityOrder[b.priority]!);
}

export async function getDbPerformanceReport(
  userId: string,
  projectId: string,
  options: { timeWindowMs?: number } = {}
): Promise<DbPerformanceReport> {
  return generateDbPerformanceReport(userId, projectId, options);
}

export function suggestIndexes(queryText: string, tablesScanned: string[]): string[] {
  const indexes: string[] = [];
  for (const table of tablesScanned) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const colPattern = new RegExp(`${escaped}\\.(\\w+)`, 'gi');
    const columns = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = colPattern.exec(queryText)) !== null) {
      columns.add(m[1]!);
    }
    if (columns.size > 0) {
      indexes.push(`CREATE INDEX ON ${table} (${[...columns].join(', ')}); -- suggested from query pattern`);
    } else {
      indexes.push(`CREATE INDEX ON ${table} (${table}_id); -- [inferred_column] please verify actual column`);
    }
  }
  return indexes;
}