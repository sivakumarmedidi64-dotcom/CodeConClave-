/**
 * CodeConClave — Admin UI / ErrorBoundary styling verification (UI_EX_01).
 * Confirms the healed surfaces render with the project .cc-* styling classes
 * (no Tailwind utility classes) while keeping exactly the same content and
 * behavior. All data is stubbed at the fetch boundary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AdminDashboard } from './admin/AdminDashboard';
import { AdminUsers } from './admin/AdminUsers';
import { AdminAIUsage } from './admin/AdminAIUsage';
import type { User } from '../lib/types';

const ADMIN: User = {
  id: 'u-admin',
  email: 'root@example.com',
  emailVerified: true,
  displayName: 'Root',
  avatarUrl: null,
  mfaEnabled: true,
  rbacRole: 'admin',
  planId: 'pro',
  entitlementState: 'PRO_VERIFIED',
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob(['x'], { type: 'text/plain' }),
  } as unknown as Response;
}

function adminFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/auth/me')) {
      return jsonResponse({ data: { user: ADMIN } });
    }
    return handler(url, init);
  };
}

const STATS = {
  totalUsers: 3,
  totalProjects: 5,
  totalMessagesToday: 12,
  activeUsersToday: 2,
  revenueToday: 4.5,
  aiUsageBreakdown: [{ provider: 'openai', requests: 10, estimatedCostUsd: 0.5 }],
};

const AI_USAGE = [
  { provider: 'openai', requests: 10, estimatedCostUsd: 0.5, date: '2026-01-01' },
  { provider: 'openai', requests: 4, estimatedCostUsd: 0.2, date: '2026-01-02' },
];

const USERS = {
  users: [
    {
      id: 'u2',
      email: 'bob@example.com',
      displayName: 'Bob',
      rbacRole: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActive: null,
      projectCount: 2,
    },
    {
      id: 'u3',
      email: 'carol@example.com',
      displayName: 'Carol',
      rbacRole: 'member',
      createdAt: '2026-01-02T00:00:00.000Z',
      lastActive: '2026-01-03T00:00:00.000Z',
      projectCount: 0,
    },
  ],
  total: 2,
  page: 1,
  limit: 20,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.unstubAllGlobals();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', adminFetch(fetchMock));
});

function renderPage(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <ToastProvider>{node}</ToastProvider>
    </AuthProvider>,
  );
}

describe('AdminDashboard (UI_EX_01 styling)', () => {
  it('renders stat cards and the AI usage card using .cc-* classes only', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/admin/stats')) return jsonResponse(STATS);
      if (url.includes('/api/v1/admin/ai-usage')) return jsonResponse(AI_USAGE);
      return jsonResponse({ data: {} });
    });

    const { container } = renderPage(<AdminDashboard />);

    await waitFor(() => expect(screen.getByText('Total Users')).toBeInTheDocument());
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('AI Usage (Last 30 Days)')).toBeInTheDocument();

    expect(container.querySelectorAll('.cc-admin-card').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[class*="bg-white"]')).toBeNull();
    expect(container.querySelector('[class*="rounded-lg"]')).toBeNull();
    expect(container.querySelector('[class*="font-bold"]')).toBeNull();
  });
});

describe('AdminUsers (UI_EX_01 styling)', () => {
  it('renders the search panel, table and role pills with .cc-* classes', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/admin/users')) return jsonResponse(USERS);
      return jsonResponse({ data: {} });
    });

    const { container } = renderPage(<AdminUsers />);

    await waitFor(() => expect(screen.getByPlaceholderText('Search by email or name...')).toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();

    expect(container.querySelectorAll('.cc-table').length).toBe(1);
    expect(container.querySelectorAll('.cc-pill').length).toBe(2);
    expect(container.querySelector('[class*="bg-white"]')).toBeNull();
    expect(container.querySelector('[class*="border-gray"]')).toBeNull();
  });
});

describe('AdminAIUsage (UI_EX_01 styling)', () => {
  it('renders summary cards and the range select with .cc-* classes', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/admin/ai-usage')) return jsonResponse(AI_USAGE);
      return jsonResponse({ data: {} });
    });

    const { container } = renderPage(<AdminAIUsage />);

    await waitFor(() => expect(screen.getByText('AI Usage Analytics')).toBeInTheDocument());
    expect(screen.getByText('Total Requests')).toBeInTheDocument();
    const totalCards = screen.getAllByText('14');
    expect(totalCards.length).toBeGreaterThanOrEqual(1);

    const range = within(screen.getByRole('combobox'));
    expect(range.getByRole('option', { name: 'Last 30 Days' })).toBeInTheDocument();

    expect(container.querySelectorAll('.cc-admin-card').length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector('[class*="text-2xl"]')).toBeNull();
    expect(container.querySelector('[class*="font-bold"]')).toBeNull();
  });
});

describe('ErrorBoundary (UI_EX_01 styling)', () => {
  const Broken = () => {
    throw new Error('boom');
  };

  it('renders a styled fallback with .cc-error-* classes and action buttons', () => {
    const { container } = render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/Your work is safe/)).toBeInTheDocument();
    expect(screen.queryByText(/team has been notified/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload Page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go Home' })).toBeInTheDocument();

    expect(container.querySelector('.cc-error-screen')).not.toBeNull();
    expect(container.querySelector('.cc-error-card')).not.toBeNull();
    expect(container.querySelector('.cc-error-badge')).not.toBeNull();
    expect(container.querySelector('.cc-error-card__pre')).not.toBeNull();
    expect(container.querySelector('[class*="bg-white"]')).toBeNull();
  });
});