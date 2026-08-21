/**
 * CodeConClave — SettingsPage billing tests (PHASE 4D).
 * Honest payment UX: PENDING sessions show the exact waiting-for-independent-
 * verification message and never claim success; evidence provider capability
 * chips reflect the server-derived capability (link ON, api/webhook OFF
 * without credentials); revoked entitlements render as REVOKED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    blob: async () => new Blob(['png'], { type: 'image/png' }),
  } as unknown as Response;
}

const capability = {
  api: false,
  webhook: false,
  link: true,
  mode: 'payment_link',
  plans: { pro: 999, team: 4999 },
  evidence: {
    link: { enabled: true, reason: null },
    api: { enabled: false, reason: 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not both configured' },
    webhook: { enabled: false, reason: 'RAZORPAY_WEBHOOK_SECRET is not configured (webhook mode off)' },
  },
  razorpayConfigured: false,
  razorpayMode: 'payment_link',
  currency: 'INR',
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

function apiHandler(sessions: Array<Record<string, unknown>>, entitlements: Array<Record<string, unknown>>) {
  return async (url: string) => {
    if (url === '/api/v1/auth/sessions') return jsonResponse({ data: { sessions: [] } });
    if (url === '/api/v1/auth/devices') return jsonResponse({ data: { devices: [] } });
    if (url === '/api/v1/payments/capabilities') return jsonResponse({ data: capability });
    if (url === '/api/v1/payments/entitlements') return jsonResponse({ data: { entitlements } });
    if (url === '/api/v1/payments/sessions') return jsonResponse({ data: { sessions } });
    if (url === '/api/v1/payments/status') {
      return jsonResponse({
        data: {
          effectivePlan: 'free',
          accountEmail: 'payments@codeconclave.dev',
          plans: [
            { planId: 'pro', intentStatus: 'PENDING', confidence: 0.25, entitlementState: 'PRO_PENDING', activatedAt: null },
            { planId: 'team', intentStatus: null, confidence: null, entitlementState: null, activatedAt: null },
          ],
        },
      });
    }
    return jsonResponse({ data: {} });
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

async function openBilling() {
  const userEventApi = userEvent.setup();
  await userEventApi.click(screen.getByRole('button', { name: 'billing' }));
}

describe('billing — honest payment verification UX (Phase 4D)', () => {
  it('shows the exact waiting-for-independent-verification message for PENDING sessions', async () => {
    renderPage(
      apiHandler(
        [
          {
            id: 'pay_1',
            planId: 'pro',
            state: 'PENDING',
            razorpayRef: null,
            amount: 999,
            createdAt: new Date().toISOString(),
            mode: 'PAYMENT_LINK',
          },
        ],
        [],
      ),
    );
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openBilling();
    const note = await screen.findByTestId('billing-pending-note');
    expect(note.textContent).toContain(
      'Payment received at the payment provider. CodeConClave is waiting for independent verification.',
    );
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
    expect(screen.queryByText('Pro activated')).toBeNull();
  });

  it('shows evidence provider chips derived from server capability (link ON, api/webhook OFF)', async () => {
    renderPage(apiHandler([], []));
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openBilling();
    await waitFor(() => screen.getByText(/Evidence providers/));
    expect(screen.getByText('link ON')).toBeTruthy();
    expect(screen.getByText('api OFF')).toBeTruthy();
    expect(screen.getByText('webhook OFF')).toBeTruthy();
  });

  it('does not claim success when there are no PENDING sessions', async () => {
    renderPage(
      apiHandler(
        [{ id: 'pay_2', planId: 'pro', state: 'VERIFIED', razorpayRef: null, amount: 999, createdAt: new Date().toISOString(), mode: 'PAYMENT_LINK' }],
        [],
      ),
    );
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText('VERIFIED')).toBeTruthy();
    expect(screen.queryByTestId('billing-pending-note')).toBeNull();
  });

  it('renders a revoked entitlement honestly', async () => {
    renderPage(
      apiHandler([], [{ id: 'ent_1', planId: 'pro', state: 'REVOKED', activatedAt: null }]),
    );
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText('REVOKED')).toBeTruthy();
  });

  it('renders the server-authoritative payment intent status per plan (STAGE 26H)', async () => {
    renderPage(apiHandler([], []));
    await waitFor(() => screen.getByRole('button', { name: 'billing' }));
    await openBilling();
    await waitFor(() => screen.getByText('Payment intent status'));
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('PRO_PENDING')).toBeTruthy();
    expect(screen.getByText('free')).toBeTruthy();
  });
});