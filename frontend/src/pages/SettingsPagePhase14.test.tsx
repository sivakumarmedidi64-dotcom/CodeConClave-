/**
 * CodeConClave — SettingsPage Phase 14 tests.
 * Billing: server-driven pricing from capability.plans, cancellation request
 * flow, usage table (MEASURED / ESTIMATED / CONFIGURED LIMIT). Notifications:
 * timezone persisted, honest browser-notification capability UI. Providers:
 * server-derived statuses, reauth CTA, no secret leakage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { SettingsPage } from './SettingsPage';
import type { User } from '../lib/types';

const user: User = {
  id: 'usr_1',
  email: 'a@b.dev',
  emailVerified: true,
  displayName: 'Tester',
  avatarUrl: null,
  mfaEnabled: false,
  rbacRole: 'owner',
  planId: 'free',
  entitlementState: 'FREE',
};

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user, sendVerificationEmail: vi.fn(async () => ({ alreadyVerified: true })) }),
}));

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

const capability = {
  api: false,
  webhook: false,
  link: true,
  mode: 'payment_link',
  plans: { pro: 1499, team: 4999 },
  evidence: {
    link: { enabled: true, reason: null },
    api: { enabled: false, reason: null },
    webhook: { enabled: false, reason: null },
  },
  razorpayConfigured: false,
  razorpayMode: 'payment_link',
  currency: 'INR',
};

const usage = {
  plan: 'free',
  measured: {
    messagesToday: 7,
    storageBytes: 1048576,
    aiInputTokens: 1200,
    aiOutputTokens: 300,
    tasksToday: 2,
  },
  estimated: { computeCostUsd: 0.0014, sources: 1 },
  limits: { dailyMessages: 20, maxProjects: 1, storageGb: 2 },
  resetDate: '2026-08-16T00:00:00.000Z',
};

function renderPage(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const result = render(
    <MemoryRouter>
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

function apiHandler(overrides: Record<string, unknown> = {}) {
  return async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/sessions') return jsonResponse({ data: { sessions: [] } });
    if (url === '/api/v1/auth/devices') return jsonResponse({ data: { devices: [] } });
    if (url === '/api/v1/payments/capabilities') return jsonResponse({ data: capability });
    if (url === '/api/v1/payments/entitlements') return jsonResponse({ data: { entitlements: overrides.entitlements ?? [] } });
    if (url === '/api/v1/payments/sessions' && init?.method === 'POST') return jsonResponse({ data: {} });
    if (url === '/api/v1/payments/sessions/pay_1/cancel-request') {
      return jsonResponse({ data: { approval: { id: 'ap1', status: 'PENDING' } } });
    }
    if (url === '/api/v1/payments/sessions') return jsonResponse({ data: { sessions: overrides.sessions ?? [] } });
    if (url === '/api/v1/workspace/usage/overview') return jsonResponse({ data: { overview: usage } });
    if (url === '/api/v1/operations/providers') return jsonResponse({ data: overrides.providers });
    if (url === '/api/v1/notifications/preferences') return jsonResponse({ data: { prefs: {} } });
    if (url === '/api/v1/ai/models') return jsonResponse({ data: { models: [], defaultModel: null } });
    if (url === '/api/v1/digests/status') return jsonResponse({ data: overrides.digestStatus ?? { frequency: 'none', dnd: false } });
    return jsonResponse({ data: {} });
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).Notification;
});

async function openTab(name: string) {
  const userEventApi = userEvent.setup();
  await userEventApi.click(screen.getByRole('button', { name }));
}

describe('billing — server-driven pricing + cancellation + usage (Phase 14)', () => {
  it('derives the upgrade price from the server capability catalog', async () => {
    renderPage(apiHandler());
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openTab('billing');
    await waitFor(() => expect(screen.getByText('Upgrade to PRO (₹1499)')).toBeInTheDocument());
    expect(screen.queryByText('Upgrade to PRO (₹999)')).toBeNull();
  });

  it('sends a cancellation request for a PENDING session', async () => {
    const { fetchFn } = renderPage(
      apiHandler({
        sessions: [
          {
            id: 'pay_1',
            planId: 'pro',
            state: 'PENDING',
            razorpayRef: null,
            amount: 1499,
            createdAt: new Date().toISOString(),
            mode: 'PAYMENT_LINK',
          },
        ],
      }),
    );
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openTab('billing');
    const cancelBtn = await screen.findByRole('button', { name: 'Request cancellation' });
    await userEvent.click(cancelBtn);
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(
          ([u, i]) => i?.method === 'POST' && u.includes('/api/v1/payments/sessions/pay_1/cancel-request'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/Cancellation requested/)).toBeInTheDocument());
  });

  it('renders measured, estimated and configured-limit usage from the server', async () => {
    renderPage(apiHandler());
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openTab('billing');
    await waitFor(() => expect(screen.getByText('Messages today')).toBeInTheDocument());
    expect(screen.getByText('Measured')).toBeTruthy();
    expect(screen.getByText('Estimated')).toBeTruthy();
    expect(screen.getByText('Configured limit')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('20')).toBeTruthy();
    expect(screen.getByText(/\$0\.0014/)).toBeTruthy();
  });
});

describe('notifications — timezone + honest browser capability (Phase 14)', () => {
  it('persists the timezone with the notification preferences', async () => {
    const { fetchFn } = renderPage(apiHandler());
    await waitFor(() => screen.getByRole('button', { name: 'notifications' }));
    await openTab('notifications');
    await waitFor(() => screen.getByLabelText('Timezone (IANA, used for quiet hours & digests)'));
    await userEvent.type(screen.getByLabelText('Timezone (IANA, used for quiet hours & digests)'), 'Asia/Kolkata');
    await userEvent.click(screen.getByRole('button', { name: 'Save notification preferences' }));
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(
          ([u, i]) =>
            i?.method === 'PUT' && u.includes('/notifications/preferences') && String(i.body).includes('Asia/Kolkata'),
        ),
      ).toBe(true),
    );
  });

  it('reports unsupported environments honestly and offers an enable button', async () => {
    renderPage(apiHandler());
    await waitFor(() => screen.getByRole('button', { name: 'notifications' }));
    await openTab('notifications');
    await waitFor(() => expect(screen.getByText(/does not support the Notification API/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enable browser notifications' })).toBeTruthy();
  });

  it('shows granted permission state when the browser supports notifications', async () => {
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    }
    (window as unknown as Record<string, unknown>).Notification = FakeNotification;
    renderPage(apiHandler());
    await waitFor(() => screen.getByRole('button', { name: 'notifications' }));
    await openTab('notifications');
    await waitFor(() => expect(screen.getByText(/Permission granted/)).toBeInTheDocument());
  });
});

describe('providers — server-derived status (Phase 14)', () => {
  const providers = {
    providers: [
      {
        id: 'resend',
        name: 'Resend',
        category: 'email',
        status: 'AVAILABLE',
        reason: null,
        lastCheckedAt: new Date().toISOString(),
      },
      {
        id: 'razorpay',
        name: 'Razorpay',
        category: 'payments',
        status: 'LIMITED',
        reason: 'Payment Link enabled; API/webhook credentials not configured',
        capabilities: [
          { id: 'payment_link', available: true },
          { id: 'api', available: false },
          { id: 'webhook', available: false },
        ],
      },
      {
        id: 'google',
        name: 'Google',
        category: 'auth',
        status: 'REQUIRES_REAUTH',
        reason: '[REDACTED] — token expired',
        lastKnownState: 'CONNECTED',
        connectionId: 'conn_1',
      },
    ],
    generatedAt: new Date().toISOString(),
  };

  it('renders provider statuses with capability chips and reauth CTA', async () => {
    renderPage(apiHandler({ providers }));
    await waitFor(() => screen.getByRole('button', { name: 'providers' }));
    await openTab('providers');
    await waitFor(() => expect(screen.getByText('Resend')).toBeInTheDocument());
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('Re-authorization required')).toBeTruthy();
    expect(screen.getByText(/payment_link ON/)).toBeTruthy();
    expect(screen.getByText(/api OFF/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Re-authorize' })).toBeTruthy();
  });

  it('never renders provider secrets', async () => {
    renderPage(apiHandler({ providers }));
    await waitFor(() => screen.getByRole('button', { name: 'providers' }));
    await openTab('providers');
    await waitFor(() => expect(screen.getByText('Resend')).toBeInTheDocument());
    expect(screen.queryByText(/sk-live|rzp_live|re_test|sk-ant/i)).toBeNull();
    expect(screen.getByText('[REDACTED] — token expired')).toBeTruthy();
  });
});