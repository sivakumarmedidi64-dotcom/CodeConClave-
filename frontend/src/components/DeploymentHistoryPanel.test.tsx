/**
 * CodeConClave — DeploymentHistoryPanel tests (PKG-21).
 * Renders server-authoritative deployment history (version/commit/environment/
 * provider/status/health/smoke/verification), current deployment, rollback
 * availability, production rollback explicit confirmation (no silent rollback),
 * and the controlled rollback POST. Never shows fabricated rollback success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DeploymentHistoryPanel, type DeploymentSummary } from './DeploymentHistoryPanel';

function row(over: Partial<DeploymentSummary> & { deploymentId: string; version: string }): DeploymentSummary {
  return {
    projectId: 'prj-1',
    environment: 'development',
    provider: 'railway',
    service: 'backend',
    commit: 'abc123def456',
    status: 'VERIFIED',
    verification: 'VERIFIED',
    health: 'PASS',
    smoke: 'PASS',
    rollbackAvailable: true,
    createdAt: '2024-01-01T00:00:00Z',
    ...over,
  };
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

function apiError(code: string, message: string): Response {
  return {
    ok: false,
    status: 400,
    json: async () => ({ error: { code, message } }),
  } as unknown as Response;
}

describe('DeploymentHistoryPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders history rows with version, commit, environment, provider, status, health, smoke, verification', async () => {
    const history = [
      row({ deploymentId: 'dp-2', version: '1.1.0', commit: 'def456789012', environment: 'development' }),
      row({ deploymentId: 'dp-1', version: '1.0.0', commit: 'abc123def456', environment: 'staging' }),
    ];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(history))
      .mockResolvedValueOnce(jsonResponse(history[0]));
    await act(async () => {
      render(<DeploymentHistoryPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('deployment-row-dp-2').textContent).toContain('v1.1.0');
    expect(screen.getByTestId('deployment-row-dp-2').textContent).toContain('def45678');
    expect(screen.getByTestId('deployment-row-dp-2').textContent).toContain('railway');
    expect(screen.getByTestId('deployment-row-dp-2').textContent).toContain('Development');
    expect(screen.getByTestId('deployment-row-dp-2').textContent).toContain('VERIFIED');
    expect(screen.getByTestId('deployment-health-dp-2').textContent).toContain('PASS');
    expect(screen.getByTestId('deployment-smoke-dp-2').textContent).toContain('PASS');
    // current marker
    expect(screen.getByTestId('deployment-row-dp-2').textContent).toContain('◀ current');
  });

  it('renders the current deployment line', async () => {
    const current = row({ deploymentId: 'dp-1', version: '2.0.0', environment: 'production', commit: 'beef1234abcd' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(current));
    await act(async () => {
      render(<DeploymentHistoryPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('deployment-current-row').textContent).toContain('production');
    expect(screen.getByTestId('deployment-current-row').textContent).toContain('v2.0.0');
    expect(screen.getByTestId('deployment-current-row').textContent).toContain('beef1234');
  });

  it('POSTs a controlled rollback for a non-production release without confirmation', async () => {
    const target = row({ deploymentId: 'dp-1', version: '1.0.0', environment: 'development' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([target, row({ deploymentId: 'dp-2', version: '1.1.0' })]))
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'rbr-1',
          projectId: 'prj-1',
          environment: 'development',
          currentDeploymentId: 'dp-2',
          targetDeploymentId: 'dp-1',
          status: 'SUCCEEDED',
          result: 'ROLLED_BACK',
          providerCapability: 'CONFIGURED',
          databaseCompat: 'COMPATIBLE',
          safetyChecks: [{ name: 'authorized', ok: true, detail: 'authorized' }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse([target]))
      .mockResolvedValueOnce(jsonResponse(target));
    await act(async () => {
      render(<DeploymentHistoryPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-rollback-dp-1'));
    });
    const calls = vi.mocked(fetch).mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual([
      '/api/v1/release/prj-1/rollback',
      'POST',
      JSON.stringify({ targetDeploymentId: 'dp-1', environment: 'development', confirmed: false }),
    ]);
    expect(screen.getByTestId('deployment-rollback-result').textContent).toContain('ROLLED_BACK');
  });

  it('production rollback requires explicit confirmation and shows failure without it', async () => {
    const target = row({ deploymentId: 'dp-9', version: '1.0.0', environment: 'production' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([target, row({ deploymentId: 'dp-8', version: '1.1.0', environment: 'production' })]))
      .mockResolvedValueOnce(jsonResponse(target));
    await act(async () => {
      render(<DeploymentHistoryPanel projectId="prj-1" />);
    });
    // Rollback button disabled until confirmation checkbox is checked (no silent production rollback).
    expect((screen.getByTestId('deployment-rollback-dp-9') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-confirm-dp-9'));
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'rbr-9',
          projectId: 'prj-1',
          environment: 'production',
          currentDeploymentId: 'dp-8',
          targetDeploymentId: 'dp-9',
          status: 'BLOCKED',
          result: 'BLOCKED',
          providerCapability: 'ENVIRONMENT_BLOCKED',
          databaseCompat: 'UNKNOWN',
          reason: 'provider environment blocked',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([target]))
      .mockResolvedValueOnce(jsonResponse(target));
    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-rollback-dp-9'));
    });
    const calls = vi.mocked(fetch).mock.calls.map((c) => [
      String(c[0]),
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toContainEqual([
      '/api/v1/release/prj-1/rollback',
      'POST',
      JSON.stringify({ targetDeploymentId: 'dp-9', environment: 'production', confirmed: true }),
    ]);
    expect(screen.getByTestId('deployment-rollback-result').textContent).toContain('BLOCKED');
  });

  it('renders an honest message when rollback is not executed', async () => {
    const target = row({ deploymentId: 'dp-5', version: '1.0.0', environment: 'development' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([target]))
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'rbr-5',
          projectId: 'prj-1',
          environment: 'development',
          currentDeploymentId: 'dp-4',
          targetDeploymentId: 'dp-5',
          status: 'BLOCKED',
          result: 'BLOCKED',
          providerCapability: 'ENVIRONMENT_BLOCKED',
          databaseCompat: 'UNKNOWN',
          reason: 'no live provider target',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([target]))
      .mockResolvedValueOnce(jsonResponse(target));
    await act(async () => {
      render(<DeploymentHistoryPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-rollback-dp-5'));
    });
    expect(screen.getByTestId('deployment-message').textContent).toContain('was not executed');
    expect(screen.getByTestId('deployment-rollback-result').textContent).toContain('ENVIRONMENT_BLOCKED');
  });

  it('shows an error state when history fails to load', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      render(<DeploymentHistoryPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('deployment-history-error').textContent).toContain('Could not load');
  });
});
