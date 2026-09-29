/**
 * CodeConClave — Optimization Intelligence Service (PKG-16).
 * Orchestrates the four Performance, Capacity & Cost Optimization capabilities
 * and exposes an honest capability report. All findings are deterministic and
 * advisory; no optimization is ever auto-applied.
 */
import { AppError } from '../../shared/errors.js';
import type {
  CapabilityStatus,
  OptimizationCapabilityReport,
  OptimizationKind,
  TruthfulnessState,
} from './types.js';

export const ALL_KINDS: OptimizationKind[] = [
  'PERFORMANCE_TIMELINE',
  'QUERY_OPTIMIZER',
  'BATCH_OPTIMIZER',
  'COST_REFACTORING',
];

export const KIND_DESCRIPTIONS: Record<OptimizationKind, string> = {
  PERFORMANCE_TIMELINE:
    'Consumes the performance report + project source to produce a source-level, ordered operation timeline with per-op estimated duration, parent chain, and hot-path attribution.',
  QUERY_OPTIMIZER:
    'Static, column-aware SQL parse over source queries to emit per-query rewrite + index (DDL) guidance, complementing runtime pg-stat analysis.',
  BATCH_OPTIMIZER:
    'Turns detected N+1 loops into quantified batch-rewrite plans (bulk WHERE IN, Promise.all, chunked concurrency) with projected query-count reduction.',
  COST_REFACTORING:
    'Correlates measured cost with refactoring opportunities to surface ROI and priority for cost-reducing refactors.',
};

export class OptimizationIntelligenceService {
  getCapabilities(): OptimizationCapabilityReport {
    const status: CapabilityStatus = 'AVAILABLE';
    const state: TruthfulnessState = 'HEURISTIC';
    const capabilities = {} as OptimizationCapabilityReport['capabilities'];
    for (const k of ALL_KINDS) {
      capabilities[k] = {
        status,
        state,
        deterministic: true,
        needsProvider: false,
        description: KIND_DESCRIPTIONS[k],
      };
    }
    return {
      capabilities,
      limitations: [
        'All analyses are deterministic heuristics/aggregations — advisory, not proof.',
        'Durations, query counts, and cost ROI are estimates derived from existing static/measured signals.',
        'Optimizations are never auto-applied; they are prioritization and guidance only.',
        'No runtime profiling, live explain-plan analysis, or spend forecasting is claimed.',
      ],
    };
  }

  assertKind(kind: string): OptimizationKind {
    if (!(ALL_KINDS as string[]).includes(kind)) {
      throw AppError.badRequest('optimization_unknown_kind', `Unknown capability kind: ${kind}`);
    }
    return kind as OptimizationKind;
  }
}

export const optimizationIntelligenceService = new OptimizationIntelligenceService();