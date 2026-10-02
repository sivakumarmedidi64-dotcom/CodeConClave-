/**
 * CodeConClave — Optimization Intelligence Types (PKG-16).
 * Canonical types for Performance, Capacity & Cost Optimization Intelligence:
 *   #16 Performance Timeline
 *   #17 Database Query Optimizer
 *   #19 Batch Processing Optimizer
 *   #20 Cost-Aware Refactoring
 * Every finding carries an explicit truthfulness state so callers never mistake a
 * heuristic estimate for a measured/proven fact.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Capability identity + status
// ---------------------------------------------------------------------------

export const OptimizationKind = z.enum([
  'PERFORMANCE_TIMELINE', // #16
  'QUERY_OPTIMIZER',      // #17
  'BATCH_OPTIMIZER',      // #19
  'COST_REFACTORING',     // #20
]);
export type OptimizationKind = z.infer<typeof OptimizationKind>;

export const CapabilityStatus = z.enum([
  'AVAILABLE',
  'UNAVAILABLE',
  'ENVIRONMENT_BLOCKED',
  'NOT_IMPLEMENTED',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const TruthfulnessState = z.enum([
  'VERIFIED',
  'HEURISTIC',
  'PROVIDER_REQUIRED',
  'ENVIRONMENT_BLOCKED',
  'UNAVAILABLE',
]);
export type TruthfulnessState = z.infer<typeof TruthfulnessState>;

/** Approximation source reused from the performance oracle. */
export type MeasurementSource = 'MEASURED' | 'ESTIMATED' | 'UNKNOWN';

export const OptimizationReportInputSchema = z.object({
  projectId: z.string().min(1).max(200),
});
export type OptimizationReportInput = z.infer<typeof OptimizationReportInputSchema>;

// ---------------------------------------------------------------------------
// #16 — Performance Timeline
// ---------------------------------------------------------------------------

export const TimelineOpKind = z.enum([
  'DB_QUERY',
  'EXTERNAL_API',
  'SEQUENTIAL_AWAIT',
  'CPU_COMPUTE',
  'LOOP',
  'HANDLER',
]);
export type TimelineOpKind = z.infer<typeof TimelineOpKind>;

export interface TimelineOperation {
  id: string;
  filePath: string;
  line: number | null;
  parentId: string | null;
  kind: TimelineOpKind;
  label: string;
  estimatedDurationMs: number;
  source: MeasurementSource;
  isHotPath: boolean;
  children: TimelineOperation[];
  evidence: string;
  state: TruthfulnessState;
}

export interface TimelineHotspot {
  filePath: string;
  label: string;
  estimatedDurationMs: number;
  isHotPath: boolean;
  source: MeasurementSource;
}

export interface PerformanceTimelineReport {
  id: string;
  projectId: string;
  generatedAt: string;
  operations: TimelineOperation[];
  totalDurationMs: number;
  hotPathCount: number;
  hotspots: TimelineHotspot[];
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #17 — Database Query Optimizer
// ---------------------------------------------------------------------------

export const QueryRiskKind = z.enum([
  'SELECT_STAR',
  'UNINDEXED_FK_JOIN',
  'LEADING_WILDCARD_LIKE',
  'NOT_IN_SUBQUERY',
  'UNINDEXED_WHERE',
  'LARGE_RESULT',
  'NON_SARGABLE',
]);
export type QueryRiskKind = z.infer<typeof QueryRiskKind>;

export interface QueryOptimization {
  id: string;
  filePath: string;
  query: string;
  riskKind: QueryRiskKind;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  problem: string;
  rewrite: string;
  suggestedDDL: string[];
  state: TruthfulnessState;
  evidence: string;
}

export interface QueryOptimizerReport {
  id: string;
  projectId: string;
  generatedAt: string;
  queriesOptimized: number;
  criticalCount: number;
  findings: QueryOptimization[];
  dedupedIndexCount: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #19 — Batch Processing Optimizer
// ---------------------------------------------------------------------------

export const BatchStrategy = z.enum([
  'BULK_WHERE_IN',
  'PROMISE_ALL',
  'CHUNKED_CONCURRENCY',
  'DATALOADER',
]);
export type BatchStrategy = z.infer<typeof BatchStrategy>;

export interface BatchRewritePlan {
  id: string;
  filePath: string;
  loopContext: string;
  queriesBefore: number;
  queriesAfter: number;
  reductionCount: number;
  reductionPercent: number;
  strategy: BatchStrategy;
  chunkSize: number | null;
  suggestedCode: string;
  state: TruthfulnessState;
  evidence: string;
}

export interface BatchOptimizerReport {
  id: string;
  projectId: string;
  generatedAt: string;
  plans: BatchRewritePlan[];
  totalQueriesBefore: number;
  totalQueriesAfter: number;
  totalReductionCount: number;
  totalReductionPercent: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// #20 — Cost-Aware Refactoring
// ---------------------------------------------------------------------------

export interface CostRefactorItem {
  id: string;
  title: string;
  filePaths: string[];
  debtType: string;
  costDriversReduced: string[];
  estimatedCostReductionUsd: number;
  confidence: number;
  roi: number | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendation: string;
  state: TruthfulnessState;
  evidence: string;
}

export interface CostAwareRefactorReport {
  id: string;
  projectId: string;
  generatedAt: string;
  costMeasureAvailable: boolean;
  measuredUsd: number;
  topCostDriverCategory: string | null;
  topCostDriverUsd: number;
  items: CostRefactorItem[];
  totalIdentified: number;
  totalEstimatedReductionUsd: number;
  state: TruthfulnessState;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

export interface OptimizationCapabilityReport {
  capabilities: Record<
    OptimizationKind,
    {
      status: CapabilityStatus;
      state: TruthfulnessState;
      deterministic: boolean;
      needsProvider: boolean;
      description: string;
    }
  >;
  limitations: string[];
}