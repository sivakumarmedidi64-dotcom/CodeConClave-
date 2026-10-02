/**
 * CodeConClave — QualityIntelligencePanel tests (PKG-14).
 * Honest capability rendering, analyze action wiring, findings display, and
 * error states. Never fabricates proven results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QualityIntelligencePanel } from './QualityIntelligencePanel';

const cap = (description: string) => ({
  status: 'AVAILABLE',
  state: 'HEURISTIC',
  deterministic: true,
  needsProvider: false,
  description,
});

const caps = {
  capabilities: {
    CODE_SMELL: cap('Code-smell heuristics.'),
    CONCURRENCY: cap('Race/ordering heuristic.'),
    MEMORY_LEAK: cap('Unbounded-retention heuristic.'),
    TYPE_SAFETY: cap('Unsound-typing detection.'),
    INVARIANT: cap('Invariant-gap detection.'),
  },
  limitations: ['Static heuristics only; advisory, not proof.'],
};

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe('QualityIntelligencePanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders honest deterministic capability rails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(caps));
    await act(async () => {
      render(<QualityIntelligencePanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('qi-cap-code_smell').textContent).toContain('Code Smell Agent');
    expect(screen.getByTestId('qi-cap-memory_leak').textContent).toContain('AVAILABLE');
    expect(screen.getByTestId('qi-honest').textContent).toContain('advisory');
  });

  it('analyzes a project and displays findings', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'qlt-1',
          projectId: 'prj-1',
          kinds: ['CODE_SMELL', 'CONCURRENCY', 'MEMORY_LEAK', 'TYPE_SAFETY', 'INVARIANT'],
          files: [{ fileId: 'f1', path: 'src/a.ts', analyzed: true }],
          findings: [
            {
              id: 'code_smell_0',
              kind: 'CODE_SMELL',
              filePath: 'src/a.ts',
              line: 1,
              rule: 'smell-magic-number',
              severity: 'LOW',
              title: 'Code smell: magic-number',
              description: 'Detected magic number pattern.',
              confidence: 1,
              state: 'VERIFIED',
              evidence: 'smell-magic-number',
              suggestion: 'Review and refactor.',
            },
          ],
          totals: { VERIFIED: 1, HEURISTIC: 0, UNAVAILABLE: 0, ENVIRONMENT_BLOCKED: 0, NOT_IMPLEMENTED: 0 },
          byKind: {
            CODE_SMELL: { findings: 1, bySeverity: { LOW: 1 } },
            CONCURRENCY: { findings: 0, bySeverity: {} },
            MEMORY_LEAK: { findings: 0, bySeverity: {} },
            TYPE_SAFETY: { findings: 0, bySeverity: {} },
            INVARIANT: { findings: 0, bySeverity: {} },
          },
          correlationId: 'qlt_1',
          generatedAt: new Date().toISOString(),
        }),
      );
    await act(async () => {
      render(<QualityIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('qi-analyze'));
    });
    const calls = fetchMock.mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual(['/api/v1/quality-intelligence/analyze', 'POST', JSON.stringify({ projectId: 'prj-1' })]);
    expect(screen.getByTestId('qi-findings-total').textContent).toBe('1');
    expect(screen.getByTestId('qi-finding').textContent).toContain('magic-number');
  });

  it('shows an error state on failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockRejectedValueOnce(new Error('quality_too_many_files'));
    await act(async () => {
      render(<QualityIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('qi-analyze'));
    });
    expect(screen.getByTestId('qi-error').textContent).toContain('quality_too_many_files');
    expect(screen.queryByTestId('qi-result')).toBeNull();
  });
});
