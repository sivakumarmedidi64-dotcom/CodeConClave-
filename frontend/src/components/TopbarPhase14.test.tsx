/**
 * CodeConClave — Topbar notification center Phase 14 tests.
 * Type badges + relative timestamps, per-item dismiss (DELETE), click →
 * navigate + mark-read, and browser notifications for NEW items (honest: only
 * when permission is granted; the seed poll never notifies).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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
    createdAt: '2026-08-15T09:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'n2',
    type: 'approval.pending',
    title: 'Approve deploy?',
    body: 'HIGH risk action',
    read: false,
    readAt: null,
    metadata: {},
    resourceType: 'approval',
    resourceId: 'ap1',
    expiresAt: null,
    createdAt: '2026-08-15T10:00:00.000Z',
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

function authed(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: USER } });
    return handler(url, init);
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Topbar notification center (Phase 14)', () => {
  it('renders type badges and relative timestamps for items', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <AuthProvider>
            <Topbar />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    const fetchFn = vi.stubGlobal('fetch', authed(async (url) => {
      if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 2 } });
      if (url.includes('/notifications')) return jsonResponse({ data: { notifications: NOTIFICATIONS } });
      return jsonResponse({ data: {} });
    }));
    expect(fetchFn).toBeDefined();
    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getAllByText('Task completed').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Task completed').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ago$/).length).toBeGreaterThan(0);
  });

  it('dismisses an item via DELETE and removes it from the panel', async () => {
    const fetchFn = vi.fn(
      authed(async (url, init) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 2 } });
        if (url.includes('/notifications') && init?.method === 'DELETE') return jsonResponse({ data: { ok: true } });
        if (url.includes('/notifications')) return jsonResponse({ data: { notifications: NOTIFICATIONS } });
        return jsonResponse({ data: {} });
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    render(
      <MemoryRouter>
        <ToastProvider>
          <AuthProvider>
            <Topbar />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getAllByText('Task completed').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText('Dismiss Task completed'));
    await waitFor(() => expect(screen.queryByText('Task completed')).not.toBeInTheDocument());
    expect(fetchFn.mock.calls.some(([u, i]) => i?.method === 'DELETE' && u.includes('/notifications/n1'))).toBe(true);
    expect(screen.getByText('Approve deploy?')).toBeInTheDocument();
  });

  it('navigates on item click and marks that item read', async () => {
    const fetchFn = vi.fn(
      authed(async (url, init) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 2 } });
        if (url.includes('/notifications') && init?.method === 'POST') return jsonResponse({ data: { ok: true, updated: 1 } });
        if (url.includes('/notifications')) return jsonResponse({ data: { notifications: NOTIFICATIONS } });
        return jsonResponse({ data: {} });
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    render(
      <MemoryRouter initialEntries={['/home']}>
        <ToastProvider>
          <AuthProvider>
            <Topbar />
            <Routes>
              <Route path="/approvals" element={<div>APPROVALS WORKSPACE</div>} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications'));
    await waitFor(() => expect(screen.getByText('Approve deploy?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Approve deploy?'));
    await waitFor(() => expect(screen.getByText('APPROVALS WORKSPACE')).toBeInTheDocument());
    expect(fetchFn.mock.calls.some(([u, i]) => i?.method === 'POST' && u.includes('/notifications/n2/read'))).toBe(true);
  });

  it('fires a browser notification for a NEW unread item after the seed poll', async () => {
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static instances: FakeNotification[] = [];
      title: string;
      constructor(title: string) {
        this.title = title;
        FakeNotification.instances.push(this);
      }
      close = vi.fn();
    }
    (window as unknown as Record<string, unknown>).Notification = FakeNotification;

    vi.useFakeTimers();
    let poll = 0;
    const fetchFn = vi.fn(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 1 } });
        if (url.includes('/notifications')) {
          poll++;
          return jsonResponse({
            data: {
              notifications:
                poll === 1
                  ? []
                  : [
                      {
                        id: 'n-new',
                        type: 'approval.pending',
                        title: 'Fresh approval',
                        body: 'needs review',
                        read: false,
                        readAt: null,
                        metadata: {},
                        resourceType: 'approval',
                        resourceId: 'ap9',
                        expiresAt: null,
                        createdAt: new Date().toISOString(),
                        deletedAt: null,
                      },
                    ],
            },
          });
        }
        return jsonResponse({ data: {} });
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    render(
      <MemoryRouter>
        <ToastProvider>
          <AuthProvider>
            <Topbar />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(poll).toBeGreaterThan(1);
    expect(FakeNotification.instances.length).toBe(1);
    expect(FakeNotification.instances[0]!.title).toBe('Approval pending');
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it('never fires browser notifications when permission is not granted', async () => {
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static instances: FakeNotification[] = [];
      constructor() {
        FakeNotification.instances.push(this);
      }
    }
    (window as unknown as Record<string, unknown>).Notification = FakeNotification;
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      authed(async (url) => {
        if (url.includes('/notifications/unread-count')) return jsonResponse({ data: { count: 1 } });
        if (url.includes('/notifications')) {
          return jsonResponse({
            data: {
              notifications: [
                {
                  id: 'n-x',
                  type: 'task.failed',
                  title: 'X',
                  body: null,
                  read: false,
                  readAt: null,
                  metadata: {},
                  resourceType: 'task',
                  resourceId: 't9',
                  expiresAt: null,
                  createdAt: new Date().toISOString(),
                  deletedAt: null,
                },
              ],
            },
          });
        }
        return jsonResponse({ data: {} });
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    render(
      <MemoryRouter>
        <ToastProvider>
          <AuthProvider>
            <Topbar />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(fetchFn).toBeDefined();
    expect(FakeNotification.instances.length).toBe(0);
    delete (window as unknown as Record<string, unknown>).Notification;
  });
});