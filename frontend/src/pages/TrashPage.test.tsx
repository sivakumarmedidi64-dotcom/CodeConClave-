/**
 * CodeConClave — TrashPage tests (PHASE 13).
 * Unified list with per-type tabs, single/bulk restore, permanent delete with
 * confirmation, and the expiry sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { TrashPage } from './TrashPage';
import { jsonResponse, stubFetch } from '../testutils';

const ITEMS = [
  {
    type: 'file',
    id: 'fil_1',
    name: 'old.txt',
    deletedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    deletedBy: 'u1',
    projectId: 'prj_1',
    projectName: 'App',
    teamId: null,
    teamName: null,
    sizeBytes: 2048,
  },
  {
    type: 'idea',
    id: 'ide_1',
    name: 'Dark mode',
    deletedAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2026-02-02T00:00:00.000Z',
    deletedBy: null,
    projectId: null,
    projectName: null,
    teamId: null,
    teamName: null,
    sizeBytes: null,
  },
];

function renderTrash() {
  return render(
    <ToastProvider>
      <TrashPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('TrashPage', () => {
  it('lists unified trash with type badges and expiry', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: ITEMS, total: 2 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    await waitFor(() => expect(screen.getByText('old.txt')).toBeInTheDocument());
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(screen.getByText('file')).toBeInTheDocument();
    expect(screen.getByText('idea')).toBeInTheDocument();
    expect(screen.getByText(/App/)).toBeInTheDocument();
    expect(screen.getAllByText(/expires/).length).toBe(2);
  });

  it('filters by tab', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: ITEMS, total: 2 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    await userEvent.click(await screen.findByText('Ideas (1)'));
    expect(screen.queryByText('old.txt')).toBeNull();
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
  });

  it('restores a single item through the unified endpoint', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/trash/restore/file/fil_1' && init?.method === 'POST') {
        return jsonResponse({ data: { restored: true } });
      }
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: ITEMS, total: 2 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    const buttons = await screen.findAllByText('Restore');
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/trash/restore/file/fil_1' && i?.method === 'POST')).toBe(true));
  });

  it('restores everything with a bulk call', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/trash/restore' && init?.method === 'POST') {
        return jsonResponse({ data: { restored: [{ type: 'file', id: 'fil_1', ok: true }, { type: 'idea', id: 'ide_1', ok: true }] } });
      }
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: ITEMS, total: 2 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    await userEvent.click(await screen.findByText('Restore all'));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/trash/restore' && i?.method === 'POST');
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]?.body));
      expect(body.items).toHaveLength(2);
    });
  });

  it('confirms before a permanent delete and reports blocked items', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/trash/purge/file/fil_1' && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'dependency_conflict', message: 'Still referenced by tasks' } }, 409);
      }
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: ITEMS, total: 2 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    const buttons = await screen.findAllByText('Delete permanently');
    await userEvent.click(buttons[0]!);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/trash/purge/file/fil_1' && i?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.getByText(/Still referenced by tasks/)).toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it('runs the expiry sweep with confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/trash/purge-expired' && init?.method === 'POST') {
        return jsonResponse({ data: { purged: [{ type: 'file', id: 'fil_1' }], skipped: [] } });
      }
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: ITEMS, total: 2 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    await userEvent.click(await screen.findByText('Purge expired'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/trash/purge-expired' && i?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.getByText(/1 purged, 0 skipped/)).toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it('shows the empty state', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/trash')) return jsonResponse({ data: { items: [], total: 0 } });
      return jsonResponse({ data: {} });
    });
    renderTrash();
    await waitFor(() => expect(screen.getByText('Trash empty.')).toBeInTheDocument());
  });
});