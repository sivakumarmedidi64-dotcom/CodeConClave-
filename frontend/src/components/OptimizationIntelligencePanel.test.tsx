/**
 * CodeConClave — OptimizationIntelligencePanel tests (PKG-16).
 * Honest capability rendering, per-capability assessment wiring, result
 * display, and error states. Never fabricates proven optimization results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { OptimizationIntelligencePanel } from './OptimizationIntelligencePanel';

const cap = (description: string) => ({
  status: 'AVAILABLE',
  state: 'HEURISTIC',
  deterministic: true,
  needsProvider: false,
  description,
});

const caps = {
  capabilities: {
    PERFORMANCE_TIMELINE: cap('Ordered, source-level operation timeline with hot-path attribution.'),
    QUERY_OPTIMIZER: cap('Static column-aware SQL parse emitting per-query rewrite + DDL guidance.'),
    BATCH_OPTIMIZER: cap('Quantified batch-rewrite plans for detected N+1 loops.'),
    COST_REFACTORING: cap('ROI and priority for cost-reducing refactors.'),
  },
  limitations: ['Deterministic heuristics/estimates only; advisory, not proof.'],
};

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe('OptimizationIntelligencePanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the four honest, deterministic capability rails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(caps));
    await act(async () => {
      render(<OptimizationIntelligencePanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('opt-cap-performance_timeline').textContent).toContain('Performance Timeline');
    expect(screen.getByTestId('opt-cap-cost_refactoring').textContent).toContain('AVAILABLE');
    expect(screen.getByTestId('opt-honest').textContent).toContain('advisory');
  });

  it('runs the query optimizer and displays findings and DDL', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'opr-1',
          projectId: 'prj-1',
          generatedAt: new Date().toISOString(),
          queriesOptimized: 1,
          criticalCount: 1,
          dedupedIndexCount: 1,
          state: 'HEURISTIC',
          findings: [
            {
              id: 'opq-1',
              filePath: 'src/queries.ts',
              query: 'SELECT * FROM orders o JOIN users u ON o.user_id = u.id',
              riskKind: 'UNINDEXED_FK_JOIN',
              severity: 'HIGH',
              problem: 'join on non-primary column user_id',
              rewrite: 'select specific columns',
              suggestedDDL: ['CREATE INDEX idx_orders_user_id ON orders(user_id);'],
              state: 'HEURISTIC',
              evidence: 'equi-join on o.user_id',
            },
          ],
        }),
      );
    await act(async () => {
      render(<OptimizationIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('opt-run-query_optimizer'));
    });
    const calls = fetchMock.mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual([
      '/api/v1/optimization-intelligence/query-optimizer',
      'POST',
      JSON.stringify({ projectId: 'prj-1' }),
    ]);
    expect(screen.getByTestId('opt-query').textContent).toContain('1 critical');
    expect(screen.getByTestId('opt-query-finding').textContent).toContain('CREATE INDEX idx_orders_user_id');
  });

  it('runs the batch optimizer and displays the reduction summary', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'opr-2',
          projectId: 'prj-1',
          generatedAt: new Date().toISOString(),
          state: 'HEURISTIC',
          plans: [],
          totalQueriesBefore: 100,
          totalQueriesAfter: 10,
          totalReductionCount: 90,
          totalReductionPercent: 90,
        }),
      );
    await act(async () => {
      render(<OptimizationIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('opt-run-batch_optimizer'));
    });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('/api/v1/optimization-intelligence/batch-optimizer');
    expect(screen.getByTestId('opt-batch').textContent).toContain('−90%');
  });

  it('shows an error state on failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(caps)).mockRejectedValueOnce(new Error('opt_unknown_kind'));
    await act(async () => {
      render(<OptimizationIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('opt-run-cost_refactoring'));
    });
    expect(screen.getByTestId('opt-error').textContent).toContain('opt_unknown_kind');
  });
});
