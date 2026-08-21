/**
 * CodeConClave — HomePage tests (PHASE 12).
 * Quick actions navigate to real workspaces; the "While you were away" card
 * is served only when the server returned a non-dismissed summary; viewing
 * marks read, dismissing removes it; continuity strip from workspace context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './HomePage';
import { ToastProvider } from '../components/Toast';
import { jsonResponse, stubFetch, TEST_USER } from '../testutils';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: TEST_USER }),
}));

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rtw1',
    generatedAt: new Date(Date.now() - 3600e3).toISOString(),
    absenceStart: new Date(Date.now() - 26 * 3600e3).toISOString(),
    absenceEnd: new Date().toISOString(),
    projectScope: null,
    frequency: 'daily',
    counts: { completed: 2, failed: 1, pendingApprovals: 0, modifiedFiles: 3, discoveries: 0, memoryUpdates: 0, dnaUpdates: 0, projectActivity: 4, unreadNotifications: 0 },
    evidence: {},
    recommendedActions: [
      { type: 'review_approvals', label: 'Review approvals', target: '/approvals' },
      { type: 'inspect_failed', label: 'Inspect failed tasks', target: '/work' },
    ],
    summaryText: 'While you were away: 2 tasks completed, 1 failed.',
    aiGenerated: false,
    read: false,
    dismissed: false,
    ...overrides,
  };
}

function rtwResponse(summary: unknown) {
  return { summary, eligibility: { eligible: summary !== null, reason: summary !== null ? 'generated' : 'nothing_new' } };
}

function renderHome() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <HomePage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('shows quick actions that point at real workspaces', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) return jsonResponse({ data: rtwResponse(null) });
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByText('New Chat')).toBeInTheDocument());
    expect(screen.getByText('Open Terminal')).toBeInTheDocument();
    expect(screen.getByText('Load DNA')).toBeInTheDocument();
    expect(screen.getByText('New Chat').closest('a')).toHaveAttribute('href', '/chat');
  });

  it('renders nothing-new when the server has no summary', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) return jsonResponse({ data: rtwResponse(null) });
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByText(/Nothing new since your last visit/)).toBeInTheDocument());
    expect(screen.queryByTestId('rtw-card')).toBeNull();
  });

  it('renders the return-to-work card with counts and real-action buttons', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) return jsonResponse({ data: rtwResponse(makeSummary()) });
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('rtw-card')).toBeInTheDocument());
    expect(screen.getByText(/2 tasks completed/)).toBeInTheDocument();
    expect(screen.getByText(/1 task failed/)).toBeInTheDocument();
    expect(screen.getByText('Review approvals')).toBeInTheDocument();
    expect(screen.getByText('Inspect failed tasks')).toBeInTheDocument();
    expect(screen.queryByText('All quiet.')).toBeNull();
  });

  it('expands the summary text and marks it read', async () => {
    const calls: { method?: string; url: string }[] = [];
    stubFetch(async (url, init) => {
      calls.push({ method: init?.method, url });
      if (url.includes('/api/v1/workspace/return-to-work')) {
        if (init?.method === 'POST' && url.includes('/read')) return jsonResponse({ data: {} });
        return jsonResponse({ data: rtwResponse(makeSummary()) });
      }
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('rtw-card')).toBeInTheDocument());
    await userEvent.click(screen.getByText('View summary'));
    expect(screen.getByText(/While you were away: 2 tasks completed, 1 failed/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/rtw1/read'))).toBe(true);
  });

  it('dismissing removes the card and notifies the server', async () => {
    const calls: { method?: string; url: string }[] = [];
    stubFetch(async (url, init) => {
      calls.push({ method: init?.method, url });
      if (url.includes('/api/v1/workspace/return-to-work')) {
        if (init?.method === 'POST' && url.includes('/dismiss')) return jsonResponse({ data: {} });
        return jsonResponse({ data: rtwResponse(makeSummary()) });
      }
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('rtw-card')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByTestId('rtw-card')).toBeNull();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/rtw1/dismiss'))).toBe(true);
  });

  it('renders the continuity strip from workspace context', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) return jsonResponse({ data: rtwResponse(null) });
      if (url.includes('/api/v1/workspace/context')) {
        return jsonResponse({
          data: { memoryLoaded: true, memoryCount: 3, memorySourceRefs: 0, dnaCount: 2, dnaVersion: 5, project: { projectId: 'p1', projectName: 'Acme' }, relevantFiles: 4 },
        });
      }
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('continuity-strip')).toBeInTheDocument());
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText(/4 relevant files/)).toBeInTheDocument();
    expect(screen.getByText(/DNA v5/)).toBeInTheDocument();
  });

  it('shows an error state with retry for the summary', async () => {
    let calls = 0;
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        return jsonResponse({ data: rtwResponse(makeSummary()) });
      }
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByText('Could not load your summary.')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('rtw-card')).toBeInTheDocument());
  });

  it('renders the recent activity feed and a link to full history', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) return jsonResponse({ data: rtwResponse(null) });
      if (url.includes('/api/v1/activity')) {
        return jsonResponse({
          data: {
            events: [
              { id: 'pa:p1', source: 'project_activity', action: 'project.created', actorUserId: 'u1', projectId: 'prj_1', teamId: null, resourceType: 'project', resourceId: 'prj_1', summary: 'project.created', createdAt: '2026-01-01T00:00:00.000Z' },
            ],
          },
        });
      }
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('activity-feed')).toBeInTheDocument());
    expect(screen.getByText('project.created')).toBeInTheDocument();
    expect(screen.getByText('View full history →').closest('a')).toHaveAttribute('href', '/history');
  });

  it('shows the Ideas quick action pointing at the Ideas workspace', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/workspace/return-to-work')) return jsonResponse({ data: rtwResponse(null) });
      return jsonResponse({ data: {} });
    });
    renderHome();
    await waitFor(() => expect(screen.getByText('Ideas')).toBeInTheDocument());
    expect(screen.getByText('Ideas').closest('a')).toHaveAttribute('href', '/ideas');
  });
});