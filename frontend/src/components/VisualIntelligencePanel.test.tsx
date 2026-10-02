/**
 * CodeConClave — VisualIntelligencePanel tests (PKG-13).
 * Honest capability rendering, analyze action wiring, results display, and
 * error states. Never fabricates real vision.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VisualIntelligencePanel } from './VisualIntelligencePanel';

const caps = {
  vision: 'ENVIRONMENT_BLOCKED',
  ocr: 'UNAVAILABLE',
  multimodal: 'ENVIRONMENT_BLOCKED',
  pixelComparison: 'NOT_IMPLEMENTED',
  screenshotUnderstanding: 'ENVIRONMENT_BLOCKED',
  visualDebugging: 'ENVIRONMENT_BLOCKED',
  uiToCode: 'AVAILABLE',
  uiAnalysis: 'UNAVAILABLE',
  limitations: ['No vision-capable AI model is configured on this server.'],
  details: { realProvider: false },
};

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe('VisualIntelligencePanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders honest capability status when no real provider exists', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(caps));
    await act(async () => {
      render(<VisualIntelligencePanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('vi-cap-vision')).toHaveTextContent('environment-blocked');
    expect(screen.getByTestId('vi-cap-ocr')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('vi-cap-multimodal')).toHaveTextContent('environment-blocked');
    expect(screen.getByTestId('vi-honest').textContent).toContain('No real vision provider');
  });

  it('analyzes an image by file id and displays the result', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'vis-1',
          type: 'UI',
          state: 'HEURISTIC',
          provider: 'local-heuristics',
          confidence: 0.4,
          limitations: ['Metadata only; no pixel understanding.'],
          findings: [
            {
              id: 'f1',
              type: 'ORIENTATION',
              severity: 'LOW',
              title: 'Orientation heuristic',
              description: 'landscape',
              confidence: 0.6,
              evidence: 'width=800, height=600',
            },
          ],
          metadata: { format: 'png', width: 800, height: 600, fileSizeBytes: 1024 },
        }),
      );
    await act(async () => {
      render(<VisualIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('vi-file-id'), { target: { value: 'fil-1' } });
      fireEvent.click(screen.getByTestId('vi-analyze'));
    });
    const calls = fetchMock.mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual([
      '/api/v1/visual-intelligence/analyze',
      'POST',
      JSON.stringify({ imageFileId: 'fil-1', projectId: 'prj-1', analysisType: 'SCREENSHOT' }),
    ]);
    expect(screen.getByTestId('vi-state')).toHaveTextContent('heuristic only');
    expect(screen.getByTestId('vi-finding')).toHaveTextContent('Orientation heuristic');
  });

  it('shows an error state on failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockRejectedValueOnce(new Error('file_access_denied'));
    await act(async () => {
      render(<VisualIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('vi-file-id'), { target: { value: 'fil-x' } });
      fireEvent.click(screen.getByTestId('vi-analyze'));
    });
    expect(screen.getByTestId('vi-error').textContent).toContain('file_access_denied');
    expect(screen.queryByTestId('vi-result')).toBeNull();
  });

  it('generates an advisory code proposal marked review-required', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'proposal-1',
          language: 'typescript',
          code: 'export const placeholder = true;',
          description: 'Advisory',
          evidence: [],
          assumptions: [],
          riskLevel: 'HIGH',
          reviewRequired: true,
          reviewTarget: 'COWORK_REVIEW',
          correlationId: 'c1',
        }),
      );
    await act(async () => {
      render(<VisualIntelligencePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('vi-file-id'), { target: { value: 'fil-1' } });
      fireEvent.click(screen.getByTestId('vi-proposal'));
    });
    expect(screen.getByTestId('vi-proposal-result').textContent).toContain('review required: true');
    expect(screen.getByTestId('vi-proposal-code').textContent).toContain('export const placeholder');
  });
});
