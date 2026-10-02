/**
 * CodeConClave — HistoryPage tests (PHASE 13).
 * Unified timeline rendering, source/star filters, star toggling, detail view,
 * error with retry and empty states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { HistoryPage } from './HistoryPage';
import { jsonResponse, stubFetch } from '../testutils';

const EVENT = {
  id: 'project_activity:pact_1',
  eventId: 'pact_1',
  source: 'project_activity',
  action: 'project.created',
  actorUserId: 'u1',
  projectId: 'prj_1',
  teamId: null,
  resourceType: 'project',
  resourceId: 'prj_1',
  detail: { name: 'Acme' },
  createdAt: '2026-01-01T00:00:00.000Z',
  starred: false,
};

function renderHistory() {
  return render(
    <ToastProvider>
      <HistoryPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('HistoryPage', () => {
  it('renders the unified timeline with source badges', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/history')) return jsonResponse({ data: { events: [EVENT], total: 1 } });
      return jsonResponse({ data: {} });
    });
    renderHistory();
    await waitFor(() => expect(screen.getByText('project.created')).toBeInTheDocument());
    expect(screen.getByText('project_activity')).toBeInTheDocument();
    expect(screen.getByText('1 event(s)')).toBeInTheDocument();
  });

  it('toggles a star and calls the server', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/history/project_activity/pact_1/star') && init?.method === 'POST') {
        return jsonResponse({ data: { starred: true } });
      }
      if (url.includes('/api/v1/history')) return jsonResponse({ data: { events: [EVENT], total: 1 } });
      return jsonResponse({ data: {} });
    });
    renderHistory();
    await userEvent.click(await screen.findByText('☆'));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u.includes('/star') && i?.method === 'POST')).toBe(true));
    expect(screen.getByText('★')).toBeInTheDocument();
  });

  it('filters by source via the dropdown and requests starred only', async () => {
    const fetchFn = stubFetch(async (url) => {
      if (url.includes('/api/v1/history')) return jsonResponse({ data: { events: [], total: 0 } });
      return jsonResponse({ data: {} });
    });
    renderHistory();
    await userEvent.selectOptions(screen.getByText('All sources').closest('select')!, 'audit');
    await userEvent.click(screen.getByText('starred'));
    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([u]) => u.includes('source=audit') && u.includes('starred=true'))).toBe(true);
    });
  });

  it('opens the detail view from a row and closes it', async () => {
    const noDetail = { ...EVENT, detail: null };
    stubFetch(async (url) => {
      if (url.includes('/api/v1/history/project_activity/pact_1')) {
        return jsonResponse({ data: { event: noDetail } });
      }
      if (url.includes('/api/v1/history')) return jsonResponse({ data: { events: [noDetail], total: 1 } });
      return jsonResponse({ data: {} });
    });
    renderHistory();
    await waitFor(() => expect(screen.getByText('project.created')).toBeInTheDocument());
    await userEvent.click(screen.getByText('View'));
    expect(screen.getByTestId('history-detail')).toBeInTheDocument();
    expect(screen.getAllByText(/prj_1/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('history-detail')).toBeNull();
  });

  it('shows the empty state when nothing matches', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/history')) return jsonResponse({ data: { events: [], total: 0 } });
      return jsonResponse({ data: {} });
    });
    renderHistory();
    await waitFor(() => expect(screen.getByText('No events match your filters.')).toBeInTheDocument());
  });

  it('shows an error state and retries', async () => {
    let calls = 0;
    stubFetch(async (url) => {
      if (url.includes('/api/v1/history')) {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        return jsonResponse({ data: { events: [EVENT], total: 1 } });
      }
      return jsonResponse({ data: {} });
    });
    renderHistory();
    await waitFor(() => expect(screen.getByText('Could not load history.')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('project.created')).toBeInTheDocument());
  });
});