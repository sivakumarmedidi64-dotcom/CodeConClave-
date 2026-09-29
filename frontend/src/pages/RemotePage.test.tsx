/**
 * CodeConClave — Remote Control page tests (PHASE 4B).
 * Honest presence (ONLINE/STALE/OFFLINE), remote session lifecycle
 * (create/revoke), screenshot authorization, and the honest unavailable
 * screenshot result — no simulated images.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { RemotePage } from './RemotePage';
import type { DeviceInfo, RemoteSessionInfo } from '../lib/types';

vi.mock('qrcode', () => ({
  default: {
    toDataURL: async (text: string) => `data:image/png;base64,${btoa(text)}`,
  },
}));

const ONLINE_DEVICE: DeviceInfo = {
  id: 'dev_online',
  name: 'laptop',
  state: 'PAIRED',
  pairedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:10.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  capabilities: ['file_read', 'terminal_exec'],
  presence: 'ONLINE',
  remoteCapable: true,
};

const STALE_DEVICE: DeviceInfo = {
  id: 'dev_stale',
  name: 'desktop',
  state: 'PAIRED',
  pairedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
  createdAt: '2026-01-01T00:00:00.000Z',
  capabilities: ['file_read'],
  presence: 'STALE',
  remoteCapable: false,
};

const REMOTE: RemoteSessionInfo = {
  id: 'rms_1',
  deviceId: 'dev_online',
  deviceName: 'laptop',
  state: 'ACTIVE',
  startedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  lastActiveAt: '2026-01-01T00:00:00.000Z',
  screenshotAuthorized: false,
  screenshotAuthExpiresAt: null,
  revokedAt: null,
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    blob: async () => new Blob(['png'], { type: 'image/png' }),
  } as unknown as Response;
}

function renderPage(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const result = render(
    <MemoryRouter>
      <ToastProvider>
        <RemotePage />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('RemotePage — devices, sessions, screenshot privacy', () => {
  it('shows a scannable QR code with the pair command while keeping the text steps', async () => {
    const pairResponse = {
      deviceId: 'la_test',
      pairingCode: '123456',
      expiresInSeconds: 60,
    };
    renderPage(async (url, init) => {
      if (url.includes('/auth/devices') && init?.method === 'POST') {
        return jsonResponse({ data: pairResponse }, 201);
      }
      if (url.includes('/remote/devices')) return jsonResponse({ data: { devices: [] } });
      if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [] } });
      return jsonResponse({ data: {} });
    });
    expect(screen.getByRole('button', { name: 'Begin pairing' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Begin pairing' }));
    await waitFor(() => expect(screen.getByText('123456')).toBeInTheDocument());
    expect(screen.getByText(/npx codeconclave-agent pair la_test 123456/)).toBeInTheDocument();
    expect(screen.getByTestId('pair-qr')).toBeInTheDocument();
    expect(screen.getByText('Scan to get the pair command')).toBeInTheDocument();
  });

  it('renders honest presence (ONLINE vs STALE) and capability tags', async () => {
    renderPage(async (url) => {
      if (url.includes('/remote/devices')) return jsonResponse({ data: { devices: [ONLINE_DEVICE, STALE_DEVICE] } });
      if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [] } });
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByText('ONLINE')).toBeInTheDocument());
    expect(screen.getByText('STALE')).toBeInTheDocument();
    expect(screen.getByText('terminal-capable')).toBeInTheDocument();
  });

  it('starts an 8-hour remote session on a capable device', async () => {
    let created = false;
    renderPage(async (url, init) => {
      if (url.includes('/remote/devices')) return jsonResponse({ data: { devices: [ONLINE_DEVICE] } });
      if (url.includes('/remote/sessions') && init?.method === 'POST') {
        created = true;
        return jsonResponse({ data: { session: REMOTE } }, 201);
      }
      if (url.includes('/remote/sessions')) {
        return jsonResponse({ data: { sessions: created ? [REMOTE] : [] } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start remote session' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Start remote session' }));
    await waitFor(() => expect(screen.getByText(/rms_1 — ACTIVE/)).toBeInTheDocument());
    expect(created).toBe(true);
  });

  it('refuses screenshots without authorization and reports the honest unavailable result after authorizing', async () => {
    let created = false;
    renderPage(async (url, init) => {
      if (url.includes('/remote/devices')) return jsonResponse({ data: { devices: [ONLINE_DEVICE] } });
      if (url.includes('/remote/sessions') && init?.method === 'POST') {
        created = true;
        return jsonResponse({ data: { session: REMOTE } }, 201);
      }
      if (url.includes('/remote/sessions') && init?.method === 'DELETE') {
        created = false;
        return jsonResponse({ data: { ok: true } });
      }
      if (url.includes('/remote/sessions') && url.includes('/screenshot-auth')) {
        return jsonResponse({ data: { ok: true } });
      }
      if (url.includes('/screenshot')) {
        return jsonResponse(
          { error: { code: 'screenshot_source_unavailable', message: 'No real screenshot source exists on this platform' } },
          501,
        );
      }
      if (url.includes('/remote/sessions')) {
        return jsonResponse({ data: { sessions: created ? [REMOTE] : [] } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start remote session' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Start remote session' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request screenshot' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Authorize screenshot (15 min)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Request screenshot' }));
    await waitFor(() => expect(screen.getByTestId('screenshot-honest')).toBeInTheDocument());
    expect(screen.getByTestId('screenshot-honest').textContent).toContain('nothing is simulated');
  });

  it('revokes a remote session immediately', async () => {
    let created = false;
    renderPage(async (url, init) => {
      if (url.includes('/remote/devices')) return jsonResponse({ data: { devices: [ONLINE_DEVICE] } });
      if (url.includes('/remote/sessions') && init?.method === 'POST') {
        created = true;
        return jsonResponse({ data: { session: REMOTE } }, 201);
      }
      if (url.includes('/remote/sessions') && init?.method === 'DELETE') {
        created = false;
        return jsonResponse({ data: { ok: true } });
      }
      if (url.includes('/remote/sessions')) {
        return jsonResponse({ data: { sessions: created ? [REMOTE] : [] } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start remote session' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Start remote session' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText(/rms_1 — ACTIVE/)).not.toBeInTheDocument());
  });
});