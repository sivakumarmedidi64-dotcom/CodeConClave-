/**
 * Regression cover for the production execution failures observed live on
 * 2026-10-05 against commit a511de2, where one transient provider 429 took the
 * whole pipeline down for ~10 minutes and a free-plan (TEMPORARY_DEMO_MODE)
 * account could never persist a real deliverable.
 *
 * 1. gateway.routeModels pinned a transient QUOTA_EXHAUSTED provider verdict for
 *    the whole registry cache window (AI_MODEL_REFRESH_MINUTES), so the
 *    HEALTH_RETRY_COOLDOWN_MS staleness rule could never re-apply and every
 *    retry hard-failed with "No model currently satisfies the request".
 * 2. verifyCoworkerRun requested computeClass 'C' (PREMIUM, entitlement-gated),
 *    so a free-plan account could never obtain a verifier and every run was
 *    silently recorded SKIPPED.
 * 3. health.aiCheck tallied only DOWN/DEGRADED/UNKNOWN, so QUOTA_EXHAUSTED and
 *    BLOCKED matched no branch and /health reported HEALTHY with reason null
 *    while zero models were eligible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const db = vi.hoisted(() => {
  const state = { rows: [] as unknown[], pingOk: true, setResolver: (fn: ((text: string) => unknown[]) | null) => { (state as unknown as { resolver: unknown }).resolver = fn; } };
  const query = async (text: string) => {
    const resolver = (state as unknown as { resolver?: (t: string) => unknown[] }).resolver;
    const rows = resolver ? resolver(text) : [];
    return { rows };
  };
  return {
    state,
    pool: { query },
    queryMany: query,
    ping: async () => state.pingOk,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const cacheMock = vi.hoisted(() => ({
  del: vi.fn(async () => 1),
  get: vi.fn(async (_k: string) => null),
  set: vi.fn(async () => undefined),
  health: vi.fn(async () => true),
  kind: 'redis',
}));
vi.mock('../shared/cache.js', () => ({ cache: cacheMock }));
vi.mock('../workers/watchdog.js', () => ({ lastWatchdogRunAt: () => new Date() }));
vi.mock('../modules/agent/ws.js', () => ({ hubAttached: () => false, agentWs: { broadcast: () => undefined } }));
vi.mock('../modules/plugins/health.js', () => ({ listConnections: async () => [], sweepPluginHealth: async () => 0 }));

const providerMock = vi.hoisted(() => ({
  providers: ['google'] as string[],
  configuredProviders: () => providerMock.providers,
  runProviderCompletion: vi.fn(),
  updateProviderHealth: vi.fn(async () => undefined),
  providerErrorMessage: vi.fn(() => 'provider error'),
  isRateLimitError: vi.fn(() => false),
  HEALTH_RETRY_COOLDOWN_MS: 60_000,
}));
vi.mock('../modules/ai/providers.js', () => providerMock);

type RegistryRow = Record<string, unknown>;
function modelRow(over: RegistryRow = {}): RegistryRow {
  return {
    model_id: 'gemini-2.5-flash',
    provider_id: 'google',
    display_name: 'Gemini Flash',
    tier: 'EFFICIENT',
    compute_class: 'B',
    context_window: 1_000_000,
    supports_vision: false,
    supports_tools: true,
    supports_function_calling: true,
    input_cost_per_m: '0',
    output_cost_per_m: '0',
    entitlement: 'free',
    privacy_class: 'BUSINESS',
    target_latency_ms: 800,
    health: 'HEALTHY',
    priority: 1,
    fallback_list: [],
    enabled: true,
    effective_date: '2024-01-01',
    deprecation_date: null,
    coding_optimized: true,
    capability_category: null,
    image_generation: false,
    image_editing: false,
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  cacheMock.del.mockClear();
  cacheMock.get.mockClear();
  cacheMock.set.mockClear();
  db.state.setResolver(null);
  providerMock.providers = ['google'];
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  vi.doUnmock('../modules/ai/providers.js');
});

describe('production regression 1 — a transient quota verdict must not pin routing for the cache window', () => {
  it('maps a fresh QUOTA_EXHAUSTED verdict to DOWN so the router excludes it', async () => {
    db.state.setResolver((t) =>
      t.includes('ai_model_registry')
        ? [modelRow()]
        : t.includes('provider_health')
          ? [{ provider_id: 'google', state: 'QUOTA_EXHAUSTED', last_check_at: new Date() }]
          : [],
    );
    const { getRegistry } = await import('../modules/ai/registry.js');
    const reg = await getRegistry(true);
    expect(reg[0]!.health).toBe('DOWN');
  });

  it('makes the same verdict retryable once HEALTH_RETRY_COOLDOWN_MS has elapsed', async () => {
    db.state.setResolver((t) =>
      t.includes('ai_model_registry')
        ? [modelRow()]
        : t.includes('provider_health')
          ? [{ provider_id: 'google', state: 'QUOTA_EXHAUSTED', last_check_at: new Date(Date.now() - 61_000) }]
          : [],
    );
    const { getRegistry } = await import('../modules/ai/registry.js');
    const reg = await getRegistry(true);
    expect(reg[0]!.health).not.toBe('DOWN');
  });

  it('routeModels drops the cached snapshot when nothing is eligible, so the next attempt re-reads live health', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let providerReads = 0;
    db.state.setResolver((t) => {
      if (t.includes('ai_model_registry')) return [modelRow()];
      if (t.includes('provider_health')) {
        providerReads += 1;
        // First load: quota-exhausted (the transient 429). Later reads recover.
        return providerReads === 1
          ? [{ provider_id: 'google', state: 'QUOTA_EXHAUSTED', last_check_at: new Date() }]
          : [{ provider_id: 'google', state: 'HEALTHY', last_check_at: new Date() }];
      }
      if (t.includes('FROM users')) return [{ plan_id: 'free' }];
      return [];
    });
    const { routeModels } = await import('../modules/ai/gateway.js');
    await expect(routeModels('usr_1', { computeClass: 'B' } as never)).rejects.toThrow(
      /No model currently satisfies/i,
    );
    expect(cacheMock.del).toHaveBeenCalledWith('ai:registry');
  });

  it('a recovered provider becomes routable on the very next attempt', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let providerReads = 0;
    db.state.setResolver((t) => {
      if (t.includes('ai_model_registry')) return [modelRow()];
      if (t.includes('provider_health')) {
        providerReads += 1;
        return providerReads === 1
          ? [{ provider_id: 'google', state: 'QUOTA_EXHAUSTED', last_check_at: new Date() }]
          : [{ provider_id: 'google', state: 'HEALTHY', last_check_at: new Date() }];
      }
      if (t.includes('FROM users')) return [{ plan_id: 'free' }];
      return [];
    });
    const { routeModels } = await import('../modules/ai/gateway.js');
    await expect(routeModels('usr_1', { computeClass: 'B' } as never)).rejects.toThrow();
    // Second attempt must succeed rather than repeating the cached dead state.
    const picked = await routeModels('usr_1', { computeClass: 'B' } as never);
    expect(picked.primary.providerId).toBe('google');
  });
});

describe('production regression 3 — health must not report HEALTHY for an unroutable provider', () => {
  async function aiCheck(states: Record<string, string>) {
    // configuredProviders() reads real env keys: `google` <- GEMINI_API_KEY and
    // `nemotron` <- NVIDIA_API_KEY.
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.NVIDIA_API_KEY = 'test-key';
    process.env.AI_PROVIDERS_ENABLED = 'google,nemotron';
    db.state.setResolver((t) => (t.includes('provider_health') ? Object.entries(states).map(([provider_id, state]) => ({ provider_id, state })) : []));
    const { computeHealth } = await import('../health/health.js');
    const health = await computeHealth();
    return health.checks.find((c) => c.id === 'ai')!;
  }

  it('reports DEGRADED for QUOTA_EXHAUSTED instead of a false HEALTHY', async () => {
    const ai = await aiCheck({ google: 'QUOTA_EXHAUSTED', nemotron: 'QUOTA_EXHAUSTED' });
    expect(ai.status).not.toBe('HEALTHY');
    expect(ai.status).toBe('DEGRADED');
    expect(ai.reason).toMatch(/no usable AI provider/i);
  });

  it('reports DEGRADED for BLOCKED rather than HEALTHY', async () => {
    const ai = await aiCheck({ google: 'BLOCKED', nemotron: 'BLOCKED' });
    expect(ai.status).not.toBe('HEALTHY');
  });

  it('reports FAILED when every configured provider is hard-down', async () => {
    const ai = await aiCheck({ google: 'DOWN', nemotron: 'DOWN' });
    expect(ai.status).toBe('FAILED');
    expect(ai.reason).toMatch(/no usable AI provider/i);
  });

  it('stays HEALTHY when one configured provider is usable, so a secondary outage is not fatal', async () => {
    const ai = await aiCheck({ google: 'HEALTHY', nemotron: 'DOWN' });
    expect(ai.status).toBe('HEALTHY');
  });

  it('reports DEGRADED when the only usable provider is quota-limited', async () => {
    const ai = await aiCheck({ google: 'HEALTHY', nemotron: 'QUOTA_EXHAUSTED' });
    expect(ai.status).toBe('DEGRADED');
    expect(ai.reason).toMatch(/quota-limited/i);
  });
});

describe('production regression 2 — the verifier must be reachable for a free-plan account', () => {
  it('requests STANDARD (B) compute, not the entitlement-gated PREMIUM (C) class', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const completeWithFallback = vi.fn(async (opts: Record<string, unknown>) => {
      seen.push(opts);
      return { text: 'PASS', model: 'mock' };
    });
    vi.doMock('../modules/ai/gateway.js', () => ({ completeWithFallback }));
    db.state.setResolver((t) =>
      t.includes('coworker_runs') ? [{ id: 'crw_1', task_id: 'tsk_1', output: { text: '# deliverable' } }] : t.includes('FROM users') ? [{ plan_id: 'free' }] : [],
    );
    const { verifyCoworkerRun } = await import('../modules/execution/coworkers.js');
    const verdict = await verifyCoworkerRun('crw_1', 'has three sections', 'usr_1');

    expect(completeWithFallback).toHaveBeenCalled();
    expect(seen[0]!.opts).toMatchObject({ computeClass: 'B' });
    expect((seen[0]!.opts as { computeClass: string }).computeClass).not.toBe('C');
    expect(verdict).toBe('PASS');
  });
});