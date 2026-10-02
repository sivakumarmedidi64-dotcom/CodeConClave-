/**
 * CodeConClave — UsageCard tests (PHASE 4A).
 * Loading, ready (measured vs estimated display), error and no-estimate
 * states. Numbers always come from the mocked server response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UsageCard } from './UsageCard';
import type { UsageOverview } from '../lib/types';

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

function setupFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(handler);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function overview(overrides: Partial<UsageOverview> = {}): UsageOverview {
  return {
    plan: 'free',
    measured: { messagesToday: 4, storageBytes: 2 * 1024 * 1024, aiInputTokens: 1200, aiOutputTokens: 300, tasksToday: 1 },
    estimated: { computeCostUsd: 0.01, sources: 1 },
    limits: { dailyMessages: 20, maxProjects: 1, storageGb: 2 },
    resetDate: '2026-01-01T00:00:00.000Z',
    rolling: { used: 4, limit: 20, windowHours: 24, windowStart: '2026-01-01T00:00:00.000Z', resetsAt: '2026-01-02T00:00:00.000Z', remaining: 16 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('UsageCard', () => {
  it('shows a loading state before the server responds', () => {
    setupFetch(() => new Promise(() => undefined));
    render(<UsageCard />);
    expect(screen.getByText('Loading usage…')).toBeInTheDocument();
  });

  it('displays measured usage, plan and reset date from the server', async () => {
    setupFetch(async (url) => {
      if (url.includes('/workspace/usage/overview')) return jsonResponse({ data: { overview: overview() } });
      return jsonResponse({ data: {} });
    });
    render(<UsageCard />);
    await waitFor(() => expect(screen.getByText('Messages this window')).toBeInTheDocument());
    expect(screen.getByText('4 / 20 used · 16 left')).toBeInTheDocument();
    expect(screen.getByText(/1,500 \(in 1,200 \/ out 300\)/)).toBeInTheDocument();
    expect(screen.getByText(/2.0 MB \/ 2 GB/)).toBeInTheDocument();
    expect(screen.getByText('FREE')).toBeInTheDocument();
    expect(screen.getByText('$0.0100 (estimated)')).toBeInTheDocument();
  });

  it('omits the compute estimate row when there are no estimated sources', async () => {
    setupFetch(async (url) => {
      if (url.includes('/workspace/usage/overview')) {
        return jsonResponse({ data: { overview: overview({ estimated: { computeCostUsd: 0, sources: 0 } }) } });
      }
      return jsonResponse({ data: {} });
    });
    render(<UsageCard />);
    await waitFor(() => expect(screen.getByText('Messages this window')).toBeInTheDocument());
    expect(screen.queryByText(/estimated/)).not.toBeInTheDocument();
  });

  it('shows an error state when the server fails', async () => {
    setupFetch(async (url) => {
      if (url.includes('/workspace/usage/overview')) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
      return jsonResponse({ data: {} });
    });
    render(<UsageCard />);
    await waitFor(() => expect(screen.getByText('Could not load usage.')).toBeInTheDocument());
  });
});