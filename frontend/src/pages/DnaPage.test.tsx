/**
 * CodeConClave — DnaPage tests (PHASE 11).
 * Versions load per block; compare shows the diff; restore-version and branch
 * post real actions; loading/error states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { DnaPage } from './DnaPage';
import { jsonResponse, stubFetch } from '../testutils';

const BLOCK = {
  id: 'd1',
  projectId: 'p1',
  kind: 'DECISION',
  title: 'Prefer small diffs',
  content: 'Small diffs only.',
  scope: 'MAIN',
  auto: false,
  branchOf: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  version: 3,
};

function dnaHandler(extra?: (url: string, init?: RequestInit) => Promise<Response | null>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (extra) {
      const r = await extra(url, init);
      if (r) return r;
    }
    if (url === '/api/v1/projects') return jsonResponse({ data: { projects: [{ id: 'p1', name: 'Acme' }] } });
    if (url.includes('/api/v1/dna') && !url.includes('/versions') && !url.includes('/compare') && !url.includes('/branch') && !url.includes('/restore-version') && !url.includes('/export')) {
      return jsonResponse({ data: { blocks: [BLOCK] } });
    }
    if (url.includes('/api/v1/dna/d1/versions')) {
      return jsonResponse({
        data: {
          versions: [
            { version: 1, created: '2026-01-01T00:00:00.000Z', title: 'Prefer small diffs', content: 'v1' },
            { version: 3, created: '2026-01-02T00:00:00.000Z', title: 'Prefer small diffs', content: 'v3' },
          ],
        },
      });
    }
    if (url.includes('/api/v1/dna/d1/compare')) {
      return jsonResponse({
        data: {
          from: { version: 1, created: '2026-01-01T00:00:00.000Z', title: 'x', content: 'v1' },
          to: { version: 3, created: '2026-01-02T00:00:00.000Z', title: 'x', content: 'v3' },
          added: [{ title: 'New rule', content: 'y' }],
          removed: [],
          changed: [],
        },
      });
    }
    return jsonResponse({ data: {} });
  };
}

function renderDna() {
  return render(
    <ToastProvider>
      <DnaPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('DnaPage', () => {
  it('loads blocks for the selected project', async () => {
    stubFetch(dnaHandler());
    renderDna();
    await waitFor(() => expect(screen.getByText('Prefer small diffs')).toBeInTheDocument());
    expect(screen.getByText(/v3/)).toBeInTheDocument();
  });

  it('shows the DNA loading animation while blocks load', async () => {
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((res) => {
      release = res;
    });
    stubFetch(async (url) => {
      if (url === '/api/v1/projects') return jsonResponse({ data: { projects: [{ id: 'p1', name: 'Acme' }] } });
      if (url.includes('/api/v1/dna') && url.includes('projectId')) return pending;
      return jsonResponse({ data: {} });
    });
    renderDna();
    await waitFor(() => expect(screen.getByTestId('dna-loader')).toBeInTheDocument());
    release(jsonResponse({ data: { blocks: [BLOCK] } }));
    await waitFor(() => expect(screen.getByText('Prefer small diffs')).toBeInTheDocument());
  });

  it('loads versions and compares them', async () => {
    stubFetch(dnaHandler());
    renderDna();
    await userEvent.click(await screen.findByText('Versions'));
    await waitFor(() => expect(screen.getAllByText('Compare → v3').length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByText('Compare → v3')[0]!);
    await waitFor(() => expect(screen.getByText(/added: New rule/)).toBeInTheDocument());
  });

  it('restores a previous version via the real endpoint', async () => {
    const fetchFn = stubFetch(dnaHandler());
    renderDna();
    await userEvent.click(await screen.findByText('Versions'));
    const restores = await screen.findAllByText('Restore');
    await userEvent.click(restores[0]!);
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/dna/d1/restore-version' && i?.method === 'POST');
      expect(call).toBeDefined();
    });
    const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/dna/d1/restore-version');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ version: 1 });
  });

  it('branches a block via the real endpoint', async () => {
    const fetchFn = stubFetch(dnaHandler());
    renderDna();
    await userEvent.click(await screen.findByText('Branch'));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/dna/d1/branch' && i?.method === 'POST');
      expect(call).toBeDefined();
    });
    expect(screen.getByText('Branch created')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    let calls = 0;
    stubFetch(
      dnaHandler(async (url) => {
        if (url.includes('/api/v1/dna') && url.includes('projectId')) {
          calls += 1;
          if (calls === 1) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        }
        return null;
      }),
    );
    renderDna();
    await waitFor(() => expect(screen.getByText('Could not load DNA blocks.')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('Prefer small diffs')).toBeInTheDocument());
  });
});