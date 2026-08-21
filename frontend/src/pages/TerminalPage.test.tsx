/**
 * CodeConClave — Local Terminal page tests (PHASE 4B).
 * Real wiring against /api/v1/terminal + /api/v1/remote: session creation
 * with a paired device, agent-reported status/history (RUNNING with pid),
 * policy-denied input surfaced honestly, and history search.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { TerminalPage } from './TerminalPage';
import type { DeviceInfo, RemoteSessionInfo, TerminalHistoryLine, TerminalSessionInfo, User } from '../lib/types';

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

const DEVICE: DeviceInfo = {
  id: 'dev_laptop',
  name: 'laptop',
  state: 'PAIRED',
  pairedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:10.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  capabilities: ['file_read', 'file_write', 'terminal_exec'],
  presence: 'ONLINE',
  remoteCapable: true,
};

const REMOTE: RemoteSessionInfo = {
  id: 'rms_1',
  deviceId: 'dev_laptop',
  deviceName: 'laptop',
  state: 'ACTIVE',
  startedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  lastActiveAt: '2026-01-01T00:00:00.000Z',
  screenshotAuthorized: false,
  screenshotAuthExpiresAt: null,
  revokedAt: null,
};

const SESSION: TerminalSessionInfo = {
  id: 'tsm_1',
  deviceId: 'dev_laptop',
  deviceName: 'laptop',
  shell: 'bash',
  cwd: null,
  timeoutMs: null,
  status: 'RUNNING',
  pid: 4821,
  exitCode: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const HISTORY: TerminalHistoryLine[] = [
  { id: 'thl_1', sessionId: 'tsm_1', channel: 'stdout', text: 'hello from agent', seq: 1, createdAt: '2026-01-01T00:00:01.000Z' },
];

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    blob: async () => new Blob(['x'], { type: 'text/plain' }),
  } as unknown as Response;
}

function renderPage(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const result = render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <TerminalPage />
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
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalPage — device-driven session control', () => {
  it('creates a terminal session on the paired online device', async () => {
    let created = false;
    renderPage(
      authed(async (url, init) => {
        if (url.includes('/agent/status')) return jsonResponse({ data: { devices: [DEVICE] } });
        if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [REMOTE] } });
        if (url.includes('/terminal/sessions') && init?.method === 'POST') {
          created = true;
          return jsonResponse({ data: { session: { ...SESSION, status: 'PLANNED', pid: null } } }, 201);
        }
        if (url.includes('/terminal/sessions')) {
          return jsonResponse({ data: { sessions: created ? [{ ...SESSION, status: 'PLANNED', pid: null }] : [] } });
        }
        return jsonResponse({ data: {} });
      }),
    );
    await waitFor(() => expect(screen.getByText('laptop — ONLINE')).toBeInTheDocument());
    expect(screen.queryAllByText(/tsm_1/)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(screen.getAllByText(/tsm_1/).length).toBeGreaterThan(0));
    expect(created).toBe(true);
  });

  it('shows agent-reported output and a real pid for RUNNING sessions', async () => {
    renderPage(
      authed(async (url) => {
        if (url.includes('/agent/status')) return jsonResponse({ data: { devices: [DEVICE] } });
        if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [REMOTE] } });
        if (url.includes('/terminal/sessions/tsm_1')) {
          return jsonResponse({ data: { session: SESSION, history: HISTORY } });
        }
        if (url.includes('/terminal/sessions')) return jsonResponse({ data: { sessions: [SESSION] } });
        return jsonResponse({ data: {} });
      }),
    );
    await waitFor(() => expect(screen.getByText(/tsm_1/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/tsm_1/));
    await waitFor(() => expect(screen.getByText('hello from agent')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText(/pid 4821/).length).toBeGreaterThan(0));
  });

  it('surfaces policy denials for dangerous input instead of dispatching', async () => {
    renderPage(
      authed(async (url, init) => {
        if (url.includes('/agent/status')) return jsonResponse({ data: { devices: [DEVICE] } });
        if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [REMOTE] } });
        if (url.includes('/terminal/sessions/tsm_1/input')) {
          return jsonResponse({ error: { code: 'baseline_commands', message: 'Action denied by policy: Dangerous commands are deny-by-default' } }, 403);
        }
        if (url.includes('/terminal/sessions/tsm_1')) {
          return jsonResponse({ data: { session: SESSION, history: [] } });
        }
        if (url.includes('/terminal/sessions')) return jsonResponse({ data: { sessions: [SESSION] } });
        return jsonResponse({ data: {} });
      }),
    );
    await waitFor(() => expect(screen.getByText(/tsm_1/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/tsm_1/));
    const input = await screen.findByPlaceholderText(/low-risk command only/);
    await userEvent.type(input, 'rm -rf /');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(screen.getByText('Action denied by policy: Dangerous commands are deny-by-default')).toBeInTheDocument(),
    );
  });

  it('searches terminal history and shows matching lines', async () => {
    renderPage(
      authed(async (url) => {
        if (url.includes('/agent/status')) return jsonResponse({ data: { devices: [DEVICE] } });
        if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [] } });
        if (url.includes('/terminal/search')) {
          return jsonResponse({ data: { lines: HISTORY } });
        }
        if (url.includes('/terminal/sessions')) return jsonResponse({ data: { sessions: [] } });
        return jsonResponse({ data: {} });
      }),
    );
    await waitFor(() => expect(screen.getByPlaceholderText(/search terminal history/)).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/search terminal history/), 'agent');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText(/hello from agent/)).toBeInTheDocument());
  });

  it('restores the last active session across reloads (continuity)', async () => {
    const puts: string[] = [];
    renderPage(
      authed(async (url, init) => {
        if (url.includes('/api/v1/workspace/state/terminal_tabs') && init?.method === 'PUT') {
          puts.push(url);
          return jsonResponse({ data: { entry: {} } });
        }
        if (url.includes('/api/v1/workspace/state')) {
          return jsonResponse({ data: { state: [{ key: 'terminal_tabs', value: { activeId: 'tsm_1' } }] } });
        }
        if (url.includes('/agent/status')) return jsonResponse({ data: { devices: [DEVICE] } });
        if (url.includes('/remote/sessions')) return jsonResponse({ data: { sessions: [REMOTE] } });
        if (url.includes('/terminal/sessions/tsm_1')) {
          return jsonResponse({ data: { session: SESSION, history: HISTORY } });
        }
        if (url.includes('/terminal/sessions')) return jsonResponse({ data: { sessions: [SESSION] } });
        return jsonResponse({ data: {} });
      }),
    );
    await waitFor(() => expect(screen.getByText('hello from agent')).toBeInTheDocument(), { timeout: 6000 });
    expect(screen.getByPlaceholderText(/low-risk command only/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByText(/tsm_1/)[0]!);
    await waitFor(() => expect(puts).toContain('/api/v1/workspace/state/terminal_tabs'));
  });
});