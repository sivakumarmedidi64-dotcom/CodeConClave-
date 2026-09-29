/**
 * CodeConClave — PKG-16 Optimization Intelligence panel.
 * Honest, server-authoritative Performance, Capacity & Cost Optimization
 * Intelligence: Performance Timeline (#16), Database Query Optimizer (#17),
 * Batch Processing Optimizer (#19), Cost-Aware Refactoring (#20). All reports
 * are advisory estimates/guidance with truthfulness state — never auto-applied
 * and never presented as proof.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

type Kind = 'PERFORMANCE_TIMELINE' | 'QUERY_OPTIMIZER' | 'BATCH_OPTIMIZER' | 'COST_REFACTORING';

interface CapEntry {
  status: string;
  state: string;
  deterministic: boolean;
  needsProvider: boolean;
  description: string;
}
interface OptCaps {
  capabilities: Record<Kind, CapEntry>;
  limitations: string[];
}

interface TimelineOp {
  id: string;
  filePath: string;
  line: number | null;
  kind: string;
  label: string;
  estimatedDurationMs: number;
  isHotPath: boolean;
  evidence: string;
}
interface TimelineReport {
  id: string;
  projectId: string;
  generatedAt: string;
  operations: TimelineOp[];
  totalDurationMs: number;
  hotPathCount: number;
  state: string;
}

interface QueryFinding {
  id: string;
  filePath: string;
  query: string;
  riskKind: string;
  severity: string;
  problem: string;
  rewrite: string;
  suggestedDDL: string[];
  state: string;
}
interface QueryReport {
  id: string;
  projectId: string;
  generatedAt: string;
  queriesOptimized: number;
  criticalCount: number;
  findings: QueryFinding[];
  dedupedIndexCount: number;
  state: string;
}

interface BatchPlan {
  id: string;
  filePath: string;
  loopContext: string;
  queriesBefore: number;
  queriesAfter: number;
  reductionCount: number;
  reductionPercent: number;
  strategy: string;
  chunkSize: number | null;
  state: string;
}
interface BatchReport {
  id: string;
  projectId: string;
  generatedAt: string;
  plans: BatchPlan[];
  totalQueriesBefore: number;
  totalQueriesAfter: number;
  totalReductionCount: number;
  totalReductionPercent: number;
  state: string;
}

interface CostItem {
  id: string;
  title: string;
  filePaths: string[];
  debtType: string;
  costDriversReduced: string[];
  estimatedCostReductionUsd: number;
  confidence: number;
  roi: number | null;
  priority: string;
  state: string;
  recommendation?: string;
}
interface CostReport {
  id: string;
  projectId: string;
  generatedAt: string;
  costMeasureAvailable: boolean;
  measuredUsd: number;
  topCostDriverCategory: string | null;
  topCostDriverUsd: number;
  items: CostItem[];
  totalIdentified: number;
  totalEstimatedReductionUsd: number;
  state: string;
}

const KIND_LABEL: Record<Kind, string> = {
  PERFORMANCE_TIMELINE: 'Performance Timeline',
  QUERY_OPTIMIZER: 'Database Query Optimizer',
  BATCH_OPTIMIZER: 'Batch Processing Optimizer',
  COST_REFACTORING: 'Cost-Aware Refactoring',
};

const STATE_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  HEURISTIC: 'heuristic only',
  PROVIDER_REQUIRED: 'provider required',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
  UNAVAILABLE: 'unavailable',
};

const ALL_KINDS: Kind[] = ['PERFORMANCE_TIMELINE', 'QUERY_OPTIMIZER', 'BATCH_OPTIMIZER', 'COST_REFACTORING'];

export function OptimizationIntelligencePanel({ projectId }: { projectId: string }) {
  const [caps, setCaps] = useState<OptCaps | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<TimelineReport | null>(null);
  const [query, setQuery] = useState<QueryReport | null>(null);
  const [batch, setBatch] = useState<BatchReport | null>(null);
  const [cost, setCost] = useState<CostReport | null>(null);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const c = await api<OptCaps>('/api/v1/optimization-intelligence/capabilities');
      setCaps(c);
      setCapsState('ready');
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const run = useCallback(
    async (kind: Kind) => {
      setBusy(true);
      setError(null);
      try {
        if (kind === 'PERFORMANCE_TIMELINE') {
          const rep = await api<TimelineReport>('/api/v1/optimization-intelligence/timeline', {
            method: 'POST',
            body: { projectId },
          });
          setTimeline(rep);
        } else if (kind === 'QUERY_OPTIMIZER') {
          const rep = await api<QueryReport>('/api/v1/optimization-intelligence/query-optimizer', {
            method: 'POST',
            body: { projectId },
          });
          setQuery(rep);
        } else if (kind === 'BATCH_OPTIMIZER') {
          const rep = await api<BatchReport>('/api/v1/optimization-intelligence/batch-optimizer', {
            method: 'POST',
            body: { projectId },
          });
          setBatch(rep);
        } else {
          const rep = await api<CostReport>('/api/v1/optimization-intelligence/cost-refactoring', {
            method: 'POST',
            body: { projectId },
          });
          setCost(rep);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Assessment failed');
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  return (
    <div data-testid="opt-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Performance, Capacity & Cost Optimization</h2>

      <section data-testid="opt-capabilities" className="rounded border p-3">
        <h3 className="text-sm font-medium">Optimization intelligence capabilities</h3>
        {capsState === 'loading' && <p data-testid="opt-caps-loading">Loading capability status…</p>}
        {capsState === 'error' && <p data-testid="opt-caps-error">Could not load capability status.</p>}
        {capsState === 'ready' && caps && (
          <div className="mt-2 space-y-2 text-sm">
            {ALL_KINDS.map((kind) => {
              const cap = caps.capabilities[kind];
              return (
                <div key={kind} data-testid={`opt-cap-${kind.toLowerCase()}`} className="flex items-start gap-2">
                  <button
                    data-testid={`opt-run-${kind.toLowerCase()}`}
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void run(kind)}
                  >
                    {KIND_LABEL[kind]}
                  </button>
                  <div>
                    <div>
                      <span className="text-xs text-gray-500">
                        [{cap?.status ?? 'unknown'} · {STATE_LABEL[cap?.state ?? ''] ?? cap?.state ?? 'unknown'}]
                      </span>
                    </div>
                    <p data-testid={`opt-desc-${kind.toLowerCase()}`} className="text-xs text-gray-600">
                      {cap?.description ?? ''}
                    </p>
                  </div>
                </div>
              );
            })}
            <p data-testid="opt-honest" className="text-xs text-amber-700">
              Deterministic heuristics and estimates. Findings are advisory optimization guidance with truthfulness
              state — never proof and never auto-applied.
            </p>
          </div>
        )}
      </section>

      {error && <p data-testid="opt-error" className="text-sm text-red-600">{error}</p>}

      {timeline && (
        <section data-testid="opt-timeline" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">
            Performance Timeline — {timeline.operations.length} ops · {timeline.totalDurationMs}ms estimated ·{' '}
            {timeline.hotPathCount} hot paths ({STATE_LABEL[timeline.state] ?? timeline.state})
          </h3>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
            {timeline.operations.map((op) => (
              <li key={op.id} data-testid="opt-op" className="rounded border p-1 text-xs">
                {op.label} — {op.estimatedDurationMs}ms [{op.kind}
                {op.line != null ? ` @${op.filePath}:${op.line}` : ''}]
                {op.isHotPath ? <><Icon name="bolt" size={12} /> hot</> : ''}
                {op.evidence ? <p className="text-gray-600">{op.evidence}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {query && (
        <section data-testid="opt-query" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">
            Database Query Optimizer — {query.queriesOptimized} queries · {query.criticalCount} critical ·{' '}
            {query.dedupedIndexCount} deduped index advice ({STATE_LABEL[query.state] ?? query.state})
          </h3>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
            {query.findings.map((f) => (
              <li key={f.id} data-testid="opt-query-finding" className="rounded border p-1 text-xs">
                <strong>[{f.severity}]</strong> {f.riskKind} — {f.problem} ({f.filePath})
                {f.rewrite ? <p className="text-gray-700">Rewrite: {f.rewrite}</p> : null}
                {f.suggestedDDL.length > 0 && (
                  <p className="text-gray-600">DDL: {f.suggestedDDL.join(' ')}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {batch && (
        <section data-testid="opt-batch" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">
            Batch Processing Optimizer — {batch.plans.length} plans · {batch.totalQueriesBefore} →{' '}
            {batch.totalQueriesAfter} queries (−{batch.totalReductionPercent}%)
          </h3>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
            {batch.plans.map((p) => (
              <li key={p.id} data-testid="opt-batch-plan" className="rounded border p-1 text-xs">
                <strong>[{p.strategy}]</strong> {p.loopContext} ({p.filePath}) — {p.queriesBefore} →{' '}
                {p.queriesAfter} (−{p.reductionCount})
                {p.chunkSize != null ? ` · chunk ${p.chunkSize}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {cost && (
        <section data-testid="opt-cost" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">
            Cost-Aware Refactoring — {cost.totalIdentified} items · ~${cost.totalEstimatedReductionUsd} estimated
            reduction · top driver:{' '}
            {cost.topCostDriverCategory ? `${cost.topCostDriverCategory} ($${cost.topCostDriverUsd})` : 'none'}
          </h3>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto">
            {cost.items.map((item) => (
              <li key={item.id} data-testid="opt-cost-item" className="rounded border p-1 text-xs">
                <strong>[{item.priority}]</strong> {item.title} — ~${item.estimatedCostReductionUsd} (
                {item.costDriversReduced.join(', ') || 'no measured drivers'})
                {item.recommendation ? <p className="text-gray-600">{item.recommendation}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {caps?.limitations?.length ? (
        <p data-testid="opt-limitations" className="text-xs text-amber-700">
          {caps.limitations.join(' ')}
        </p>
      ) : null}
    </div>
  );
}
