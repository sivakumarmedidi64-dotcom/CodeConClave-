/**
 * CodeConClave — DeveloperWorkflowPanel tests (PKG-17).
 * Honest capability rendering, per-capability assessment wiring, result display,
 * and error states. Never fabricates developer-workflow or deploy/release results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DeveloperWorkflowPanel } from './DeveloperWorkflowPanel';

const cap = (description: string) => ({
  status: 'AVAILABLE',
  state: 'HEURISTIC',
  deterministic: true,
  needsProvider: false,
  description,
});

const caps = {
  capabilities: {
    MIGRATION_AGENT: cap('Advisory migration plan over static source.'),
    DOC_DRIFT: cap('Detects documentation drift vs source symbols/files.'),
    CONTEXTUAL_DEBUG: cap('Surfaces relevant source clues for an error signature.'),
    HOTSPOT_PROFILER: cap('Ranks performance hotspots from the oracle.'),
    BRANCH_STRATEGY: cap('Recommends a branching/merge strategy.'),
    ROLLBACK_PREDICTOR: cap('Scores rollback readiness/risk.'),
    HOTFIX_FAST_TRACK: cap('Minimal-change hotfix plan for an incident.'),
    FEATURE_FLAG_ORCH: cap('Inventories feature-flag conditionals.'),
    HEALTH_DASHBOARD: cap('Static workspace dev-health score.'),
    ERROR_RECOVERY_PLAYBOOK: cap('Advisory recovery playbook for an error.'),
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

describe('DeveloperWorkflowPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the ten honest, deterministic capability rails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(caps));
    await act(async () => {
      render(<DeveloperWorkflowPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('devworkflow-cap-migration_agent').textContent).toContain('Workspace Migration Agent');
    expect(screen.getByTestId('devworkflow-cap-error_recovery_playbook').textContent).toContain('AVAILABLE');
    expect(screen.getByTestId('devworkflow-honest').textContent).toContain('advisory');
  });

  it('runs the rollback predictor and displays readiness', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'dwr-1',
          projectId: 'prj-1',
          generatedAt: new Date().toISOString(),
          readinessScore: 67,
          risk: 'HIGH',
          signals: [{ label: 'database migrations present', risk: 'HIGH', detail: 'x' }],
          recommendedAction: 'Proceed with caution.',
          state: 'HEURISTIC',
          limitations: [],
        }),
      );
    await act(async () => {
      render(<DeveloperWorkflowPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('devworkflow-run-rollback_predictor'));
    });
    const calls = fetchMock.mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual([
      '/api/v1/developer-workflow/rollback-predictor',
      'POST',
      JSON.stringify({ projectId: 'prj-1' }),
    ]);
    expect(screen.getByTestId('devworkflow-rollback_predictor-result').textContent).toContain('readiness 67/100');
    expect(screen.getByTestId('devworkflow-rollback_predictor-result').textContent).toContain('risk HIGH');
  });

  it('displays findings for the doc-drift assessment', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'dwr-2',
          projectId: 'prj-1',
          generatedAt: new Date().toISOString(),
          docsScanned: 1,
          sourceFilesScanned: 1,
          findings: [{ id: 'dwd-1', docFilePath: 'README.md', kind: 'SYMBOL_NOT_FOUND', title: 'symbol "loadX" not defined', referenced: 'loadX', evidence: 'x', severity: 'MEDIUM', state: 'HEURISTIC' }],
          totalFindings: 1,
          highSeverityCount: 0,
          state: 'HEURISTIC',
          limitations: [],
        }),
      );
    await act(async () => {
      render(<DeveloperWorkflowPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('devworkflow-run-doc_drift'));
    });
    expect(screen.getByTestId('devworkflow-doc_drift-result').textContent).toContain('1 drift finding');
    expect(screen.getByTestId('devworkflow-doc_drift-result').textContent).toContain('symbol "loadX"');
  });

  it('shows an error state on failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(caps)).mockRejectedValueOnce(new Error('devworkflow_unknown_kind'));
    await act(async () => {
      render(<DeveloperWorkflowPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('devworkflow-run-health_dashboard'));
    });
    expect(screen.getByTestId('devworkflow-error').textContent).toContain('devworkflow_unknown_kind');
  });
});