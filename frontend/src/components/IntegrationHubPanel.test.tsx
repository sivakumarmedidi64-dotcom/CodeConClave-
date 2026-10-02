/**
 * CodeConClave — IntegrationHubPanel tests (PKG-26).
 * Honest integration catalog rendering: server-derived states (CONNECTED,
 * AUTH_REQUIRED, ENVIRONMENT_BLOCKED, UNCONFIGURED), deployment capability
 * matrix, webhook source counts (never secrets), and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { IntegrationHubPanel } from './IntegrationHubPanel';

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

const provider = (p: string, name: string, category: string, state: string, connection: unknown) => ({
  provider: p,
  name,
  category,
  kind: 'git',
  state,
  integration: state,
  health: state,
  serverConfigured: true,
  adapterAvailable: true,
  connection,
  capabilities: ['cap.one'],
  actions: [],
  oauthRequired: true,
});

const hubPayload = () => ({
  providers: [
    provider('github', 'GitHub', 'Source Control', 'CONNECTED', { id: 'c1', state: 'CONNECTED', scopes: ['repositories:read'], lastHealthCheckAt: null, lastError: null, lastEventAt: null }),
    provider('slack', 'Slack', 'Communication', 'AUTH_REQUIRED', null),
    provider('vercel', 'Vercel', 'Deployment', 'ENVIRONMENT_BLOCKED', null),
    provider('notion', 'Notion', 'Knowledge', 'UNCONFIGURED', null),
  ],
  deploymentProviders: [
    { provider: 'railway', state: 'ENVIRONMENT_BLOCKED', supportsRollback: true, live: false, reason: 'no credentials in this environment' },
    { provider: 'vercel', state: 'ENVIRONMENT_BLOCKED', supportsRollback: true, live: false, reason: 'no token' },
  ],
  webhookSources: [{ source: 'github', count: 1, enabled: 1 }],
  observability: { sentryConfigured: false, metricsAvailable: true },
  live: 'ENVIRONMENT_BLOCKED',
});

describe('IntegrationHubPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the honest live-status banner (ENVIRONMENT_BLOCKED, no fake connections)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(hubPayload()));
    await act(async () => render(<IntegrationHubPanel />));
    expect(screen.getByTestId('hub-live').textContent).toContain('ENVIRONMENT_BLOCKED');
  });

  it('renders provider states distinctly: CONNECTED vs AUTH_REQUIRED vs UNCONFIGURED', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(hubPayload()));
    await act(async () => render(<IntegrationHubPanel />));
    expect(screen.getByTestId('hub-state-github').textContent).toContain('CONNECTED');
    expect(screen.getByTestId('hub-state-slack').textContent).toContain('AUTH_REQUIRED');
    expect(screen.getByTestId('hub-state-notion').textContent).toContain('UNCONFIGURED');
  });

  it('renders deployment providers with honest ENVIRONMENT_BLOCKED + reason', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(hubPayload()));
    await act(async () => render(<IntegrationHubPanel />));
    expect(screen.getByTestId('hub-dep-state-railway').textContent).toContain('ENVIRONMENT_BLOCKED');
    expect(screen.getByTestId('hub-deployment').textContent).toContain('no credentials in this environment');
  });

  it('renders webhook source counts without exposing secret material', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(hubPayload()));
    await act(async () => render(<IntegrationHubPanel />));
    const webhook = screen.getByTestId('hub-webhook-github').textContent!;
    expect(webhook).toContain('1 secret(s)');
    expect(webhook).not.toContain('hmac_key');
    expect(webhook).not.toContain('secret_hash');
    expect(screen.getByTestId('hub-webhooks').textContent).toContain('github');
  });

  it('renders observability honestly (Sentry not configured → ENVIRONMENT_BLOCKED)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(hubPayload()));
    await act(async () => render(<IntegrationHubPanel />));
    expect(screen.getByTestId('hub-observability').textContent).toContain('ENVIRONMENT_BLOCKED');
  });

  it('shows an error state when hub fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    await act(async () => render(<IntegrationHubPanel />));
    expect(screen.getByTestId('hub-error').textContent).toContain('network down');
  });
});
