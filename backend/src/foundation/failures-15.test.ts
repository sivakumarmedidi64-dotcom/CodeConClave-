/**
 * CodeConClave — PHASE 15 failure-mode tests.
 * Eleven failure categories, each validated honestly: no crash, no silent
 * success, no misleading HEALTHY. DB is mocked; module boundaries (watchdog
 * freshness, agent hub) are mocked with truthful stubs; providers never fake.
 * Categories: database, cache/Redis, AI providers, plugins, storage, worker
 * (stale), local agent (offline), email (Resend), Sentry, queue, outbox.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
    pingOk: boolean;
  } = {
    calls: [],
    rows: [],
    resolve: null,
    pingOk: true,
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
    ping: async () => state.pingOk,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const watchdogMock = vi.hoisted(() => {
  const lastWatchdogRunAt = vi.fn(() => null);
  const sweepOnce = vi.fn(async () => ({}));
  const startWatchdog = vi.fn(() => () => undefined);
  const errInfo = vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err)));
  return { lastWatchdogRunAt, sweepOnce, startWatchdog, errInfo };
});
vi.mock('../workers/watchdog.js', () => watchdogMock);

const cacheMock = vi.hoisted(() => {
  const health = vi.fn(async () => true);
  const incr = vi.fn(async () => 1);
  const get = vi.fn(async () => null);
  const set = vi.fn(async () => {});
  return { cache: { kind: 'redis', health, incr, get, set }, health, incr, get, set };
});
vi.mock('../shared/cache.js', () => cacheMock);

const agentWsMock = vi.hoisted(() => {
  const hubAttached = vi.fn(() => false);
  const stats = vi.fn(() => ({ connected: 0, pending: 0 }));
  return { hubAttached, stats, agentWs: () => ({ stats }) };
});
vi.mock('../modules/agent/ws.js', () => agentWsMock);

const listConnections = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../modules/plugins/health.js', () => ({ listConnections, sweepPluginHealth: async () => 0 }));

import { env } from '../config/env.js';
import { computeHealth } from '../health/health.js';
import { captureError } from '../observability/sentry.js';
import { providerStatus } from '../modules/operations/service.js';

const ENV_KEYS = [
  'REDIS_URL', 'QUEUE_PROVIDER', 'STORAGE_PROVIDER',
  'AI_PROVIDERS_ENABLED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY',
  'SENTRY_DSN', 'SENTRY_ENABLED',
  'RESEND_API_KEY', 'RESEND_ENABLED',
  'RAZORPAY_MODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
] as const;

const originalEnv: Record<string, unknown> = {};
beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  db.state.pingOk = true;
  watchdogMock.lastWatchdogRunAt.mockReturnValue(null);
  watchdogMock.sweepOnce.mockResolvedValue({});
  agentWsMock.hubAttached.mockReturnValue(false);
  agentWsMock.stats.mockReturnValue({ connected: 0, pending: 0 });
  cacheMock.health.mockResolvedValue(true);
  listConnections.mockResolvedValue([]);
  for (const key of ENV_KEYS) originalEnv[key] = env[key as keyof typeof env];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    (env as Record<string, unknown>)[key] = originalEnv[key];
  }
});

function healthBody(): ReturnType<typeof computeHealth> {
  return computeHealth();
}

describe('FAILURE CATEGORY 1 — database down', () => {
  it('reports FAILED with a failed database check, never a crash or HEALTHY', async () => {
    db.state.pingOk = false;
    const report = await healthBody();
    expect(report.status).toBe('FAILED');
    expect(report.checks.find((c) => c.id === 'database')?.status).toBe('FAILED');
    expect(report.checks.find((c) => c.id === 'database')?.reason).toContain('unreachable');
  });
});

describe('FAILURE CATEGORY 2 — cache / Redis down', () => {
  it('reports a FAILED cache check when Redis is configured but unreachable', async () => {
    env.REDIS_URL = 'redis://127.0.0.1:6399';
    cacheMock.health.mockResolvedValue(false);
    db.state.resolve = (text) => (text.includes('provider_health') || text.includes('plugin_connections') ? [] : null);
    const report = await healthBody();
    const cache = report.checks.find((c) => c.id === 'cache')!;
    expect(cache.status).toBe('FAILED');
    expect(report.status).toBe('FAILED');
  });

  it('reports FAILED when the configured Redis fell back to the in-memory store - never masked', async () => {
    env.REDIS_URL = 'redis://127.0.0.1:6399';
    cacheMock.cache.kind = 'memory';
    db.state.resolve = (text) => (text.includes('provider_health') || text.includes('plugin_connections') ? [] : null);
    const report = await healthBody();
    const cache = report.checks.find((c) => c.id === 'cache')!;
    expect(cache.status).toBe('FAILED');
    expect(cache.reason).toContain('fallback');
    expect(report.status).toBe('FAILED');
  });
});

describe('FAILURE CATEGORY 3 — AI providers down', () => {
  it('a configured provider in DOWN state fails the health report', async () => {
    env.AI_PROVIDERS_ENABLED = 'anthropic,openai';
    env.ANTHROPIC_API_KEY = 'sk-ant-test';
    env.OPENAI_API_KEY = 'sk-openai-test';
    db.state.resolve = (text) => {
      if (text.includes('provider_health')) return [{ provider_id: 'anthropic', state: 'DOWN' }, { provider_id: 'openai', state: 'HEALTHY' }];
      if (text.includes('plugin_connections')) return [];
      return null;
    };
    const report = await healthBody();
    expect(report.checks.find((c) => c.id === 'ai')?.status).toBe('FAILED');
    expect(report.status).toBe('FAILED');
  });
});

describe('FAILURE CATEGORY 4 — plugins failing', () => {
  it('failing plugin connections degrade the health report', async () => {
    db.state.resolve = (text) => {
      if (text.includes('plugin_connections')) return [{ state: 'FAILED' }];
      if (text.includes('provider_health')) return [];
      return null;
    };
    const report = await healthBody();
    expect(report.checks.find((c) => c.id === 'plugins')?.status).toBe('DEGRADED');
  });
});

describe('FAILURE CATEGORY 5 — storage not configured', () => {
  it('the in-memory dev store is NOT_CONFIGURED, never HEALTHY', async () => {
    env.STORAGE_PROVIDER = 'memory';
    const report = await healthBody();
    const storage = report.checks.find((c) => c.id === 'storage')!;
    expect(storage.status).toBe('NOT_CONFIGURED');
    expect(storage.status).not.toBe('HEALTHY');
  });
});

describe('FAILURE CATEGORY 6 — worker watchdog stale', () => {
  it('a stale watchdog sweep degrades the worker check', async () => {
    watchdogMock.lastWatchdogRunAt.mockReturnValue(Date.now() - 300_000);
    const report = await healthBody();
    const worker = report.checks.find((c) => c.id === 'worker')!;
    expect(worker.status).toBe('DEGRADED');
    expect(worker.reason).toContain('stale');
  });

  it('a fresh watchdog sweep is healthy', async () => {
    watchdogMock.lastWatchdogRunAt.mockReturnValue(Date.now() - 5_000);
    const report = await healthBody();
    expect(report.checks.find((c) => c.id === 'worker')?.status).toBe('HEALTHY');
  });
});

describe('FAILURE CATEGORY 7 — local agent offline', () => {
  it('hub attached with no agent online is DEGRADED', async () => {
    agentWsMock.hubAttached.mockReturnValue(true);
    agentWsMock.stats.mockReturnValue({ connected: 0, pending: 1 });
    const report = await healthBody();
    const agent = report.checks.find((c) => c.id === 'local-agent')!;
    expect(agent.status).toBe('DEGRADED');
  });

  it('hub not attached is NOT_CONFIGURED', async () => {
    const report = await healthBody();
    expect(report.checks.find((c) => c.id === 'local-agent')?.status).toBe('NOT_CONFIGURED');
  });
});

describe('FAILURE CATEGORY 8 — email provider (Resend) down', () => {
  it('a FAILED resend plugin connection is reported honestly', async () => {
    env.RESEND_API_KEY = 're_test_key';
    env.RESEND_ENABLED = 'true';
    listConnections.mockResolvedValue([
      {
        id: 'conn1', owner_id: 'u1', plugin_type: 'resend', name: 'Resend', state: 'FAILED',
        scopes: [], credential_ref: 'cred:1', last_health_check_at: new Date(), last_error: 'smtp refused',
        created_at: new Date(), updated_at: new Date(),
      },
    ]);
    db.state.resolve = (text) => (text.includes('provider_health') ? [] : null);
    const report = await providerStatus('u1');
    const resend = report.providers.find((p) => p.id === 'resend')!;
    expect(resend.status).toBe('FAILED');
  });
});

describe('FAILURE CATEGORY 9 — Sentry unavailable', () => {
  it('captureError is a guaranteed no-op when Sentry is not configured', () => {
    env.SENTRY_DSN = undefined;
    env.SENTRY_ENABLED = 'false';
    expect(() => captureError(new Error('boom'))).not.toThrow();
  });

  it('captureError is a no-op even when enabled but the package is missing', () => {
    env.SENTRY_DSN = 'https://fake@o1.ingest.sentry.io/1';
    env.SENTRY_ENABLED = 'true';
    expect(() => captureError(new Error('boom'))).not.toThrow();
  });

  it('the sentry health check is NOT_CONFIGURED without a DSN', async () => {
    env.SENTRY_DSN = undefined;
    env.SENTRY_ENABLED = 'false';
    const report = await healthBody();
    expect(report.checks.find((c) => c.id === 'sentry')?.status).toBe('NOT_CONFIGURED');
  });
});

describe('FAILURE CATEGORY 10 — queue not configured', () => {
  it('QUEUE_PROVIDER=memory is NOT_CONFIGURED, never HEALTHY', async () => {
    env.QUEUE_PROVIDER = 'memory';
    const report = await healthBody();
    const queue = report.checks.find((c) => c.id === 'queue')!;
    expect(queue.status).toBe('NOT_CONFIGURED');
    expect(queue.status).not.toBe('HEALTHY');
  });
});

describe('FAILURE CATEGORY 11 — outbox / queue depth honest reporting', () => {
  it('diagnostics report queue depth from persisted tables even when they are empty', async () => {
    db.state.resolve = (text) => {
      if (text.includes('task_dlq')) return [{ n: 0 }];
      if (text.includes('outbox_events')) return [{ n: 0 }];
      return null;
    };
    const { diagnosticsReport } = await import('../modules/operations/diagnostics.js');
    const report = await diagnosticsReport();
    expect(report.queue.dlqDepth).toBe(0);
    expect(report.queue.outboxPending).toBe(0);
    expect(JSON.stringify(report)).not.toContain('undefined');
  });
});