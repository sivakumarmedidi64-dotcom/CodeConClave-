/**
 * CodeConClave — Performance Timeline (#16, PKG-16).
 * Consumes the existing `performanceOracle.generatePerformanceReport` (slow
 * functions + API latency risks) and project source to build a time-ordered,
 * source-level operation timeline. Each node records an approximate duration,
 * its parent chain, an operation kind, and hot-path attribution.
 *
 * Honest model: durations are ESTIMATED from static clues (a DB/await in a loop,
 * an external call, code-size heuristics) — never claimed to be real profiling.
 * The result carries an explicit truthfulness state.
 */
import { newId, PREFIX } from '../../shared/ids.js';
import type { PerformanceReport, SlowFunction, ApiLatencyRisk, NPlusOneDetection } from '../engineering-intelligence/performanceOracle.js';
import { generatePerformanceReport } from '../engineering-intelligence/performanceOracle.js';
import { listSourceFilesSafe } from './security.js';
import type {
  PerformanceTimelineReport,
  TimelineHotspot,
  TimelineOperation,
  TimelineOpKind,
} from './types.js';

/**
 * Extract a coarse, ordered sequence of operations from a source file by
 * scanning awaited/DB/API/loop points top-to-bottom. Deterministic line-order.
 */
function operationsFromSource(path: string, text: string, detected: { nPlusOnes: NPlusOneDetection[] }): TimelineOperation[] {
  const lines = text.split('\n');
  const ops: TimelineOperation[] = [];
  // A file that contains a detected N+1 loop means its repeated DB queries run in
  // a hot path regardless of exact line attribution.
  const fileHasNPlusOne = detected.nPlusOnes.some((n) => n.filePath === path);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const lineNo = i + 1;
    let kind: TimelineOpKind | null = null;
    let label = '';
    let duration = 0;
    let isHotPath = false;
    const line = raw.trim();

    if (/SELECT\s+.*\bFROM\b/i.test(line) || /pool\.query|\.query\s*\(|\.find\s*\(|\.findOne\s*\(/.test(line)) {
      kind = 'DB_QUERY';
      label = 'Database query';
      duration = 40;
      isHotPath = fileHasNPlusOne;
    } else if (/fetch\s*\(|axios|\.get\s*\(|request\s*\(|invoke\s*\(|http\s*\./.test(line)) {
      kind = 'EXTERNAL_API';
      label = 'External API call';
      duration = 120;
    } else if (/\bawait\b/.test(line)) {
      kind = 'SEQUENTIAL_AWAIT';
      label = 'Sequential await';
      duration = 30;
    } else if (/^\s*for\s*\(|^\s*for\s+.*\bof\b|forEach\s*\(/.test(raw)) {
      kind = 'LOOP';
      label = 'Loop';
      duration = 20;
    } else if (/function\s+\w+|=>\s*\{|const\s+\w+\s*=\s*\(/.test(line)) {
      kind = 'CPU_COMPUTE';
      label = 'Computation block';
      duration = 5;
    }

    if (!kind) continue;
    ops.push({
      id: newId(PREFIX.OPTIMIZATION_TIMELINE_OP),
      filePath: path,
      line: lineNo,
      parentId: null,
      kind,
      label,
      estimatedDurationMs: duration,
      source: 'ESTIMATED',
      isHotPath,
      children: [],
      evidence: line.slice(0, 200),
      state: 'HEURISTIC',
    });
  }
  return ops;
}

/** Merge the coarse source ops with slow-function duration evidence. */
function withSlowFunctionEvidence(
  path: string,
  ops: TimelineOperation[],
  slow: SlowFunction[],
): TimelineOperation[] {
  const slowForFile = slow.filter((s) => s.filePath === path);
  if (slowForFile.length === 0) return ops;
  const slowest = slowForFile.slice().sort((a, b) => b.estimatedDurationMs - a.estimatedDurationMs)[0]!;
  return ops.map((op) => {
    return {
      ...op,
      label: op.label.includes(slowest.functionName) ? op.label : `${slowest.functionName}: ${op.label}`,
      estimatedDurationMs: Math.max(op.estimatedDurationMs, slowest.estimatedDurationMs),
      evidence: slowest.reason || op.evidence,
      state: 'HEURISTIC',
    };
  });
}

export async function buildPerformanceTimeline(
  userId: string,
  projectId: string,
  requestedFileIds?: string[],
): Promise<PerformanceTimelineReport> {
  const report = await generatePerformanceReport(userId, projectId);
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId, requestedFileIds);

  const operations: TimelineOperation[] = [];
  const hotPathCountReport = report.apiLatencyRisks.length;
  const slowHints = report.slowFunctions ?? [];

  for (const file of analyzable) {
    const ops = operationsFromSource(file.path, file.text, { nPlusOnes: report.nPlusOnes ?? [] });
    const merged = withSlowFunctionEvidence(file.path, ops, slowHints);
    operations.push(...merged);
  }

  // Attribute time-heavy segments from API latency risks (routes).
  for (const risk of report.apiLatencyRisks ?? []) {
    operations.push({
      id: newId(PREFIX.OPTIMIZATION_TIMELINE_OP),
      filePath: risk.endpoint,
      line: null,
      parentId: null,
      kind: 'HANDLER',
      label: `${risk.method} ${risk.endpoint}`,
      estimatedDurationMs: risk.estimatedP99Ms,
      source: risk.source,
      isHotPath: risk.bottlenecks.length > 0,
      children: [],
      evidence: (risk.bottlenecks ?? []).join('; '),
      state: 'HEURISTIC',
    });
  }

  const hotspots = [...operations]
    .sort((a, b) => b.estimatedDurationMs - a.estimatedDurationMs)
    .slice(0, 10)
    .filter((o) => o.estimatedDurationMs > 0)
    .map<TimelineHotspot>((o) => ({
      filePath: o.filePath,
      label: o.label,
      estimatedDurationMs: o.estimatedDurationMs,
      isHotPath: o.isHotPath,
      source: o.source,
    }));

  const totalDurationMs = operations.reduce((sum, o) => sum + (o.estimatedDurationMs || 0), 0);

  return {
    id: newId(PREFIX.OPTIMIZATION_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    operations,
    totalDurationMs,
    hotPathCount: operations.filter((o) => o.isHotPath).length + hotPathCountReport,
    hotspots,
    state: 'HEURISTIC',
    limitations: [
      'Durations are ESTIMATED from static source text — not real profiling.',
      'Timeline is a code-level operation order, not a runtime request trace.',
      `${skipped.length} non-text/skipped files were not included.`,
    ],
  };
}

export type { PerformanceReport, SlowFunction, ApiLatencyRisk };