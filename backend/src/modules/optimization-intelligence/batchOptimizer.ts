/**
 * CodeConClave — Batch Processing Optimizer (#19, PKG-16).
 * Consumes the existing `performanceOracle` N+1 detections (`nPlusOnes[]`) — the
 * detector already locates single-item fetches inside loops — and turns each into
 * a concrete, quantified batch-rewrite plan: bulk `WHERE IN (...)` fetch, `Promise.all`
 * fan-out, or chunked concurrency with a bounded chunk size.
 *
 * Honest model: `queriesBefore/After` are derived deterministically from the loop
 * context; they are advisory estimates, never auto-applied.
 */
import { newId, PREFIX } from '../../shared/ids.js';
import { generatePerformanceReport } from '../engineering-intelligence/performanceOracle.js';
import type { NPlusOneDetection } from '../engineering-intelligence/performanceOracle.js';
import type { BatchRewritePlan, BatchOptimizerReport, BatchStrategy } from './types.js';

const DEFAULT_BULK_CAP = 200;
const DEFAULT_CHUNK = 50;

function planForDetection(det: NPlusOneDetection, index: number): BatchRewritePlan {
  const queriesBefore = det.estimatedQueries > 0 ? det.estimatedQueries : 10;
  const loopBody = det.loopContext || det.pattern || 'iteratingItems';
  const subject = guessSubject(loopBody);

  let strategy: BatchStrategy = 'BULK_WHERE_IN';
  let chunkSize: number | null = null;
  let queriesAfter: number;
  let suggestedCode: string;

  if (queriesBefore > DEFAULT_BULK_CAP * 2) {
    strategy = 'CHUNKED_CONCURRENCY';
    chunkSize = DEFAULT_CHUNK;
    queriesAfter = Math.ceil(queriesBefore / DEFAULT_CHUNK);
    suggestedCode =
      `const ids = ${subject}.map(item => item.id);\n` +
      `const batches = chunk(ids, ${DEFAULT_CHUNK});\n` +
      `const rows = await Promise.all(batches.map(b => fetchMany(b)));\n` +
      `const byId = new Map(rows.flat().map(r => [r.id, r]));`;
  } else if (isAsyncDependent(loopBody)) {
    strategy = 'PROMISE_ALL';
    chunkSize = null;
    queriesAfter = 1;
    suggestedCode =
      `const results = await Promise.all(${subject}.map(item => fetchOne(item)));`;
  } else {
    strategy = 'BULK_WHERE_IN';
    chunkSize = null;
    queriesAfter = 1;
    suggestedCode =
      `const ids = ${subject}.map(item => item.id);\n` +
      `const rows = await fetchMany(ids); // WHERE id IN (...)\n` +
      `const byId = new Map(rows.map(r => [r.id, r]));`;
  }

  const reductionCount = queriesBefore - queriesAfter;
  const reductionPercent = queriesBefore > 0 ? Math.round((reductionCount / queriesBefore) * 100) : 0;

  return {
    id: newId(PREFIX.OPTIMIZATION_BATCH),
    filePath: det.filePath,
    loopContext: loopBody,
    queriesBefore,
    queriesAfter,
    reductionCount,
    reductionPercent,
    strategy,
    chunkSize,
    suggestedCode,
    state: 'HEURISTIC',
    evidence: det.fixSuggestion || `${det.estimatedQueries} single-item queries inside a loop`,
  };
}

/** Guess a stable plural subject (array) name from loop/finder text. */
function guessSubject(loopContext: string): string {
  const m = /\bfor\b[^\n]*?\bof\s+(\w+)/.exec(loopContext) || /\bfor\b[^\n]*?(\w+)\s*\)/.exec(loopContext);
  if (m?.[1] && m[1].toLowerCase() !== 'const') return m[1];
  return 'items';
}

/** Conservative heuristic: if the body awaits inside a loop with mapping/fetching, parallelize. */
function isAsyncDependent(loopBody: string): boolean {
  return /await|\bfetch\b|\.find\b|\.findOne\b|\.get\b|\bquery\b/.test(loopBody);
}

export async function runBatchOptimizer(
  userId: string,
  projectId: string,
): Promise<BatchOptimizerReport> {
  const report = await generatePerformanceReport(userId, projectId);
  const detections = report.nPlusOnes ?? [];

  const plans = detections.map((d, i) => planForDetection(d, i));

  const totalQueriesBefore = plans.reduce((s, p) => s + p.queriesBefore, 0);
  const totalQueriesAfter = plans.reduce((s, p) => s + p.queriesAfter, 0);
  const totalReductionCount = plans.reduce((s, p) => s + p.reductionCount, 0);
  const totalReductionPercent =
    totalQueriesBefore > 0 ? Math.round((totalReductionCount / totalQueriesBefore) * 100) : 0;

  return {
    id: newId(PREFIX.OPTIMIZATION_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    plans,
    totalQueriesBefore,
    totalQueriesAfter,
    totalReductionCount,
    totalReductionPercent,
    state: 'HEURISTIC',
    limitations: [
      'Plans are generated from static loop patterns — advisory, not applied.',
      'Query counts are estimates derived from the N+1 detector, not measured.',
      'Bulk/chunk strategies assume an id-keyed entity; confirm the real shape before applying.',
    ],
  };
}