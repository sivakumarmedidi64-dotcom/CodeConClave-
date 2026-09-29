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
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { SettingsPage } from './SettingsPage';
import { copyText } from '../lib/clipboard';
import type { User } from '../lib/types';

vi.mock('../lib/clipboard', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/clipboard')>();
  return { ...mod, copyText: vi.fn(async () => true) };
});

const copyTextMock = vi.mocked(copyText);

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
  unlockMode: 'MANUAL',
  plans: { pro: 999, team: 4999, api: 9999 },
  evidence: {
    link: { enabled: true, reason: null },
    api: { enabled: false, reason: 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not both configured' },
    webhook: { enabled: false, reason: 'RAZORPAY_WEBHOOK_SECRET is not configured (webhook mode off)' },
  },
  razorpayConfigured: false,
  razorpayMode: 'payment_link',
  currency: 'INR',
};

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderPage(handler: (url: string, init?: RequestInit) => Promise<Response>, initialEntry = '/settings') {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const result = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <SettingsPage />
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

function selectedTab(): string | undefined {
  return screen
    .getAllByRole('tab')
    .find((t) => t.getAttribute('aria-selected') === 'true')
    ?.textContent?.trim();
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
    if (url.includes('/api/v1/apikeys/access')) return jsonResponse({ data: { access: { planId: 'api', entitled: false, state: null } } });
    return jsonResponse({ data: {} });
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

async function openBilling() {
  const userEventApi = userEvent.setup();
  await userEventApi.click(screen.getByRole('tab', { name: 'billing' }));
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
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
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
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
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
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText('VERIFIED')).toBeTruthy();
    expect(screen.queryByTestId('billing-pending-note')).toBeNull();
  });

  it('renders a revoked entitlement honestly', async () => {
    renderPage(
      apiHandler([], [{ id: 'ent_1', planId: 'pro', state: 'REVOKED', activatedAt: null }]),
    );
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText('REVOKED')).toBeTruthy();
  });

  it('renders the server-authoritative payment intent status per plan (STAGE 26H)', async () => {
    renderPage(apiHandler([], []));
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    await waitFor(() => screen.getByText('Payment intent status'));
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('PRO_PENDING')).toBeTruthy();
    expect(screen.getByText('free')).toBeTruthy();
  });
});

describe('API Access product UI (STAGE 26H add-on)', () => {
  it('shows the API Access add-on card with the ₹9999 fallback price and an upgrade CTA when not entitled', async () => {
    renderPage(apiHandler([], []));
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText('API Access')).toBeTruthy();
    expect(screen.getAllByText('₹9999').length).toBeGreaterThan(0);
    const cta = screen.getByRole('button', { name: /Upgrade to API Access/ });
    expect(cta).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage keys' })).toBeNull();
  });

  it('shows Manage keys in the Billing tab once the API Access entitlement is verified', async () => {
    const userEventApi = userEvent.setup();
    const base = apiHandler([], []);
    renderPage(async (url) => {
      if (url.includes('/api/v1/apikeys/access')) {
        return jsonResponse({ data: { access: { planId: 'api', entitled: true, state: 'PRO_VERIFIED' } } });
      }
      return base(url);
    });
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByRole('button', { name: 'Manage keys' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upgrade to API Access/ })).toBeNull();
    await userEventApi.click(screen.getByRole('button', { name: 'Manage keys' }));
    expect(screen.getByPlaceholderText('Key name (e.g. CI, laptop)')).toBeTruthy();
  });
});

describe('API Keys tab — product gate (STAGE 26H add-on)', () => {
  it('locks key creation without the API Access add-on and routes to Billing', async () => {
    const userEventApi = userEvent.setup();
    renderPage(apiHandler([], []));
    await waitFor(() => screen.getByRole('tab', { name: 'apikeys' }));
    await userEventApi.click(screen.getByRole('tab', { name: 'apikeys' }));
    expect(await screen.findByText(/API keys require the API Access add-on/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Key name (e.g. CI, laptop)')).toBeNull();
    await userEventApi.click(screen.getByRole('button', { name: /Go to Billing/ }));
    expect(await screen.findByText('API Access')).toBeTruthy();
  });
});

describe('API Keys tab — creation UX honesty', () => {
  function entitledKeysHandler(onPost?: (url: string, init?: RequestInit) => Promise<Response>) {
    const base = apiHandler([], []);
    return async (url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/apikeys/access')) {
        return jsonResponse({ data: { access: { planId: 'api', entitled: true, state: 'PRO_VERIFIED' } } });
      }
      if (url === '/api/v1/apikeys' && init?.method === 'POST') {
        if (onPost) return onPost(url, init);
        return jsonResponse({
          data: {
            key: {
              id: 'k1', name: 'CI', keyPrefix: 'cc_abc', createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: null, lastUsedAt: null, revokedAt: null, revokeReason: null, key: 'cc_SECRET_VALUE',
            },
          },
        });
      }
      if (url === '/api/v1/apikeys') return jsonResponse({ data: { keys: [] } });
      return base(url);
    };
  }

  async function openKeysTab() {
    const userEventApi = userEvent.setup();
    await waitFor(() => screen.getByRole('tab', { name: 'apikeys' }));
    await userEventApi.click(screen.getByRole('tab', { name: 'apikeys' }));
    return userEventApi;
  }

  it('labels the name field and states keys are CodeConClave keys, not provider keys', async () => {
    renderPage(entitledKeysHandler());
    await openKeysTab();
    expect(await screen.findByLabelText('API key name')).toBeTruthy();
    expect(screen.getByText(/they are not Gemini, Mistral, or Nemotron provider keys/)).toBeTruthy();
  });

  it('shows a labelled dismiss control on the one-time secret box', async () => {
    const userEventApi = userEvent.setup();
    renderPage(entitledKeysHandler());
    await openKeysTab();
    await userEventApi.type(await screen.findByLabelText('API key name'), 'CI');
    await userEventApi.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('New API Key (copy now — never shown again)')).toBeTruthy();
    const dismiss = screen.getByRole('button', { name: 'Dismiss new-key notice' });
    await userEventApi.click(dismiss);
    await waitFor(() => expect(screen.queryByText('New API Key (copy now — never shown again)')).toBeNull());
  });

  it('copies the secret through the shared helper and toasts success', async () => {
    const userEventApi = userEvent.setup();
    copyTextMock.mockResolvedValue(true);
    renderPage(entitledKeysHandler());
    await openKeysTab();
    await userEventApi.type(await screen.findByLabelText('API key name'), 'CI');
    await userEventApi.click(screen.getByRole('button', { name: 'Create key' }));
    await userEventApi.click(await screen.findByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith('cc_SECRET_VALUE'));
    expect(await screen.findByText('Copied to clipboard')).toBeTruthy();
  });

  it('toasts copy failure instead of claiming success when the copy helper reports failure', async () => {
    const userEventApi = userEvent.setup();
    copyTextMock.mockResolvedValueOnce(false);
    renderPage(entitledKeysHandler());
    await openKeysTab();
    await userEventApi.type(await screen.findByLabelText('API key name'), 'CI');
    await userEventApi.click(screen.getByRole('button', { name: 'Create key' }));
    await userEventApi.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy failed — select the key text manually')).toBeTruthy();
    expect(screen.queryByText('Copied to clipboard')).toBeNull();
  });

  it('wraps the keys table in a horizontal scroll container (no viewport overflow on narrow screens)', async () => {
    const userEventApi = userEvent.setup();
    const base = apiHandler([], []);
    renderPage(async (url) => {
      if (url.includes('/api/v1/apikeys/access')) {
        return jsonResponse({ data: { access: { planId: 'api', entitled: true, state: 'PRO_VERIFIED' } } });
      }
      if (url === '/api/v1/apikeys') {
        return jsonResponse({
          data: {
            keys: [{
              id: 'k1', name: 'CI', keyPrefix: 'cc_abc', createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: null, lastUsedAt: null, revokedAt: null, revokeReason: null,
            }],
          },
        });
      }
      return base(url);
    });
    await waitFor(() => screen.getByRole('tab', { name: 'apikeys' }));
    await userEventApi.click(screen.getByRole('tab', { name: 'apikeys' }));
    const nameCell = await screen.findByText('CI');
    const table = nameCell.closest('table');
    expect(table).not.toBeNull();
    // The table must scroll inside its container instead of spilling past
    // the card on 375px viewports.
    expect(table!.closest('.cc-table-wrap')).not.toBeNull();
  });
});

describe('Solo/Team independent purchase states (Part E)', () => {
  function statusHandler(effectivePlan: string) {
    const base = apiHandler([], []);
    return async (url: string) => {
      if (url === '/api/v1/payments/status') {
        const plans =
          effectivePlan === 'pro'
            ? [
                { planId: 'pro', intentStatus: 'ACTIVE', confidence: 1, entitlementState: 'PRO_VERIFIED', activatedAt: new Date().toISOString() },
                { planId: 'team', intentStatus: null, confidence: null, entitlementState: null, activatedAt: null },
              ]
            : [
                { planId: 'pro', intentStatus: null, confidence: null, entitlementState: null, activatedAt: null },
                { planId: 'team', intentStatus: 'ACTIVE', confidence: 1, entitlementState: 'PRO_VERIFIED', activatedAt: new Date().toISOString() },
              ];
        return jsonResponse({
          data: { effectivePlan, accountEmail: 'payments@codeconclave.dev', plans },
        });
      }
      return base(url);
    };
  }

  it('keeps the Team card visible for a Solo-active user (Team is an independent purchase)', async () => {
    renderPage(statusHandler('pro'));
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText('Team is a separate, independent purchase.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Upgrade to TEAM/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upgrade to PRO/ })).toBeNull();
    expect(screen.getByText(/plan active — billing and cancellation below/)).toBeTruthy();
  });

  it('states the 30-member Team cap on the Team plan card', async () => {
    renderPage(apiHandler([], []));
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText(/up to 30 team members/)).toBeTruthy();
  });

  it('labels the active plan accurately (TEAM, not PRO) and still offers the API Access add-on', async () => {
    renderPage(statusHandler('team'));
    await waitFor(() => screen.getByRole('tab', { name: 'billing' }));
    await openBilling();
    expect(await screen.findByText(/plan active — billing and cancellation below/)).toBeTruthy();
    expect(screen.getByText('TEAM')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Upgrade to TEAM/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Upgrade to API Access/ })).toBeTruthy();
  });
});

describe('Settings deep links (W-1)', () => {
  it('opens the Security tab from ?tab=security', () => {
    renderPage(apiHandler([], []), '/settings?tab=security');
    expect(selectedTab()).toBe('security');
    expect(screen.getByText('Two-factor authentication')).toBeTruthy();
  });

  it('opens the Devices tab from ?tab=devices', () => {
    renderPage(apiHandler([], []), '/settings?tab=devices');
    expect(selectedTab()).toBe('devices');
    expect(screen.getByText('Devices & sessions')).toBeTruthy();
  });

  it('opens the Preferences tab from ?tab=preferences', () => {
    renderPage(apiHandler([], []), '/settings?tab=preferences');
    expect(selectedTab()).toBe('preferences');
    expect(screen.getByText('Workspace preferences')).toBeTruthy();
  });

  it('keeps the Billing deep link working', () => {
    renderPage(apiHandler([], []), '/settings?tab=billing');
    expect(selectedTab()).toBe('billing');
    expect(screen.getByText('Payments & plan')).toBeTruthy();
  });

  it('falls back to Profile for an unknown tab value', () => {
    renderPage(apiHandler([], []), '/settings?tab=bogus');
    expect(selectedTab()).toBe('profile');
    expect(screen.getByText('Profile')).toBeTruthy();
  });

  it('defaults to Profile on a bare /settings route', () => {
    renderPage(apiHandler([], []));
    expect(selectedTab()).toBe('profile');
  });

  it('writes the active tab to the URL and clears it for Profile', async () => {
    const userEventApi = userEvent.setup();
    renderPage(apiHandler([], []));
    expect(screen.getByTestId('location').textContent).toBe('/settings');

    await userEventApi.click(screen.getByRole('tab', { name: 'security' }));
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=security');

    await userEventApi.click(screen.getByRole('tab', { name: 'profile' }));
    expect(screen.getByTestId('location').textContent).toBe('/settings');
  });
});