/**
 * CodeConClave — AutonomousTasksPanel tests (PKG-25).
 * Honest 24/7 truth-report rendering: golden/orange status badges, real-infra
 * ENVIRONMENT_BLOCKED integrity, and the guarantee that nothing is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AutonomousTasksPanel } from './AutonomousTasksPanel';

const truthLine = (key: string, label: string, status: string, evidence: string) => ({ key, label, status, evidence });

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

const statusPayload = (realAvailable = false) => ({
  status: {
    enabled: false,
    dbReachable: false,
    logic: { ok: true, phases: ['task-persistence', 'restart-recovery', 'failure-recovery', 'recurring-exactly-once'] },
    realInfra: { available: realAvailable, ok: false, phases: [] },
    truth: [
      truthLine('AUTONOMY_LOGIC', 'Autonomous cowork logic proof', 'VERIFIED', 'logic harness 13 phases pass'),
      truthLine('TASK_PERSISTENCE', 'Task survives worker leave', 'VERIFIED', 'persisted attempt/checkpoint'),
      truthLine('REAL_24_7', 'Real 24/7 infrastructure', realAvailable ? 'VERIFIED' : 'ENVIRONMENT_BLOCKED', realAvailable ? 'live DB' : 'no long-lived DB in this environment'),
    ],
    summary: 'Logic proof verified; real 24/7 requires a live database.',
  },
});

describe('AutonomousTasksPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the honest truth report with VERIFIED + ENVIRONMENT_BLOCKED split', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(statusPayload(false)));
    await act(async () => render(<AutonomousTasksPanel />));
    expect(screen.getByTestId('autonomy-logic-phases').textContent).toContain('restart-recovery');
    expect(screen.getByTestId('autonomy-truth-status-AUTONOMY_LOGIC').textContent).toContain('VERIFIED');
    expect(screen.getByTestId('autonomy-truth-status-REAL_24_7').textContent).toContain('ENVIRONMENT_BLOCKED');
    expect(screen.getByTestId('autonomy-honest').textContent).toContain('ENVIRONMENT_BLOCKED');
  });

  it('shows real-infra as not-executed when the status reports no live DB', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(statusPayload(false)));
    await act(async () => render(<AutonomousTasksPanel />));
    expect(screen.getByTestId('autonomy-realinfra').textContent).toContain('ENVIRONMENT_BLOCKED');
  });

  it('renders the disabled gate state honestly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(statusPayload(false)));
    await act(async () => render(<AutonomousTasksPanel />));
    expect(screen.getByTestId('autonomy-gate').textContent).toContain('OFF (AIOS_P2_AUTONOMY)');
  });

  it('shows an error state when status fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    await act(async () => render(<AutonomousTasksPanel />));
    expect(screen.getByTestId('autonomy-error').textContent).toContain('network down');
  });
});
