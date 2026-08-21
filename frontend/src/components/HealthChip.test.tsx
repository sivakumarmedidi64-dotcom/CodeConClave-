/**
 * CodeConClave — HealthChip tests (PHASE 15).
 * Honest server rollup: HEALTHY -> Operational, DEGRADED -> Degraded,
 * FAILED -> Down, unreachable -> Offline (silent, never throws).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HealthChip } from './HealthChip';

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderChip(fetchImpl: () => Promise<Response>) {
  const fetchFn = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', fetchFn);
  render(<HealthChip />);
  return fetchFn;
}

describe('HealthChip', () => {
  it('shows Operational when the server reports HEALTHY', async () => {
    renderChip(async () =>
      jsonResponse({
        status: 'HEALTHY',
        ok: true,
        name: 'CodeConClave',
        provider: 'memory',
        queue: 'memory',
        time: new Date().toISOString(),
        checks: [],
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('System health: Operational')).toBeInTheDocument());
  });

  it('shows Degraded when the rollup is DEGRADED and lists problem checks in the tooltip', async () => {
    renderChip(async () =>
      jsonResponse({
        status: 'DEGRADED',
        ok: false,
        name: 'CodeConClave',
        provider: 'memory',
        queue: 'memory',
        time: new Date().toISOString(),
        checks: [
          { id: 'ai', name: 'AI providers', status: 'NOT_CONFIGURED', reason: 'No AI provider credentials configured' },
          { id: 'sentry', name: 'Sentry', status: 'NOT_CONFIGURED', reason: 'Error reporting not configured' },
        ],
      }),
    );
    const chip = await screen.findByLabelText('System health: Degraded');
    expect(chip.title).toContain('AI providers');
    expect(chip.title).toContain('Sentry');
  });

  it('shows Down when the rollup is FAILED', async () => {
    renderChip(async () =>
      jsonResponse({
        status: 'FAILED',
        ok: false,
        name: 'CodeConClave',
        provider: 'memory',
        queue: 'memory',
        time: new Date().toISOString(),
        checks: [{ id: 'database', name: 'Database', status: 'FAILED', reason: 'Database unreachable' }],
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('System health: Down')).toBeInTheDocument());
  });

  it('shows Offline when /health is unreachable (silent failure)', async () => {
    renderChip(async () => {
      throw new Error('network down');
    });
    await waitFor(() => expect(screen.getByLabelText('System health: Offline')).toBeInTheDocument());
  });

  it('re-polls on its interval', async () => {
    const fetchFn = renderChip(async () =>
      jsonResponse({ status: 'HEALTHY', ok: true, name: 'CodeConClave', provider: 'memory', queue: 'memory', time: new Date().toISOString(), checks: [] }),
    );
    await waitFor(() => expect(screen.getByLabelText('System health: Operational')).toBeInTheDocument());
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});