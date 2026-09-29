/**
 * CodeConClave — Topbar notification bell tests (PHASE 4A).
 * Unread count badge, panel load, mark-all-read on open, empty and error
 * states. fetch is mocked end-to-end against the real api client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { Topbar } from './Topbar';
import type { Notification, User } from '../lib/types';

const USER: User = {
  id: 'u1',
  email: 'alice@example.com',
  emailVerified: true,
  displayName: 'Alice',
  avatarUrl: null,
  mfaEnabled: false,
  rbacRole: 'member',
  planId: 'free',
  entitlementState: 'FREE',
};

const NOTIFICATIONS: Notification[] = [
  {
    id: 'n1',
    type: 'task.completed',
    title: 'Task completed',
    body: 'Build finished',
    read: false,
    readAt: null,
    metadata: {},
    resourceType: 'task',
    resourceId: 't1',
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  },
];

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

function renderTopbar(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = setupFetch(handler);
  const result = render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <Topbar />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

function authed(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: USER } });
    return handler(url, init);
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Topbar notifications bell', () => {
  it('loads the server unread count into the badge', async () => {
    renderTopbar(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 3 } });
        return jsonResponse({ data: {} });
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  });

  it('opens the panel, loads notifications and marks all read', async () => {
    const fetchFn = renderTopbar(
      authed(async (url, init) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 2 } });
        if (url.includes('/notifications') && init?.method === 'POST') return jsonResponse({ data: { ok: true, updated: 2 } });
        if (url.includes('/notifications')) return jsonResponse({ data: { notifications: NOTIFICATIONS } });
        return jsonResponse({ data: {} });
      }),
    ).fetchFn;

    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getAllByText('Task completed').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('Build finished')).toBeInTheDocument());
    const markAll = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST' && String((init?.body ?? '')).includes(''));
    expect(markAll).toBeDefined();
    await waitFor(() => expect(screen.queryByText('2')).not.toBeInTheDocument());
  });

  it('shows the empty state when there are no notifications', async () => {
    renderTopbar(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 0 } });
        if (url.includes('/notifications')) return jsonResponse({ data: { notifications: [] } });
        return jsonResponse({ data: {} });
      }),
    );
    await userEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getByText('No notifications')).toBeInTheDocument());
  });

  it('shows an error state when the list load fails', async () => {
    renderTopbar(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 1 } });
        if (url.includes('/notifications')) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        return jsonResponse({ data: {} });
      }),
    );
    await userEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getByText('Could not load notifications.')).toBeInTheDocument());
  });

  it('closes the notifications panel on Escape', async () => {
    renderTopbar(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 0 } });
        if (url.includes('/notifications')) return jsonResponse({ data: { notifications: NOTIFICATIONS } });
        return jsonResponse({ data: {} });
      }),
    );
    await userEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument());
  });

  it('cancels a pending debounced search on unmount (no stray request)', async () => {
    vi.useFakeTimers();
    try {
      const { fetchFn, unmount } = renderTopbar(
        authed(async (url) => {
          if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 0 } });
          return jsonResponse({ data: {} });
        }),
      );
      fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'dark' } });
      unmount();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/v1/search'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes an idea search result to the Ideas workspace', async () => {
    const fetchFn = setupFetch(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 0 } });
        if (url.includes('/api/v1/search')) {
          return jsonResponse({
            data: {
              results: [{ entity: 'idea', id: 'ide_1', label: 'Dark mode everywhere', summary: 'PROPOSED', projectId: null, createdAt: null, meta: {} }],
              total: 1,
            },
          });
        }
        return jsonResponse({ data: {} });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/home']}>
        <ToastProvider>
          <AuthProvider>
            <Topbar />
            <Routes>
              <Route path="/ideas" element={<div>IDEAS WORKSPACE</div>} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('Global search')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Global search'), 'dark');
    await waitFor(() => expect(screen.getByText('Dark mode everywhere')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Dark mode everywhere'));
    await waitFor(() => expect(screen.getByText('IDEAS WORKSPACE')).toBeInTheDocument());
    expect(fetchFn.mock.calls.some(([u]) => u.includes('/api/v1/search'))).toBe(true);
  });
});