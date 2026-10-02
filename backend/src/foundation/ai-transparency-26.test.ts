/**
 * Stage 26 — AI gateway transparency contract suite.
 * Covers: honest provider status derivation (configuration + probe history +
 * classified failures), the persisted status taxonomy (RATE_LIMITED /
 * QUOTA_EXHAUSTED / OFFLINE / REQUIRES_REAUTH / BLOCKED never derived), the
 * provider status snapshot used by /api/v1/ai/providers, and transparency
 * routing details (fallback reason recorded per call). No provider is
 * contacted; DB + registry are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderStatus } from '@codeconclave/shared';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], rows: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const workspace = vi.hoisted(() => ({
  checkFreeLimits: vi.fn(async () => ({ ok: true, reason: null, limits: {} })),
  incrementUsage: vi.fn(async () => {}),
  shouldShowFreeLimitMoon: vi.fn(async () => false),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('../modules/workspace/service.js', () => workspace);

const registry = vi.hoisted(() => ({
  getRegistry: vi.fn(async () => [] as unknown[]),
  configuredProviders: vi.fn(() => ['openai', 'anthropic', 'google', 'mistral', 'grok', 'deepseek', 'kimi', 'nemotron', 'north']),
  getModel: vi.fn(async () => {
    throw new Error('not used');
  }),
}));
vi.mock('../modules/ai/registry.js', () => registry);

import type { AiModelDescriptor, ProviderState } from '@codeconclave/shared';
import { classifyProviderError, deriveStatusFromFailure } from '../modules/ai/providers.js';
import { providerStatusSnapshot } from '../modules/ai/status.js';
import { AppError } from '../shared/errors.js';

const M = (partial: Partial<AiModelDescriptor>): AiModelDescriptor => ({
  modelId: 'm',
  providerId: 'openai',
  displayName: 'M',
  tier: 'EFFICIENT',
  computeClass: 'A',
  contextWindow: 128_000,
  supportsVision: false,
  supportsTools: true,
  supportsFunctionCalling: true,
  inputCostPerM: 0.1,
  outputCostPerM: 0.3,
  entitlement: 'FREE',
  privacyClass: 'STANDARD',
  targetLatencyMs: 2000,
  health: 'HEALTHY' as ProviderState,
  priority: 100,
  fallbackList: [],
  enabled: true,
  effectiveDate: '2026-01-01',
  deprecationDate: null,
  codingOptimized: false,
  ...partial,
});

const HEALTH_ROW = (providerId: string, state: string, lastError: string | null = null) => ({
  provider_id: providerId,
  state,
  last_check_at: '2026-08-19T00:00:00.000Z',
  last_error: lastError,
  success_count: 5,
  failure_count: 1,
  consecutive_failures: state === 'HEALTHY' ? 0 : 2,
  avg_latency_ms: 1200,
});

beforeEach(() => {
  registry.getRegistry.mockReset();
  registry.getRegistry.mockResolvedValue([] as never);
  db.state.rows = [];
  db.state.resolve = null;
});

afterEach(() => {
  db.state.resolve = null;
  db.state.rows = [];
});

describe('PROVIDER STATUS DERIVATION — honest taxonomy', () => {
  it('classifies rate limit failures as RATE_LIMITED', () => {
    expect(deriveStatusFromFailure(AppError.unavailable('rate_limited', 'openai rate limit reached'))).toBe(ProviderStatus.RATE_LIMITED);
    expect(deriveStatusFromFailure('openai rate limit reached (429)')).toBe(ProviderStatus.RATE_LIMITED);
  });

  it('classifies billing/quota failures as QUOTA_EXHAUSTED', () => {
    expect(deriveStatusFromFailure(AppError.unavailable('provider_billing', 'quota exhausted'))).toBe(ProviderStatus.QUOTA_EXHAUSTED);
    expect(deriveStatusFromFailure('insufficient_quota')).toBe(ProviderStatus.QUOTA_EXHAUSTED);
  });

  it('classifies credential failures as REQUIRES_REAUTH', () => {
    expect(deriveStatusFromFailure(AppError.unavailable('invalid_credentials', 'rejected credentials'))).toBe(ProviderStatus.REQUIRES_REAUTH);
    expect(deriveStatusFromFailure('the api key is invalid')).toBe(ProviderStatus.REQUIRES_REAUTH);
  });

  it('classifies timeout and network failures honestly (DEGRADED / OFFLINE)', () => {
    expect(deriveStatusFromFailure(AppError.unavailable('provider_timeout', 'timed out'))).toBe(ProviderStatus.DEGRADED);
    expect(deriveStatusFromFailure(new Error('connection reset'))).toBe(ProviderStatus.OFFLINE);
  });

  it('never derives BLOCKED from failures', () => {
    for (const err of [
      AppError.unavailable('provider_error', '500'),
      new Error('boom'),
      'anything',
      AppError.unavailable('rate_limited', 'rl'),
    ]) {
      expect(deriveStatusFromFailure(err)).not.toBe(ProviderStatus.BLOCKED);
    }
  });

  it('classifies unconfigured providers as NOT_CONFIGURED', () => {
    expect(deriveStatusFromFailure(AppError.unavailable('provider_not_configured', 'not configured'))).toBe(ProviderStatus.NOT_CONFIGURED);
    expect(classifyProviderError(AppError.unavailable('provider_not_configured', 'x'))).toBe('provider_not_configured');
  });
});

describe('PROVIDER STATUS SNAPSHOT — /api/v1/ai/providers data', () => {
  it('reports NOT_CONFIGURED for providers with no key, regardless of stale health rows', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('grok', 'DOWN', 'rate limit reached (429)')];
    const snapshot = await providerStatusSnapshot();
    const grok = snapshot.find((p) => p.providerId === 'grok')!;
    expect(grok.status).toBe(ProviderStatus.NOT_CONFIGURED);
    expect(grok.configured).toBe(false);
  });

  it('reports AVAILABLE for configured providers passing probes', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('openai', 'HEALTHY')];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.AVAILABLE);
    expect(snapshot.find((p) => p.providerId === 'openai')!.label).toContain('Available');
  });

  it('derives RATE_LIMITED from the persisted last error of a DOWN row', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('openai', 'DOWN', 'openai rate limit reached — retry after ~30s')];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.RATE_LIMITED);
  });

  it('preserves a persisted RATE_LIMITED probe verdict instead of collapsing it to DEGRADED', async () => {
    registry.configuredProviders.mockReturnValue(['mistral']);
    db.state.rows = [HEALTH_ROW('mistral', 'RATE_LIMITED', 'mistral rate limit reached — retry after ~30s')];
    const snapshot = await providerStatusSnapshot();
    const mistral = snapshot.find((p) => p.providerId === 'mistral')!;
    expect(mistral.status).toBe(ProviderStatus.RATE_LIMITED);
    expect(mistral.label).toContain('retry later');
  });

  it('preserves a persisted QUOTA_EXHAUSTED probe verdict instead of collapsing it to DEGRADED', async () => {
    registry.configuredProviders.mockReturnValue(['mistral']);
    db.state.rows = [HEALTH_ROW('mistral', 'QUOTA_EXHAUSTED', 'mistral quota exhausted (429)')];
    const snapshot = await providerStatusSnapshot();
    const mistral = snapshot.find((p) => p.providerId === 'mistral')!;
    expect(mistral.status).toBe(ProviderStatus.QUOTA_EXHAUSTED);
    expect(mistral.label).toContain('billing');
  });

  it('derives QUOTA_EXHAUSTED from billing failures', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('openai', 'DOWN', 'billing quota exhausted (429)')];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.QUOTA_EXHAUSTED);
  });

  it('derives REQUIRES_REAUTH from credential failures', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('openai', 'DOWN', 'openai rejected the configured credentials')];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.REQUIRES_REAUTH);
  });

  it('reports CONFIGURED (unprobed) for configured providers with no probe history', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.CONFIGURED);
    expect(snapshot.find((p) => p.providerId === 'openai')!.label).toContain('not yet probed');
  });

  it('honors an explicit BLOCKED health row over any other state', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('openai', 'BLOCKED')];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.BLOCKED);
  });

  it('treats registry DOWN models as OFFLINE before first probe', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    registry.getRegistry.mockResolvedValue([M({ modelId: 'gpt-5.2', providerId: 'openai', health: 'DOWN' as ProviderState })] as never);
    db.state.rows = [];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.OFFLINE);
  });

  it('covers every registered provider with honest labels', async () => {
    registry.configuredProviders.mockReturnValue([]);
    db.state.rows = [];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.map((p) => p.providerId).sort()).toEqual(
      [
        'anthropic',
        'deepseek',
        'devin',
        'gemma',
        'google',
        'grok',
        'kimi',
        'manus',
        'mistral',
        'nemotron',
        'north',
        'openai',
        'ox_alpha',
        'qwen',
        'z_code_5_3',
      ].sort(),
    );
    for (const p of snapshot) {
      expect(p.label).toBeTruthy();
      // Stage 81 provider gate: manus is the only provably-unusable registry
      // provider in this no-health-rows scenario — honestly BLOCKED with the
      // quality-gate reason; every other provider must NOT be blocked.
      if (p.providerId === 'manus') {
        expect(p.status).toBe(ProviderStatus.BLOCKED);
        expect(p.configured).toBe(false);
        expect(p.label).toContain('provider quality gate');
      } else {
        expect(p.status).not.toBe(ProviderStatus.BLOCKED);
      }
    }
  });

  it('derives OFFLINE from a DOWN row without a classifiable message', async () => {
    registry.configuredProviders.mockReturnValue(['openai']);
    db.state.rows = [HEALTH_ROW('openai', 'DOWN', 'ECONNREFUSED')];
    const snapshot = await providerStatusSnapshot();
    expect(snapshot.find((p) => p.providerId === 'openai')!.status).toBe(ProviderStatus.OFFLINE);
  });
});