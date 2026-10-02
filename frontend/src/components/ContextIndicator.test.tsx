/**
 * CodeConClave — ContextIndicator tests (PHASE 11).
 * Pill reflects the server context; inspector shows detail rows; error state
 * offers retry; never fabricates data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextIndicator } from './ContextIndicator';
import { jsonResponse, stubFetch } from '../testutils';

function contextFixture(overrides: Record<string, unknown> = {}) {
  return {
    memoryLoaded: true,
    memoryCount: 12,
    memorySourceRefs: 5,
    dnaCount: 3,
    dnaVersion: 2,
    project: { projectId: 'p1', projectName: 'Acme' },
    relevantFiles: 4,
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('ContextIndicator', () => {
  it('renders the pill from the server context endpoint', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/context')) return jsonResponse({ data: contextFixture() });
      return jsonResponse({ data: {} });
    });
    render(<ContextIndicator />);
    await waitFor(() => expect(screen.getByText(/Mem 12/)).toBeInTheDocument());
    expect(screen.getByText(/DNA v2/)).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('opens an inspector with the detail rows', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/context')) return jsonResponse({ data: contextFixture() });
      return jsonResponse({ data: {} });
    });
    render(<ContextIndicator />);
    await userEvent.click(await screen.findByLabelText('Context indicator'));
    await waitFor(() => expect(screen.getByLabelText('Context details')).toBeInTheDocument());
    expect(screen.getByText('Memory source refs')).toBeInTheDocument();
    expect(screen.getByText('Relevant files')).toBeInTheDocument();
  });

  it('shows an honest unavailable state and retries on click', async () => {
    let calls = 0;
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/context')) {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        return jsonResponse({ data: contextFixture() });
      }
      return jsonResponse({ data: {} });
    });
    render(<ContextIndicator />);
    await waitFor(() => expect(screen.getByText('Context unavailable')).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText('Context indicator'));
    await waitFor(() => expect(screen.getByText(/Mem 12/)).toBeInTheDocument());
  });
});