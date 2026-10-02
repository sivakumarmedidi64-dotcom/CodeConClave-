/**
 * CodeConClave — Cost-Aware Refactoring (#20, PKG-16).
 * Correlates measured cost (from production-intelligence `getCostBreakdown`) with
 * refactoring opportunities (from engineering-intelligence `analyzeTechnicalDebt`)
 * to surface which refactors plausibly reduce spend, with best-effort ROI. This
 * consumes — never duplicates — the existing cost measurement and debt analysis.
 *
 * Honest model: `estimatedCostReductionUsd` and `roi` are HEURISTIC estimates on
 * top of measured/estimated cost data; confidence is 0 when no cost baseline exists.
 */
import { newId, PREFIX } from '../../shared/ids.js';
import { getCostBreakdown } from '../production-intelligence/costAnalysis.js';
import type { CostBreakdown, CostDriver } from '../production-intelligence/costAnalysis.js';
import { analyzeTechnicalDebt } from '../engineering-intelligence/debtSlayer.js';
import type { DebtAnalysisResult, DebtItem } from '../engineering-intelligence/debtSlayer.js';
import type { CostAwareRefactorReport, CostRefactorItem } from './types.js';

/** Map a debt item type to the cost categories its resolution most plausibly reduces. */
function costCategoriesForDebt(debtType: string): string[] {
  switch (debtType) {
    case 'code_smell':
    case 'duplicate_code':
      return ['TASK_EXECUTION', 'COMPUTE', 'AGENT_RUN'];
    case 'excessive_complexity':
      return ['AI_INFERENCE', 'AI_EMBEDDING', 'PROVIDER_API'];
    case 'large_function':
    case 'deep_nesting':
      return ['AI_INFERENCE', 'COMPUTE', 'TASK_EXECUTION'];
    case 'stale_code':
      return ['COMPUTE', 'STORAGE', 'TASK_EXECUTION'];
    case 'architectural_debt':
      return ['INFRASTRUCTURE', 'COMPUTE', 'STORAGE'];
    case 'test_debt':
      return ['TASK_EXECUTION', 'COMPUTE'];
    default:
      return ['COMPUTE', 'TASK_EXECUTION'];
  }
}

const PRIORITY: Record<string, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

function costForDriver(drivers: CostDriver[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const d of drivers) map.set(d.category, (map.get(d.category) ?? 0) + d.usd);
  return map;
}

function estimatedReduction(debt: DebtItem, categoryUsd: Map<string, number>): { reductionUsd: number; confidence: number; drivers: string[]; roi: number | null } {
  const categories = costCategoriesForDebt(debt.type);
  const measuredCategories = categories.filter((c) => categoryUsd.has(c));
  if (measuredCategories.length === 0) {
    return { reductionUsd: 0, confidence: 0, drivers: [], roi: null };
  }
  const impact = debt.estimatedImpact?.performance ?? 0;
  // Best-effort: a portion (0.05..0.35) of the attributable category spend is
  // plausibly reduced by resolving the debt; DEPENDS on severity + performance impact.
  const sevFactor = debt.severity === 'CRITICAL' ? 0.35 : debt.severity === 'HIGH' ? 0.22 : debt.severity === 'MEDIUM' ? 0.1 : 0.05;
  const impactFactor = 0.5 + Math.min(impact, 100) / 100;
  const reductionUsd = measuredCategories.reduce((sum, c) => sum + (categoryUsd.get(c) ?? 0) * sevFactor * impactFactor, 0);
  // ROI = reductionUsd per "refactor unit" (a neutral 1-effort heuristic).
  const roi = reductionUsd > 0 ? Math.round(reductionUsd * 10) / 10 : null;
  return { reductionUsd: Math.round(reductionUsd * 100) / 100, confidence: 0.4, drivers: measuredCategories, roi };
}

export async function buildCostAwareRefactor(
  userId: string,
  projectId: string,
): Promise<CostAwareRefactorReport> {
  const [costBreakdown, debtAnalysis] = await Promise.all([
    getCostBreakdown(userId, projectId),
    analyzeTechnicalDebt(userId, projectId),
  ]);
  const drivers = costBreakdown.topCostDrivers ?? [];
  const categoryUsd = costForDriver(drivers);
  const measuredUsd = costBreakdown.measuredUsd ?? 0;
  const costMeasureAvailable = drivers.length > 0 || measuredUsd > 0;

  const topDriver = drivers.length > 0 ? drivers[0] : null;
  const topCategory = topDriver?.category ?? null;
  const topUsd = topDriver?.usd ?? 0;

  const items: CostRefactorItem[] = (debtAnalysis.items ?? []).slice(0, 100).map((debt): CostRefactorItem => {
    const { reductionUsd, confidence, drivers: reducedDrivers, roi } = estimatedReduction(debt, categoryUsd);
    return {
      id: newId(PREFIX.OPTIMIZATION_COST_ITEM),
      title: debt.recommendation || `${debt.type} in ${(debt.affectedCode?.filePaths ?? ['?']).join(', ')}`,
      filePaths: debt.affectedCode?.filePaths ?? [],
      debtType: debt.type,
      costDriversReduced: reducedDrivers,
      estimatedCostReductionUsd: reductionUsd,
      confidence,
      roi,
      priority: PRIORITY[debt.severity] ?? 'MEDIUM',
      recommendation: debt.recommendation,
      state: 'HEURISTIC',
      evidence: `debt ${debt.type} (${debt.severity}); impact.performance=${debt.estimatedImpact?.performance ?? 0}`,
    };
  }).sort((a, b) => b.estimatedCostReductionUsd - a.estimatedCostReductionUsd);

  const totalEstimatedReductionUsd = Math.round(items.reduce((s, i) => s + i.estimatedCostReductionUsd, 0) * 100) / 100;

  return {
    id: newId(PREFIX.OPTIMIZATION_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    costMeasureAvailable,
    measuredUsd,
    topCostDriverCategory: topCategory,
    topCostDriverUsd: topUsd,
    items,
    totalIdentified: items.length,
    totalEstimatedReductionUsd,
    state: 'HEURISTIC',
    limitations: [
      'ROI and reduction are heuristic estimates layered on existing measured/estimated cost data.',
      'Confidence is 0 for items whose categories have no recorded cost.',
      'No refactor is auto-applied; these are prioritization signals only.',
    ],
  };
}

export type { CostBreakdown, DebtAnalysisResult, DebtItem };