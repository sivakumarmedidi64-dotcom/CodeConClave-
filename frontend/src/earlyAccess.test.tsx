/**
 * CodeConClave — early-access surface tests.
 *
 * While the server reports temporary demo / early access, the commercial
 * surface (prices, checkout, plan upgrades, entitlement debug) is dormant:
 * it must not render anywhere in the customer-facing build, and it must come
 * back untouched once demo mode is switched off. Also covers the customer
 * authentication contract (no Google/OAuth sign-in) and the truthful
 * web/desktop choice copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AccessModeProvider, useEarlyAccess } from './lib/accessMode';
import { FreeLimitMoon } from './components/FreeLimitMoon';
import { CommandPalette } from './components/CommandPalette';
import { ToastProvider } from './components/Toast';
import { SettingsPage } from './pages/SettingsPage';
import { PluginsPage } from './pages/PluginsPage';
import type { PluginCatalogueEntry } from './lib/types';
import { parseVoiceCommand, getVoiceCommandHelp } from './lib/voiceCommands';

vi.mock('./auth/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'usr_1',
      email: 'a@b.dev',
      emailVerified: true,
      displayName: 'Tester',
      avatarUrl: null,
      mfaEnabled: false,
      rbacRole: 'owner',
      planId: 'free',
      entitlementState: 'FREE',
    },
  }),
}));

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

async function settingsHandler(url: string): Promise<Response> {
  if (url.includes('/api/v1/payments/capabilities')) {
    return jsonResponse({
      data: {
        api: false,
        webhook: false,
        link: true,
        mode: 'payment_link',
        unlockMode: 'MANUAL',
        plans: { pro: 999, team: 4999, api: 9999 },
        evidence: {
          link: { enabled: true, reason: null },
          api: { enabled: false, reason: 'not configured' },
          webhook: { enabled: false, reason: 'not configured' },
        },
        razorpayConfigured: false,
        razorpayMode: 'payment_link',
        currency: 'INR',
      },
    });
  }
  if (url.includes('/api/v1/payments/status')) {
    return jsonResponse({ data: { effectivePlan: 'free', accountEmail: 'a@b.dev', plans: [] } });
  }
  if (url.includes('/api/v1/payments/entitlements')) return jsonResponse({ data: { entitlements: [] } });
  if (url.includes('/api/v1/payments/sessions')) return jsonResponse({ data: { sessions: [] } });
  if (url.includes('/api/v1/payments/intents')) return jsonResponse({ data: { intents: [] } });
  if (url.includes('/api/v1/payments/claims')) return jsonResponse({ data: { claims: [] } });
  if (url.includes('/api/v1/auth/sessions')) return jsonResponse({ data: { sessions: [] } });
  if (url.includes('/api/v1/auth/devices')) return jsonResponse({ data: { devices: [] } });
  if (url.includes('/api/v1/apikeys/access')) {
    return jsonResponse({ data: { access: { planId: 'api', entitled: false, state: null } } });
  }
  return jsonResponse({ data: {} });
}

function renderSettings(initialEntry: string, earlyAccess: boolean) {
  vi.stubGlobal('fetch', vi.fn(settingsHandler));
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AccessModeProvider earlyAccess={earlyAccess}>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </AccessModeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('early access — presentation-only access mode', () => {
  it('defaults to the commercial surface when no provider is mounted', () => {
    function Probe() {
      return <span data-testid="probe">{useEarlyAccess() ? 'on' : 'off'}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('off');
    unmount();
    render(
      <AccessModeProvider earlyAccess>
        <Probe />
      </AccessModeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('on');
  });
});

describe('early access — dormant commercial surface in Settings', () => {
  it('drops the billing section entirely while early access is open', async () => {
    renderSettings('/settings', true);
    expect(await screen.findByRole('tab', { name: 'profile' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'billing' })).toBeNull();
    expect(screen.queryByText(/Entitlement:/)).toBeNull();
  });

  it('ignores a deep link into the dormant billing section', async () => {
    renderSettings('/settings?tab=billing', true);
    expect(await screen.findByRole('tab', { name: 'profile' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'billing' })).toBeNull();
    expect(screen.queryByText(/Go to Billing/)).toBeNull();
    expect(screen.queryByText(/Upgrade to/)).toBeNull();
  });

  it('never leaks internal demo or entitlement debug terminology', async () => {
    renderSettings('/settings', true);
    expect(await screen.findByRole('tab', { name: 'profile' })).toBeInTheDocument();
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    for (const leaked of [
      'temporaryDemoMode',
      'TEMPORARY_DEMO_MODE',
      'testBypass',
      'PAYMENT_TEST_USER_IDS',
      'PRO_VERIFIED',
      'entitlementState',
      'Entitlement:',
      'Upgrade to PRO',
      'Upgrade to TEAM',
      'Go to Billing',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it('keeps the billing section once demo mode is switched off', async () => {
    renderSettings('/settings', false);
    expect(await screen.findByRole('tab', { name: 'billing' })).toBeInTheDocument();
  });

  it('keeps the entitlement debug line only outside early access', async () => {
    renderSettings('/settings', false);
    expect(await screen.findByText(/Entitlement:/)).toBeInTheDocument();
  });
});

describe('early access — dormant commercial surface in the command palette', () => {
  async function openPalette(earlyAccess: boolean) {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: { projects: [] } })));
    render(
      <MemoryRouter initialEntries={['/home']}>
        <AccessModeProvider earlyAccess={earlyAccess}>
          <CommandPalette onToggleFocus={vi.fn()} />
        </AccessModeProvider>
      </MemoryRouter>,
    );
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => screen.getByRole('dialog'));
  }

  it('hides the billing command while early access is open', async () => {
    await openPalette(true);
    expect(screen.getByText('New Chat')).toBeInTheDocument();
    expect(screen.queryByText('Open Billing')).toBeNull();
  });

  it('offers the billing command again once demo mode is off', async () => {
    await openPalette(false);
    expect(screen.getByText('Open Billing')).toBeInTheDocument();
  });
});

describe('early access — usage limit moment', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: {} })));
  });

  it('does not sell a plan from the usage-limit moment during early access', async () => {
    const onUpgrade = vi.fn();
    const onClose = vi.fn();
    render(<FreeLimitMoon name="Tester" onUpgrade={onUpgrade} onClose={onClose} earlyAccess />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Pro' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the normal upgrade moment once demo mode is off', async () => {
    const onUpgrade = vi.fn();
    const onClose = vi.fn();
    render(<FreeLimitMoon name="Tester" onUpgrade={onUpgrade} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Pro' }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('early access — no OAuth plugin surface', () => {
  const googleEntry: PluginCatalogueEntry = {
    plugin_type: 'google',
    name: 'Google',
    description: 'Gmail, Calendar, Drive connectors (OAuth)',
    capabilities: ['gmail', 'calendar'],
    enabled: true,
    category: 'Productivity',
    popular: true,
    required_permissions: [],
    state: 'DISCONNECTED',
    status: 'NOT_CONNECTED',
    adapterAvailable: true,
    serverConfigured: false,
    integration: 'NOT_CONFIGURED',
  };
  const githubEntry: PluginCatalogueEntry = {
    plugin_type: 'github',
    name: 'GitHub',
    description: 'Repos, issues and workflows (token)',
    capabilities: ['repos'],
    enabled: true,
    category: 'Developer Tools',
    popular: true,
    required_permissions: [],
    state: 'DISCONNECTED',
    status: 'NOT_CONNECTED',
    adapterAvailable: true,
    serverConfigured: false,
    integration: 'NOT_CONFIGURED',
  };

  async function pluginsHandler(url: string): Promise<Response> {
    if (url.includes('/api/v1/plugins/catalogue')) {
      return jsonResponse({ plugins: [googleEntry, githubEntry] });
    }
    if (url.includes('/api/v1/control/plugins/sandbox/runs')) return jsonResponse({ runs: [] });
    if (url.includes('/api/v1/plugins/connections')) return jsonResponse({ connections: [] });
    return jsonResponse({ data: {} });
  }

  function renderPlugins(earlyAccess: boolean) {
    vi.stubGlobal('fetch', vi.fn(pluginsHandler));
    return render(
      <AccessModeProvider earlyAccess={earlyAccess}>
        <ToastProvider>
          <PluginsPage />
        </ToastProvider>
      </AccessModeProvider>,
    );
  }

  it('hides the OAuth (google) plugin and every authorize action while early access is open', async () => {
    renderPlugins(true);
    await screen.findByText('GitHub');
    expect(screen.queryByText('Google')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect + Authorize' })).toBeNull();
    expect(screen.queryAllByRole('option', { name: 'google' }).length).toBe(0);
  });

  it('restores the google OAuth plugin and its authorize action once demo mode is off', async () => {
    renderPlugins(false);
    await screen.findByText('Google');
    const connectButtons = screen.getAllByRole('button', { name: '+ Connect' });
    expect(connectButtons.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(connectButtons[0]!);
    expect(screen.getByRole('button', { name: 'Connect + Authorize' })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'google' }).length).toBeGreaterThan(0);
  });
});

describe('early access — voice navigation', () => {
  it('offers billing as a navigation target outside early access', () => {
    expect(parseVoiceCommand('go to billing')?.command).toBe('billing');
    expect(getVoiceCommandHelp().join('\n')).toContain('Go to Billing');
  });

  it('never routes to, or advertises, the dormant billing section during early access', () => {
    expect(parseVoiceCommand('go to billing', { earlyAccess: true })?.command).not.toBe('billing');
    expect(getVoiceCommandHelp({ earlyAccess: true }).join('\n')).not.toContain('Go to Billing');
  });
});
