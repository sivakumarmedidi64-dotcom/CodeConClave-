/**
 * CodeConClave — SecurityOperationsPanel tests (PKG-15).
 * Honest capability rendering, per-capability assessment wiring, result
 * display, and error states. Never fabricates proven results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SecurityOperationsPanel } from './SecurityOperationsPanel';

const cap = (description: string) => ({
  status: 'AVAILABLE',
  state: 'HEURISTIC',
  deterministic: true,
  needsProvider: false,
  description,
});

const caps = {
  capabilities: {
    SECURITY_INCIDENT: cap('Incident lifecycle with audit trail.'),
    RATE_LIMIT_AWARENESS: cap('Rate-limit coverage aggregation.'),
    NETWORK_RESILIENCE: cap('Static network-resilience facets.'),
    COMPLIANCE: cap('Cross-cutting compliance score.'),
  },
  limitations: ['Deterministic heuristics only; advisory, not proof.'],
};

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe('SecurityOperationsPanel', () => {
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
      render(<SecurityOperationsPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('secops-cap-security_incident').textContent).toContain('Security Incident Response');
    expect(screen.getByTestId('secops-cap-compliance').textContent).toContain('AVAILABLE');
    expect(screen.getByTestId('secops-honest').textContent).toContain('advisory');
  });

  it('runs a rate-limit awareness assessment and displays coverage', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'sra-1',
          projectId: 'prj-1',
          generatedAt: new Date().toISOString(),
          totalEndpoints: 2,
          rateLimitedEndpoints: 1,
          uncoveredEndpoints: 1,
          coveragePercent: 50,
          failClosedEndpoints: 1,
          failOpenEndpoints: 0,
          overall: 'PARTIAL',
          endpoints: [
            { method: 'GET', path: '/v1/orders', rateLimited: true, strategy: 'fixed_window', failClosed: true, state: 'VERIFIED' },
          ],
        }),
      );
    await act(async () => {
      render(<SecurityOperationsPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('secops-run-rate_limit_awareness'));
    });
    const calls = fetchMock.mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual([
      '/api/v1/security-operations/rate-limit-awareness',
      'POST',
      JSON.stringify({ projectId: 'prj-1' }),
    ]);
    expect(screen.getByTestId('secops-rate-limit').textContent).toContain('50%');
    expect(screen.getByTestId('secops-endpoint').textContent).toContain('verified');
  });

  it('lists incidents when the incident rail is run', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'soi-1',
            title: 'Open secret',
            severity: 'HIGH',
            status: 'TRIAGING',
            responseAction: 'REMEDIATE',
            source: 'security scan',
            summary: null,
            createdAt: new Date().toISOString(),
          },
        ]),
      );
    await act(async () => {
      render(<SecurityOperationsPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('secops-run-security_incident'));
    });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('/api/v1/security-operations/incidents?projectId=prj-1');
    expect(screen.getByTestId('secops-incident').textContent).toContain('Open secret');
  });

  it('shows an error state on failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(caps)).mockRejectedValueOnce(new Error('secops_unknown_kind'));
    await act(async () => {
      render(<SecurityOperationsPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('secops-run-compliance'));
    });
    expect(screen.getByTestId('secops-error').textContent).toContain('secops_unknown_kind');
  });
});