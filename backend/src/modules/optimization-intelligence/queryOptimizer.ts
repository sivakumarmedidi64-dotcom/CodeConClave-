/**
 * CodeConClave — Database Query Optimizer (#17, PKG-16).
 * Consumes the existing `performanceOracle` `dbQueryRisks[]` and runs a precise,
 * defensive static SQL parse (see schemaUtil) to emit per-query rewrite and index
 * guidance. This complements — and does not re-implement — the runtime pg-stat
 * optimizer in `production-intelligence/dbPerformance.ts` (missing indexes,
 * sequence scans): here we reason about *source-level* SQL text.
 *
 * Honest model: every finding is a HEURISTIC advisory; DDL suggestions are
 * deterministic best-effort and never auto-applied.
 */
import { newId, PREFIX } from '../../shared/ids.js';
import { generatePerformanceReport } from '../engineering-intelligence/performanceOracle.js';
import { listSourceFilesSafe } from './security.js';
import {
  findUnindexedJoinColumns,
  hasLeadingWildcardLike,
  hasNonSargablePredicate,
  hasNotInSubquery,
  hasBroadResult,
  isSelectStar,
  normalizeSql,
  primaryTable,
  whereColumns,
} from './schemaUtil.js';
import type { QueryOptimization, QueryOptimizerReport, QueryRiskKind } from './types.js';

const SEVERITY: Record<QueryRiskKind, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
  SELECT_STAR: 'LOW',
  UNINDEXED_FK_JOIN: 'HIGH',
  LEADING_WILDCARD_LIKE: 'MEDIUM',
  NOT_IN_SUBQUERY: 'HIGH',
  UNINDEXED_WHERE: 'MEDIUM',
  LARGE_RESULT: 'LOW',
  NON_SARGABLE: 'MEDIUM',
};

const CROSSPROJECT_INDEX_COUNT = 3;

const REWRITES: Record<QueryRiskKind, string> = {
  SELECT_STAR: 'List only the columns the caller actually needs.',
  UNINDEXED_FK_JOIN: 'Ensure an index exists on the join column, or join on the primary key.',
  LEADING_WILDCARD_LIKE: 'Left-anchor the pattern or use full-text/trigram indexing.',
  NOT_IN_SUBQUERY: 'Prefer NOT EXISTS / anti-join for faster, clearer plans.',
  UNINDEXED_WHERE: 'Consider an index for the filter columns.',
  LARGE_RESULT: 'Add a selective WHERE and/or LIMIT.',
  NON_SARGABLE: 'Move the expression to the right side or use an expression index.',
};

const EVIDENCE: Record<QueryRiskKind, string> = {
  SELECT_STAR: 'SELECT *',
  UNINDEXED_FK_JOIN: 'equi-join non-primary column',
  LEADING_WILDCARD_LIKE: 'LIKE %…',
  NOT_IN_SUBQUERY: 'NOT IN (',
  UNINDEXED_WHERE: 'WHERE filter',
  LARGE_RESULT: 'broad read without where/limit',
  NON_SARGABLE: 'func(col) in WHERE',
};

/** Deterministic DDL builder for a given query/table. */
function suggestDdl(table: string | null, query: string, risk: QueryRiskKind): string[] {
  const ddl: string[] = [];
  if (risk === 'SELECT_STAR') {
    ddl.push('Rewrite the SELECT to list only the columns the caller actually needs.');
    return ddl;
  }
  if (risk === 'LEADING_WILDCARD_LIKE') {
    ddl.push('A leading-wildcard LIKE cannot use a plain index; prefer a left-anchored LIKE, full-text, or trigram index.');
    return ddl;
  }
  if (risk === 'NOT_IN_SUBQUERY') {
    ddl.push('Consider rewriting NOT IN (...) as NOT EXISTS (...) or an anti-join for clarity and plan quality.');
    return ddl;
  }
  if (risk === 'NON_SARGABLE') {
    ddl.push('Avoid applying functions to a column in WHERE; move the expression to the right-hand side or index an expression.');
    return ddl;
  }
  if (table) {
    const cols = whereColumns(query);
    if (cols.length === 0) {
      cols.push(risk === 'UNINDEXED_FK_JOIN' ? 'fk_id' : 'id');
    }
    const indexed = cols.slice(0, CROSSPROJECT_INDEX_COUNT).join(', ');
    ddl.push(`CREATE INDEX ON ${table} (${indexed});`);
  }
  return ddl;
}

export async function runQueryOptimizer(
  userId: string,
  projectId: string,
  requestedFileIds?: string[],
): Promise<QueryOptimizerReport> {
  const report = await generatePerformanceReport(userId, projectId);
  const risks = report.dbQueryRisks ?? [];
  const findings: QueryOptimization[] = [];
  const order: QueryRiskKind[] = ['UNINDEXED_FK_JOIN', 'NOT_IN_SUBQUERY', 'UNINDEXED_WHERE', 'LEADING_WILDCARD_LIKE', 'NON_SARGABLE', 'SELECT_STAR', 'LARGE_RESULT'];

  for (const risk of risks) {
    const query = risk.query || '';
    const norm = normalizeSql(query);
    const table = primaryTable(query);
    const touched = new Map<QueryRiskKind, string[]>();
    // kind -> { problems[] }

    if (isSelectStar(query)) {
      touched.set('SELECT_STAR', ['SELECT * returns unused columns, bloating transfer and join size.']);
    }
    const joins = findUnindexedJoinColumns(query);
    for (const j of joins.slice(0, 3)) {
      const key = 'UNINDEXED_FK_JOIN';
      if (!touched.has(key)) touched.set(key, []);
      const problems = touched.get(key)!;
      problems.push(`Equi-join on non-primary column "${j.rhsColumn}" of "${j.table}" may require a full scan on each join.`);
    }
    if (hasLeadingWildcardLike(query)) touched.set('LEADING_WILDCARD_LIKE', ['Leading-wildcard LIKE disables btree index usage.']);
    if (hasNotInSubquery(query)) touched.set('NOT_IN_SUBQUERY', ['NOT IN with un-NULL-safe comparisons can be slower/less optimizable.']);
    if (hasNonSargablePredicate(query)) touched.set('NON_SARGABLE', ['Function/expression applied to a WHERE column defeats a plain index.']);

    const whereCols = whereColumns(query);
    if (touched.size === 0 && whereCols.length === 0 && hasBroadResult(query)) {
      touched.set('LARGE_RESULT', ['Broad read with no WHERE and no LIMIT.']);
    }
    if (touched.size === 0 && whereCols.length > 0) {
      touched.set('UNINDEXED_WHERE', [`WHERE on non-indexed column(s): ${whereCols.join(', ')}.`]);
    }

    for (const kind of order) {
      if (!touched.has(kind)) continue;
      const problems = touched.get(kind)!;
      const rewrite = REWRITES[kind];
      const evidence = EVIDENCE[kind] + (kind === 'UNINDEXED_FK_JOIN' ? ` (${problems.join('; ')})` : '');
      findings.push({
        id: newId(PREFIX.OPTIMIZATION_QUERY),
        filePath: risk.filePath,
        query: norm.slice(0, 500),
        riskKind: kind,
        severity: SEVERITY[kind],
        problem: problems.join(' '),
        rewrite,
        suggestedDDL: suggestDdl(table, query, kind),
        state: 'HEURISTIC',
        evidence,
      });
    }
  }

  const dedup = new Set<string>();
  let dedupedIndexCount = 0;
  for (const f of findings) {
    const key = `${f.filePath}|${f.riskKind}`;
    if (dedup.has(key)) {
      dedupedIndexCount += 1;
    } else {
      dedup.add(key);
    }
  }

  return {
    id: newId(PREFIX.OPTIMIZATION_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    queriesOptimized: findings.length,
    criticalCount: findings.filter((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL').length,
    findings,
    dedupedIndexCount,
    state: 'HEURISTIC',
    limitations: [
      'Static source-text analysis only; does not inspect live execution plans.',
      'DDL suggestions are best-effort consensus of common patterns — not proven. Review per schema.',
      'runtime pg-stat missing-index detection lives in production-intelligence and is not duplicated here.',
      'Source files that are non-text/skipped are not parsed.',
    ],
  };
}

export type { QueryRiskKind };