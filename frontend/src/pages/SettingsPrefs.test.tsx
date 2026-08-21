/**
 * CodeConClave — SettingsPage notification + model preferences tests (PHASE 11).
 * Notifications tab loads prefs, toggles flags, saves via PUT; the preferences
 * tab persists a default model through the workspace preferences API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { SettingsPage } from './SettingsPage';
import { jsonResponse, stubFetch, TEST_USER } from '../testutils';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: TEST_USER, sendVerificationEmail: vi.fn(async () => ({ alreadyVerified: true })) }),
}));

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function settingsHandler() {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/v1/auth/sessions') return jsonResponse({ data: { sessions: [] } });
    if (url === '/api/v1/auth/devices') return jsonResponse({ data: { devices: [] } });
    if (url === '/api/v1/payments/capabilities') {
      return jsonResponse({
        data: {
          api: false, webhook: false, link: true, mode: 'payment_link', plans: { pro: 999, team: 4999 },
          evidence: {
            link: { enabled: true, reason: null },
            api: { enabled: false, reason: 'not configured' },
            webhook: { enabled: false, reason: 'not configured' },
          },
          razorpayConfigured: false, razorpayMode: 'payment_link', currency: 'INR',
        },
      });
    }
    if (url === '/api/v1/payments/entitlements') return jsonResponse({ data: { entitlements: [] } });
    if (url === '/api/v1/payments/sessions') return jsonResponse({ data: { sessions: [] } });
    if (url === '/api/v1/notifications/preferences') {
      if (init?.method === 'PUT') return jsonResponse({ data: { prefs: JSON.parse(String(init.body)) } });
      return jsonResponse({ data: { prefs: { in_app: true, push: false, email: true, dnd: false } } });
    }
    if (url === '/api/v1/ai/models') {
      return jsonResponse({
        data: {
          models: [{ id: 'sonnet', providerId: 'anthropic', label: 'Claude Sonnet', description: null, tier: 'CAPABLE', computeClass: 'B', health: 'HEALTHY', locked: false, available: true }],
          defaultModel: 'sonnet',
        },
      });
    }
    if (url === '/api/v1/workspace/preferences') {
      if (init?.method === 'PUT') return jsonResponse({ data: { prefs: JSON.parse(String(init.body)).prefs } });
      return jsonResponse({ data: { prefs: { theme: 'light', current_model: 'sonnet' } } });
    }
    return jsonResponse({ data: {} });
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsPage — notification preferences', () => {
  it('loads server notification preferences and toggles them', async () => {
    stubFetch(settingsHandler());
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'notifications' }));
    const inApp = await screen.findByLabelText('In-app notifications');
    expect(inApp).toBeChecked();
    expect(screen.getByLabelText('Push notifications')).not.toBeChecked();
    await userEvent.click(inApp);
    expect(inApp).not.toBeChecked();
  });

  it('saves notification preferences with PUT', async () => {
    const fetchFn = stubFetch(settingsHandler());
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'notifications' }));
    await screen.findByLabelText('In-app notifications');
    await userEvent.click(screen.getByLabelText('Push notifications'));
    await userEvent.click(screen.getByText('Save notification preferences'));
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/notifications/preferences' && i?.method === 'PUT');
      expect(put).toBeDefined();
    });
    expect(screen.getByText('Notification preferences saved')).toBeInTheDocument();
  });

  it('shows quiet hours inputs when DND is enabled', async () => {
    stubFetch(settingsHandler());
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'notifications' }));
    await userEvent.click(await screen.findByLabelText('Do not disturb'));
    expect(screen.getByLabelText('Quiet hours start')).toBeInTheDocument();
    expect(screen.getByLabelText('Quiet hours end')).toBeInTheDocument();
  });
});

describe('SettingsPage — default model preference', () => {
  it('persists the default model through workspace preferences', async () => {
    const fetchFn = stubFetch(settingsHandler());
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'preferences' }));
    const select = await screen.findByLabelText('Default model');
    expect(select).toHaveValue('sonnet');
    await userEvent.selectOptions(select, '');
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/workspace/preferences' && i?.method === 'PUT');
      expect(put).toBeDefined();
    });
  });
});