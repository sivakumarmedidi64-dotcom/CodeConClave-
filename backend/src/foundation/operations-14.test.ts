/**
 * CodeConClave — PHASE 14 unified provider capability status tests.
 * Covers: honest per-provider status derivation (Razorpay link-only LIMITED,
 * Resend env/plugin, Google/GitHub plugin states incl. REQUIRES_REAUTH with
 * sanitized reason, Sentry, storage memory, AI providers from health), and
 * the no-secret-leakage guarantee.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const listConnections = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../modules/plugins/health.js', () => ({ listConnections }));

import { env } from '../config/env.js';
import { providerStatus, sanitizeProviderError } from '../modules/operations/service.js';

const ENV_KEYS = [
  'RAZORPAY_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_ENABLED',
  'RESEND_API_KEY', 'RESEND_ENABLED',
  'SENTRY_DSN', 'SENTRY_ENABLED',
  'STORAGE_PROVIDER', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'AI_PROVIDERS_ENABLED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY',
] as const;

const originalEnv: Record<string, unknown> = {};
beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  listConnections.mockResolvedValue([]);
  for (const key of ENV_KEYS) originalEnv[key] = env[key as keyof typeof env];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    (env as Record<string, unknown>)[key] = originalEnv[key];
  }
  vi.unstubAllGlobals();
});

function conn(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'plg1',
    owner_id: 'u1',
    plugin_type: 'google',
    name: 'Google',
    state: 'CONNECTED',
    scopes: [],
    credential_ref: 'cred:1',
    last_health_check_at: new Date(),
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('payment + email + observability + storage', () => {
  it('reports Razorpay as LIMITED with link ON and api/webhook OFF', async () => {
    env.RAZORPAY_MODE = 'payment_link';
    env.RAZORPAY_KEY_ID = undefined;
    env.RAZORPAY_KEY_SECRET = undefined;
    env.RAZORPAY_WEBHOOK_SECRET = undefined;
    const report = await providerStatus('u1');
    const razorpay = report.providers.find((p) => p.id === 'razorpay')!;
    expect(razorpay.status).toBe('LIMITED');
    expect(razorpay.capabilities).toEqual([
      { id: 'payment_link', available: true },
      { id: 'api', available: false },
      { id: 'webhook', available: false },
    ]);
    expect(razorpay.reason).toContain('Payment Link enabled');
  });

  it('reports Razorpay AVAILABLE only when API credentials exist and the webhook verification rail is enabled', async () => {
    env.RAZORPAY_KEY_ID = 'rzp_live_x';
    env.RAZORPAY_KEY_SECRET = 'rzp_secret_x';
    env.RAZORPAY_WEBHOOK_SECRET = 'whsec_x';
    env.RAZORPAY_WEBHOOK_ENABLED = 'true';
    const report = await providerStatus('u1');
    const razorpay = report.providers.find((p) => p.id === 'razorpay')!;
    expect(razorpay.status).toBe('AVAILABLE');
    expect(razorpay.capabilities!.map((c) => c.available)).toEqual([true, true, true]);
  });

  it('reports Resend NOT_CONFIGURED without a key and AVAILABLE with env config', async () => {
    env.RESEND_API_KEY = undefined;
    let report = await providerStatus('u1');
    expect(report.providers.find((p) => p.id === 'resend')!.status).toBe('NOT_CONFIGURED');

    env.RESEND_API_KEY = 're_xyz';
    env.RESEND_ENABLED = 'true';
    report = await providerStatus('u1');
    expect(report.providers.find((p) => p.id === 'resend')!.status).toBe('AVAILABLE');
  });

  it('reports Sentry and storage honestly', async () => {
    env.SENTRY_DSN = undefined;
    env.STORAGE_PROVIDER = 'memory';
    let report = await providerStatus('u1');
    expect(report.providers.find((p) => p.id === 'sentry')!.status).toBe('NOT_CONFIGURED');
    const storage = report.providers.find((p) => p.id === 'storage')!;
    expect(storage.status).toBe('LIMITED');
    expect(storage.reason).toContain('Local memory storage');

    env.SENTRY_DSN = 'https://x@sentry.io/1';
    env.SENTRY_ENABLED = 'true';
    env.STORAGE_PROVIDER = 'r2';
    env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'ak';
    env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'sk';
    report = await providerStatus('u1');
    expect(report.providers.find((p) => p.id === 'sentry')!.status).toBe('AVAILABLE');
    expect(report.providers.find((p) => p.id === 'storage')!.status).toBe('AVAILABLE');
  });
});

describe('plugin-backed providers (google/github)', () => {
  it('maps connected plugins to AVAILABLE', async () => {
    listConnections.mockResolvedValue([conn({ id: 'g1', plugin_type: 'google', state: 'CONNECTED' })]);
    const report = await providerStatus('u1');
    const google = report.providers.find((p) => p.id === 'google')!;
    expect(google.status).toBe('AVAILABLE');
    expect(google.connectionId).toBe('g1');
    expect(google.lastKnownState).toBe('CONNECTED');
  });

  it('reports REQUIRES_REAUTH with the sanitized reason and last known state', async () => {
    listConnections.mockResolvedValue([
      conn({ id: 'g1', plugin_type: 'google', state: 'REAUTH_REQUIRED', last_error: 'token expired at https://x?access_token=super-secret-abc&x=1' }),
    ]);
    const report = await providerStatus('u1');
    const google = report.providers.find((p) => p.id === 'google')!;
    expect(google.status).toBe('REQUIRES_REAUTH');
    expect(google.lastKnownState).toBe('CONNECTED');
    expect(google.reason).not.toContain('super-secret-abc');
    expect(google.reason).toContain('[REDACTED]');
  });

  it('maps failed and disconnected plugin states honestly', async () => {
    listConnections.mockResolvedValue([
      conn({ id: 'g1', plugin_type: 'google', state: 'FAILED', last_error: 'connection reset' }),
      conn({ id: 'h1', plugin_type: 'github', state: 'DISCONNECTED' }),
    ]);
    const report = await providerStatus('u1');
    expect(report.providers.find((p) => p.id === 'google')!.status).toBe('FAILED');
    expect(report.providers.find((p) => p.id === 'github')!.status).toBe('NOT_CONFIGURED');
  });

  it('reports NOT_CONFIGURED when no connection exists', async () => {
    const report = await providerStatus('u1');
    expect(report.providers.find((p) => p.id === 'google')!.status).toBe('NOT_CONFIGURED');
    expect(report.providers.find((p) => p.id === 'github')!.status).toBe('NOT_CONFIGURED');
  });
});

describe('AI providers + secret safety', () => {
  it('reports only configured AI providers with health-derived status', async () => {
    env.AI_PROVIDERS_ENABLED = 'anthropic,openai';
    env.ANTHROPIC_API_KEY = 'sk-ant-abc';
    env.OPENAI_API_KEY = undefined;
    db.state.resolve = (text) =>
      text.includes('FROM provider_health')
        ? [{ provider_id: 'anthropic', state: 'HEALTHY', last_check_at: new Date() }]
        : null;
    const report = await providerStatus('u1');
    const ids = report.providers.map((p) => p.id);
    expect(ids).toContain('ai:anthropic');
    expect(ids).not.toContain('ai:openai');
    const anthropic = report.providers.find((p) => p.id === 'ai:anthropic')!;
    expect(anthropic.status).toBe('AVAILABLE');
  });

  it('never includes secret values anywhere in the report', async () => {
    env.RAZORPAY_MODE = 'api';
    env.RAZORPAY_KEY_ID = 'rzp_live_super_secret';
    env.RAZORPAY_KEY_SECRET = 'rzp_secret_super_secret';
    env.RESEND_API_KEY = 're_super_secret';
    env.RESEND_ENABLED = 'true';
    env.ANTHROPIC_API_KEY = 'sk-ant-super_secret';
    env.AI_PROVIDERS_ENABLED = 'anthropic';
    listConnections.mockResolvedValue([
      conn({ plugin_type: 'google', state: 'REAUTH_REQUIRED', last_error: 'oauth client_secret=abc123def' }),
    ]);
    db.state.resolve = (text) =>
      text.includes('FROM provider_health')
        ? [{ provider_id: 'anthropic', state: 'UNKNOWN', last_check_at: null }]
        : null;
    const report = await providerStatus('u1');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('super_secret');
    expect(serialized).not.toContain('abc123def');
  });

  it('sanitizeProviderError redacts credential-shaped values', () => {
    expect(sanitizeProviderError('failed key=sk-live-12345')).toContain('[REDACTED]');
    expect(sanitizeProviderError('failed key=sk-live-12345')).not.toContain('sk-live-12345');
    expect(sanitizeProviderError('token expired ?access_token=abc&x=1')).toContain('[REDACTED]');
    expect(sanitizeProviderError(null)).toBeNull();
  });
});