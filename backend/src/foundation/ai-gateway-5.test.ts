/**
 * CodeConClave — Phase 5 AI Gateway foundation tests.
 * Covers: registry load (enabled/deprecation filter + provider health overlay),
 * privacy + latency + capability routing, compute governance (A/B/C classes,
 * premium budget gate, qualified-cheaper fallback, policy-config budget),
 * provider failure classification + honest fallback chain, streaming (partial,
 * completion, cancellation, timeout), typed tool-call normalization feeding the
 * deterministic policy engine, and the chat pipeline end-to-end through the
 * gateway. DB + registry + provider adapters are mocked; no provider is hit,
 * no token streaming is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
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

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const workspace = vi.hoisted(() => ({
  checkFreeLimits: vi.fn(async () => ({ ok: true, reason: null, limits: {} })),
  consumeFreeMessage: vi.fn(async () => ({
    accepted: true,
    usage: { used: 0, limit: 20, windowHours: 24, windowStart: null, resetsAt: null, remaining: 20 },
  })),
  incrementUsage: vi.fn(async () => {}),
  shouldShowFreeLimitMoon: vi.fn(async () => false),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('../modules/workspace/service.js', () => workspace);

const memory = vi.hoisted(() => ({
  retrieveMemoriesForPrompt: vi.fn(async () => [] as string[]),
  extractEpisodicMemory: vi.fn(async () => {}),
}));
vi.mock('../modules/memory/service.js', () => memory);

const context = vi.hoisted(() => ({
  retrieveScopedContext: vi.fn(async () => ({
    memories: [] as string[],
    dna: [] as string[],
    decisions: [] as string[],
  })),
}));
vi.mock('../modules/memory/context.js', () => context);

const registry = vi.hoisted(() => ({
  getRegistry: vi.fn(async () => [] as unknown[]),
  configuredProviders: vi.fn(() => ['openai', 'anthropic']),
  getModel: vi.fn(async () => {
    throw new Error('not used in these tests');
  }),
}));
const registryReal = vi.hoisted(() => ({
  getRegistry: null as null | ((force?: boolean) => Promise<unknown[]>),
  configuredProviders: null as null | (() => string[]),
}));
vi.mock('../modules/ai/registry.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/ai/registry.js')>();
  registryReal.getRegistry = mod.getRegistry;
  registryReal.configuredProviders = mod.configuredProviders;
  return {
    ...mod,
    getRegistry: registry.getRegistry,
    configuredProviders: registry.configuredProviders,
    getModel: registry.getModel,
  };
});

const providers = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  updateProviderHealth: vi.fn(async () => {}),
}));
vi.mock('../modules/ai/providers.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/ai/providers.js')>();
  return { ...mod, getAdapter: providers.getAdapter, updateProviderHealth: providers.updateProviderHealth };
});

import {
  routeModels,
  completeWithFallback,
  estimateCost,
  requestToolCall,
  parseToolRequest,
  getComputePolicy,
  premiumBudgetRemaining,
  type GatewayContext,
  type ToolSchema,
} from '../modules/ai/gateway.js';
import { sendChatMessage } from '../modules/conversations/chat.js';
import { evaluateToolCall, registerGrants, revokeGrants } from '../modules/execution/policy.js';
import { AppError } from '../shared/errors.js';
import type { AiModelDescriptor } from '@codeconclave/shared';
import type { ProviderAdapter } from '../modules/ai/providers.js';

function model(id: string, overrides: Partial<AiModelDescriptor> = {}): AiModelDescriptor {
  return {
    modelId: id,
    providerId: 'openai',
    displayName: id,
    tier: 'EFFICIENT',
    computeClass: 'B',
    contextWindow: 64_000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    inputCostPerM: 0.5,
    outputCostPerM: 1.5,
    entitlement: 'FREE',
    privacyClass: 'STANDARD',
    targetLatencyMs: 1500,
    health: 'UP',
    priority: 100,
    fallbackList: [],
    enabled: true,
    effectiveDate: '2025-01-01',
    deprecationDate: null,
    ...overrides,
  };
}

function adapter(modelId: string, overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    providerId: 'openai',
    modelId,
    supportsToolCalls: true,
    async *complete() {
      yield { delta: `reply-${modelId}`, inputTokens: 10, outputTokens: 5 };
    },
    ...overrides,
  };
}

function mockPlan(plan: 'free' | 'pro') {
  db.state.resolve = (text) => (text.includes('SELECT plan_id FROM users') ? [{ plan_id: plan }] : null);
}

function budgetSpent(usd: number) {
  const prev = db.state.resolve;
  db.state.resolve = (text) => {
    if (text.includes('COALESCE(SUM(estimated_cost_usd)')) return [{ spent: String(usd) }];
    return prev ? prev(text) : null;
  };
}

const ctx = (planId: 'free' | 'pro' = 'pro'): GatewayContext => ({
  userId: 'u1',
  sessionId: 's1',
  conversationId: 'c1',
  planId,
});

function usageRows(): { text: string; params: unknown[] }[] {
  return db.state.calls.filter((c) => c.text.includes('INSERT INTO model_usage_logs'));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  vi.mocked(registry.getRegistry).mockReset();
  vi.mocked(registry.configuredProviders).mockReset();
  vi.mocked(registry.configuredProviders).mockReturnValue(['openai', 'anthropic']);
  vi.mocked(providers.getAdapter).mockReset();
  vi.mocked(providers.updateProviderHealth).mockReset();
  vi.mocked(providers.updateProviderHealth).mockResolvedValue(undefined);
  vi.mocked(workspace.incrementUsage).mockClear();
  vi.mocked(workspace.recordUsage).mockClear();
  vi.mocked(workspace.checkFreeLimits).mockClear();
  vi.mocked(memory.retrieveMemoriesForPrompt).mockClear();
  vi.mocked(memory.extractEpisodicMemory).mockClear();
  vi.mocked(context.retrieveScopedContext).mockClear();
  vi.mocked(recordAudit).mockClear();
  revokeGrants('u1');
});

afterEach(() => {
  registry.getRegistry.mockReset();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- REGISTRY

describe('model registry — server-authoritative load', () => {
  it('excludes disabled and deprecated models, maps provider health', async () => {
    const real = registryReal.getRegistry!;
    db.state.resolve = (text) => {
      if (text.includes('FROM ai_model_registry')) {
        return [
          { model_id: 'active-1', provider_id: 'openai', display_name: 'Active', tier: 'EFFICIENT', compute_class: 'A', context_window: 64000, supports_vision: false, supports_tools: true, supports_function_calling: true, input_cost_per_m: '0.5', output_cost_per_m: '1.5', entitlement: 'FREE', privacy_class: 'STANDARD', target_latency_ms: 1500, health: 'UNKNOWN', priority: 1, fallback_list: [], enabled: true, effective_date: '2025-01-01', deprecation_date: null },
          { model_id: 'disabled-1', provider_id: 'openai', display_name: 'Disabled', tier: 'EFFICIENT', compute_class: 'A', context_window: 64000, supports_vision: false, supports_tools: true, supports_function_calling: true, input_cost_per_m: '0.5', output_cost_per_m: '1.5', entitlement: 'FREE', privacy_class: 'STANDARD', target_latency_ms: 1500, health: 'UNKNOWN', priority: 2, fallback_list: [], enabled: false, effective_date: '2025-01-01', deprecation_date: null },
          { model_id: 'deprecated-1', provider_id: 'anthropic', display_name: 'Deprecated', tier: 'EFFICIENT', compute_class: 'A', context_window: 64000, supports_vision: false, supports_tools: true, supports_function_calling: true, input_cost_per_m: '0.5', output_cost_per_m: '1.5', entitlement: 'FREE', privacy_class: 'STANDARD', target_latency_ms: 1500, health: 'UNKNOWN', priority: 3, fallback_list: [], enabled: true, effective_date: '2020-01-01', deprecation_date: '2020-01-02' },
        ]
          .filter((r) => r.enabled && (r.deprecation_date === null || new Date(r.deprecation_date) > new Date()));
      }
      if (text.includes('FROM provider_health')) {
        return [{ provider_id: 'openai', state: 'HEALTHY' }, { provider_id: 'anthropic', state: 'DOWN' }];
      }
      return null;
    };
    const list = (await real(true)) as AiModelDescriptor[];
    expect(list.map((m) => m.modelId)).toEqual(['active-1']);
    expect(list[0].health).toBe('HEALTHY');
  });

  it('falls back to UNKNOWN health when no health row exists', async () => {
    const real = registryReal.getRegistry!;
    db.state.resolve = (text) => {
      if (text.includes('FROM ai_model_registry')) {
        return [{ model_id: 'm1', provider_id: 'openai', display_name: 'M', tier: 'EFFICIENT', compute_class: 'A', context_window: 64000, supports_vision: false, supports_tools: true, supports_function_calling: true, input_cost_per_m: '0.5', output_cost_per_m: '1.5', entitlement: 'FREE', privacy_class: 'STANDARD', target_latency_ms: 1500, health: 'UNKNOWN', priority: 1, fallback_list: [], enabled: true, effective_date: '2025-01-01', deprecation_date: null }];
      }
      if (text.includes('FROM provider_health')) return [];
      return null;
    };
    const list = (await real(true)) as AiModelDescriptor[];
    expect(list[0].health).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------- ROUTING

describe('routeModels — privacy, latency, compute governance', () => {
  beforeEach(() => {
    mockPlan('pro');
  });

  it('filters by privacy class: STRICT requests only reach STRICT models', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('public-1', { privacyClass: 'PUBLIC', priority: 1 }),
      model('standard-1', { privacyClass: 'STANDARD', priority: 2 }),
      model('strict-1', { privacyClass: 'STRICT', priority: 3 }),
    ]);
    let selection = await routeModels('u1', { privacyClass: 'STRICT' });
    expect(selection.primary.modelId).toBe('strict-1');

    selection = await routeModels('u1', { privacyClass: 'STANDARD' });
    expect(['standard-1', 'strict-1']).toContain(selection.primary.modelId);
    expect(selection.primary.modelId).not.toBe('public-1');
  });

  it('filters by latency requirement: never routes to a model exceeding maxLatencyMs', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('slow-1', { targetLatencyMs: 4000, priority: 1 }),
      model('fast-1', { targetLatencyMs: 800, priority: 2 }),
    ]);
    const selection = await routeModels('u1', { maxLatencyMs: 1000 });
    expect(selection.primary.modelId).toBe('fast-1');
  });

  it('chooses the cheapest qualified model when priority ties', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('pricey-1', { inputCostPerM: 30, outputCostPerM: 90, priority: 50 }),
      model('cheap-1', { inputCostPerM: 0.25, outputCostPerM: 0.75, priority: 50 }),
    ]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('cheap-1');
  });

  it('class A work is capped at EFFICIENT tier (compute policy)', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('capable-1', { tier: 'CAPABLE', computeClass: 'B', priority: 1 }),
      model('efficient-1', { tier: 'EFFICIENT', computeClass: 'A', priority: 2 }),
    ]);
    const selection = await routeModels('u1', { computeClass: 'A' });
    expect(selection.primary.modelId).toBe('efficient-1');
  });

  it('excludePremium never selects a premium model', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('prem-1', { tier: 'PREMIUM', computeClass: 'C', priority: 1 }),
      model('cap-1', { tier: 'CAPABLE', computeClass: 'B', priority: 2 }),
    ]);
    const selection = await routeModels('u1', { excludePremium: true });
    expect(selection.primary.modelId).toBe('cap-1');
  });

  it('PRO entitlement is enforced: free plan never reaches PRO models', async () => {
    mockPlan('free');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('prem-1', { tier: 'PREMIUM', computeClass: 'C', entitlement: 'PRO', priority: 1 }),
      model('eff-1', { tier: 'EFFICIENT', computeClass: 'A', priority: 2 }),
    ]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('eff-1');
  });

  it('produces distinct primary/fallback/tertiary and honest collapse', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('m1', { priority: 1 }),
      model('m2', { priority: 2 }),
      model('m3', { priority: 3 }),
    ]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('m1');
    expect(selection.fallback.modelId).toBe('m2');
    expect(selection.tertiary.modelId).toBe('m3');
  });
});

// ---------------------------------------------------------------- COMPUTE

describe('compute governance — premium gate + cheaper fallback', () => {
  beforeEach(() => {
    mockPlan('pro');
  });

  const premiumSet = () => [
    model('prem-1', { tier: 'PREMIUM', computeClass: 'C', priority: 1 }),
    model('cap-1', { tier: 'CAPABLE', computeClass: 'B', priority: 2 }),
  ];

  it('premium request with budget executes on the premium model', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'C' },
    });
    expect(summary.modelId).toBe('prem-1');
    expect(summary.usedFallback).toBe(false);
    expect(summary.fallbackReason).toBeNull();
    const usage = usageRows();
    expect(usage[0].params[17]).toBeNull();
  });

  it('premium request with exhausted budget falls back to a qualified cheaper model', async () => {
    budgetSpent(5);
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'C' },
    });
    expect(summary.modelId).toBe('cap-1');
    expect(summary.usedFallback).toBe(true);
    expect(summary.fallbackReason).toBe('premium_compute_denied');
    const usage = usageRows();
    expect(usage[0].params[17]).toBe('premium_compute_denied');
  });

  it('free plan premium request falls back on entitlement mismatch', async () => {
    mockPlan('free');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('prem-1', { tier: 'PREMIUM', computeClass: 'C', entitlement: 'PRO', priority: 1 }),
      model('eff-1', { tier: 'EFFICIENT', computeClass: 'A', priority: 2 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('free'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'C' },
    });
    expect(summary.modelId).toBe('eff-1');
    expect(summary.fallbackReason).toBe('entitlement_mismatch');
  });

  it('free plan premium request without a cheaper path explains the requirement', async () => {
    mockPlan('free');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('prem-1', { tier: 'PREMIUM', computeClass: 'C', entitlement: 'PRO', priority: 1 }),
    ]);
    await expect(
      completeWithFallback({
        ctx: ctx('free'),
        messages: [{ role: 'user', content: 'hello' }],
        opts: { computeClass: 'C' },
      }),
    ).rejects.toMatchObject({ errorCode: 'premium_compute_denied' });
  });

  it('class B default never silently spends premium compute when budget is exhausted', async () => {
    budgetSpent(5);
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'B' },
    });
    expect(summary.modelId).toBe('cap-1');
    expect(summary.fallbackReason).toBe('premium_compute_denied');
  });

  it('class B default never silently spends premium compute', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'B' },
    });
    expect(summary.modelId).toBe('cap-1');
    expect(summary.fallbackReason).toBe('premium_compute_denied');
  });

  it('an explicit premium pick with budget executes on the premium model', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'B', requestedModelId: 'prem-1' },
    });
    expect(summary.modelId).toBe('prem-1');
    expect(summary.usedFallback).toBe(false);
    expect(summary.fallbackReason).toBeNull();
  });

  it('an explicit premium pick with exhausted budget downgrades honestly', async () => {
    budgetSpent(5);
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'B', requestedModelId: 'prem-1' },
    });
    expect(summary.modelId).toBe('cap-1');
    expect(summary.fallbackReason).toBe('premium_compute_denied');
  });

  it('honors compute_policy config: zero-budget policy denies premium compute', async () => {
    const prev = db.state.resolve;
    db.state.resolve = (text) => {
      if (text.includes('FROM compute_policy')) {
        return [{ class: 'C', description: 'test', max_tier: 'PREMIUM', premium_budget_usd_per_day: '0', enabled: true }];
      }
      return prev ? prev(text) : null;
    };
    vi.mocked(registry.getRegistry).mockResolvedValue(premiumSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hello' }],
      opts: { computeClass: 'C' },
    });
    expect(summary.modelId).toBe('cap-1');
    expect(summary.fallbackReason).toBe('premium_compute_denied');
  });

  it('getComputePolicy falls back to defaults when the table is empty', async () => {
    const policy = await getComputePolicy('C');
    expect(policy.maxTier).toBe('PREMIUM');
    expect(policy.premiumBudgetUsdPerDay).toBeGreaterThan(0);
    const policyA = await getComputePolicy('A');
    expect(policyA.maxTier).toBe('EFFICIENT');
  });

  it('premiumBudgetRemaining computes remaining against the cap', async () => {
    budgetSpent(1.5);
    expect(await premiumBudgetRemaining('u1')).toBeCloseTo(2.5, 5);
    budgetSpent(9);
    expect(await premiumBudgetRemaining('u1')).toBe(0);
  });
});

// ---------------------------------------------------------------- PROVIDERS

describe('completeWithFallback — failure classification + honest fallback', () => {
  beforeEach(() => {
    mockPlan('pro');
  });

  const singleSet = (overrides: Partial<AiModelDescriptor> = {}) => [
    model('only-1', { priority: 1, ...overrides }),
  ];

  it('streams the primary completion and logs usage metadata', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue(singleSet());
    const chunks: string[] = [];
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId, async *complete() {
        yield { delta: 'Hello', inputTokens: 4, outputTokens: 1 };
        yield { delta: ' world', inputTokens: 4, outputTokens: 2 };
      } }),
    );
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (c) => void chunks.push(c.delta),
    });
    expect(summary.text).toBe('Hello world');
    expect(chunks).toEqual(['Hello', ' world']);
    expect(summary.modelId).toBe('only-1');
    expect(summary.usedFallback).toBe(false);
    expect(vi.mocked(providers.updateProviderHealth)).toHaveBeenCalledWith('openai', true, expect.any(Number));
    const usage = usageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0].params[1]).toBe('u1');
    expect(usage[0].params[8]).toBe('pro');
  });

  it('falls back to the next model when the primary fails, recording the reason', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('bad-1', { priority: 1, providerId: 'anthropic' }),
      model('good-1', { priority: 2 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) => {
      if (modelId === 'bad-1') {
        return adapter(modelId, {
          providerId,
          async *complete() {
            throw new Error('connection reset');
          },
        });
      }
      return adapter(modelId, { providerId });
    });
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(summary.modelId).toBe('good-1');
    expect(summary.usedFallback).toBe(true);
    expect(summary.fallbackReason).toBe('provider_unavailable');
    const usage = usageRows();
    expect(usage[0].params[17]).toBe('provider_unavailable');
    expect(vi.mocked(providers.updateProviderHealth)).toHaveBeenCalledWith('anthropic', false, expect.any(Number), 'connection reset');
  });

  it('classifies provider rate limits as rate_limited', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('rl-1', { priority: 1, providerId: 'openai' }),
      model('ok-1', { priority: 2, providerId: 'anthropic' }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) => {
      if (modelId === 'rl-1') {
        return adapter(modelId, {
          providerId,
          async *complete() {
            throw AppError.tooMany('rate_limited', 'RPM exceeded');
          },
        });
      }
      return adapter(modelId, { providerId });
    });
    const summary = await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(summary.modelId).toBe('ok-1');
    expect(summary.fallbackReason).toBe('rate_limited');
  });

  it('skips unconfigured providers and reports an honest failure when all attempts fail', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue(singleSet());
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        async *complete() {
          throw new Error('network down');
        },
      }),
    );
    await expect(
      completeWithFallback({ ctx: ctx('pro'), messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ errorCode: 'model_unavailable' });
    const usage = usageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0].params[17]).toBe('provider_unavailable');
  });
});

// ---------------------------------------------------------------- STREAMING

describe('streaming — partial, cancellation, timeout', () => {
  beforeEach(() => {
    mockPlan('pro');
  });

  it('propagates partial deltas to the caller before completion', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([model('s1', { priority: 1 })]);
    const seen: string[] = [];
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        async *complete() {
          yield { delta: 'a', inputTokens: 1, outputTokens: 0 };
          yield { delta: 'b', inputTokens: 1, outputTokens: 1 };
        },
      }),
    );
    await completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (c) => void seen.push(c.delta),
    });
    expect(seen).toEqual(['a', 'b']);
  });

  it('user cancellation stops immediately and never falls back', async () => {
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('primary-1', { priority: 1 }),
      model('backup-1', { priority: 2 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        async *complete(_req, signal) {
          yield { delta: 'partial', inputTokens: 1, outputTokens: 1 };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      }),
    );
    const controller = new AbortController();
    const promise = completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({ errorCode: 'stream_interrupted' });
    expect(vi.mocked(providers.getAdapter)).toHaveBeenCalledTimes(1);
  });

  it('attempt timeout is classified as timeout and continues down the chain', async () => {
    vi.useFakeTimers();
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('slow-1', { priority: 1 }),
      model('fast-1', { priority: 2 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) => {
      if (modelId === 'fast-1') return adapter(modelId, { providerId });
      return adapter(modelId, {
        providerId,
        async *complete(_req, signal) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      });
    });
    const promise = completeWithFallback({
      ctx: ctx('pro'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await vi.advanceTimersByTimeAsync(121_000);
    const summary = await promise;
    expect(summary.modelId).toBe('fast-1');
    expect(summary.fallbackReason).toBe('timeout');
    expect(vi.mocked(providers.updateProviderHealth)).toHaveBeenCalledWith('openai', false, expect.any(Number), 'aborted');
  });
});

// ---------------------------------------------------------------- TOOLS

describe('typed tool-call normalization + policy gate', () => {
  it('parseToolRequest produces a typed request from model output', () => {
    const request = parseToolRequest('{"tool":"file_read","input":{"path":"repo/src/main.ts"}}', ['file_read', 'file_write']);
    expect(request.tool).toBe('file_read');
    expect(request.input).toEqual({ path: 'repo/src/main.ts' });
  });

  it('parseToolRequest rejects non-JSON, disallowed tools and non-object input', () => {
    expect(() => parseToolRequest('not json', ['file_read'])).toThrow();
    expect(() => parseToolRequest('{"tool":"rm_rf","input":{}}', ['file_read'])).toThrow();
    expect(() => parseToolRequest('{"tool":"file_read","input":"nope"}', ['file_read'])).toThrow();
  });

  it('requestToolCall routes to an adapter with function-calling support', async () => {
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('no-adapter-fc-1', { priority: 1, providerId: 'anthropic' }),
      model('fc-1', { priority: 2, providerId: 'openai' }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        supportsToolCalls: modelId === 'fc-1',
        async *complete() {
          yield { delta: '{"tool":"file_read","input":{"path":"repo/src/main.ts"}}', inputTokens: 5, outputTokens: 5 };
        },
      }),
    );
    const schema: ToolSchema = { tool: 'file_read', description: 'Read a file' };
    const result = await requestToolCall(ctx('pro'), { schema, messages: [{ role: 'user', content: 'read main.ts' }] });
    expect(result.modelId).toBe('fc-1');
    expect(result.usedFallback).toBe(true);
    expect(result.request.tool).toBe('file_read');
    expect(result.request.input).toEqual({ path: 'repo/src/main.ts' });
  });

  it('reports unsupported_feature when no configured model supports typed calls', async () => {
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('registry-fc-1', { priority: 1, providerId: 'anthropic' }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, { providerId, supportsToolCalls: false }),
    );
    await expect(
      requestToolCall(ctx('pro'), {
        schema: { tool: 'file_read' },
        messages: [{ role: 'user', content: 'read' }],
      }),
    ).rejects.toMatchObject({ errorCode: 'unsupported_feature' });
  });

  it('typed requests pass through the deterministic policy engine (grant → allow, secret path → deny)', () => {
    registerGrants([
      {
        id: 'g1',
        userId: 'u1',
        capability: 'READ_WORKSPACE',
        scope: 'repo/src',
        expiresAt: Date.now() + 3600_000,
      },
    ]);
    const typed = parseToolRequest('{"tool":"file_read","input":{"path":"repo/src/main.ts"}}', ['file_read']);
    const decision = evaluateToolCall({ tool: typed.tool, input: typed.input, userId: 'u1' });
    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe('LOW');

    const denied = evaluateToolCall({ tool: typed.tool, input: { path: 'repo/.env' }, userId: 'u1' });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.deniedBy).toBe('baseline_secrets');
  });
});

// ---------------------------------------------------------------- CHAT

describe('chat pipeline — end-to-end through the gateway', () => {
  beforeEach(() => {
    mockPlan('pro');
  });

  const convRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'c1',
    project_id: 'p1',
    owner_id: 'u1',
    title: 'Chat',
    mode: 'CHAT',
    archived: false,
    is_favorite: false,
    tags: [],
    sharing: {},
    search_metadata: { title: 'Chat' },
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  });

  const msgRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'm1',
    conversation_id: 'c1',
    seq: 1,
    sender: 'USER',
    coworker_type: null,
    role: 'user',
    content: 'hello',
    model_id: null,
    provider_id: null,
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
    status: 'COMPLETED',
    error_code: null,
    edited_at: null,
    edit_count: 0,
    thread_id: null,
    created_at: new Date(),
    deleted_at: null,
    ...overrides,
  });

  const dbState = () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM conversations')) return [convRow()];
      if (text.includes('SELECT * FROM messages')) return [msgRow()];
      if (text.includes('SELECT 1 FROM projects')) return [{ id: 'p1' }];
      return null;
    };
  };

  it('routes the request, streams deltas, persists messages and records usage', async () => {
    dbState();
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('eff-1', { tier: 'EFFICIENT', computeClass: 'A', priority: 1 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        async *complete() {
          yield { delta: 'Hi ', inputTokens: 4, outputTokens: 1 };
          yield { delta: 'there', inputTokens: 4, outputTokens: 2 };
        },
      }),
    );
    const deltas: string[] = [];
    const result = await sendChatMessage(
      { id: 'u1', planId: 'pro', entitlementState: 'PRO_VERIFIED' },
      's1',
      {
        content: 'hello',
        conversationId: 'c1',
        projectId: 'p1',
        mode: 'CHAT',
      },
      { onDelta: (d) => void deltas.push(d) },
    );
    expect(result.intent).toBe('fast');
    expect(result.assistant).toBe('Hi there');
    expect(deltas).toEqual(['Hi ', 'there']);
    expect(result.modelId).toBe('eff-1');
    expect(result.costUsd).toBeGreaterThan(0);
    const messageInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO messages'));
    expect(messageInserts.length).toBeGreaterThanOrEqual(2);
    const updates = db.state.calls.filter((c) => c.text.includes('UPDATE messages SET'));
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain('model_id');
    expect(updates[0].text).toContain('input_tokens');
    expect(vi.mocked(workspace.recordUsage).mock.calls.some((call) => call[1] === 'ai_output_tokens')).toBe(true);
    const usage = usageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0].params[9]).toBe('B');
    expect(vi.mocked(memory.extractEpisodicMemory)).toHaveBeenCalled();
  });

  it('marks the assistant message FAILED and rethrows when the gateway fails', async () => {
    dbState();
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('eff-1', { tier: 'EFFICIENT', computeClass: 'A', priority: 1 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        async *complete() {
          throw new Error('boom');
        },
      }),
    );
    await expect(
      sendChatMessage(
        { id: 'u1', planId: 'pro', entitlementState: 'PRO_VERIFIED' },
        's1',
        { content: 'hello', conversationId: 'c1', mode: 'CHAT' },
      ),
    ).rejects.toMatchObject({ errorCode: 'model_unavailable' });
    const updates = db.state.calls.filter((c) => c.text.includes('UPDATE messages SET'));
    expect(updates[0].params[1]).toBe('FAILED');
    expect(updates[0].params[3]).toBe('model_unavailable');
    expect(vi.mocked(recordAudit).mock.calls.some((call) => call[0].action === 'chat.failed')).toBe(true);
  });

  it('free limit enforcement happens before any AI spend', async () => {
    mockPlan('free');
    vi.mocked(workspace.consumeFreeMessage).mockResolvedValue({
      accepted: false,
      usage: { used: 20, limit: 20, windowHours: 24, windowStart: null, resetsAt: null, remaining: 0 },
    });
    vi.mocked(workspace.shouldShowFreeLimitMoon).mockResolvedValue(true);
    let limitEvent = false;
    await expect(
      sendChatMessage(
        { id: 'u1', planId: 'free', entitlementState: 'FREE' },
        's1',
        { content: 'hello', mode: 'CHAT' },
        { onLimitReached: () => void (limitEvent = true) },
      ),
    ).rejects.toMatchObject({ errorCode: 'free_limit_reached' });
    expect(limitEvent).toBe(true);
    expect(usageRows()).toHaveLength(0);
  });

  it('IMAGE_GENERATION: billing/quota exhaustion is surfaced honestly, never faked as an image', async () => {
    dbState();
    // Only an image-generation-capable model exists; it is quota-exhausted the
    // way gemini currently is (429 billing). The gate must fail the message and
    // rethrow the honest error — no fallback to a text model, no fake image.
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('img-1', { imageGeneration: true, priority: 1 }),
    ]);
    vi.mocked(providers.getAdapter).mockImplementation((providerId, modelId) =>
      adapter(modelId, {
        providerId,
        async *complete() {
          throw AppError.unavailable('provider_billing', 'Gemini billing quota exhausted (429)', {
            status: 429,
            provider: 'google',
          });
        },
      }),
    );
    await expect(
      sendChatMessage(
        { id: 'u1', planId: 'pro', entitlementState: 'PRO_VERIFIED' },
        's1',
        { content: 'generate an image of a rocket', conversationId: 'c1', projectId: 'p1', imageRequest: true },
      ),
    ).rejects.toMatchObject({ errorCode: 'model_unavailable' });
    // The assistant message is marked FAILED with the honest error code (the
    // error the SSE route turns into an `event: error` frame the UI renders).
    const updates = db.state.calls.filter((c) => c.text.includes('UPDATE messages SET'));
    expect(updates[0].params[1]).toBe('FAILED');
    expect(updates[0].params[3]).toBe('model_unavailable');
    // Audit facts full + honest: failure recorded against IMAGE_GENERATION.
    expect(vi.mocked(recordAudit).mock.calls.some((call) => call[0].action === 'ai.image_generation_failed')).toBe(true);
    // No image file was persisted (no onImage artifact — nothing faked).
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO files') && c.text.includes('image'))).toBe(false);
  });
});

describe('estimateCost — deterministic math', () => {
  it('computes USD from per-million token prices', () => {
    const m = model('m', { inputCostPerM: 10, outputCostPerM: 30 });
    expect(estimateCost(m, 1_000_000, 0)).toBe(10);
    expect(estimateCost(m, 0, 1_000_000)).toBe(30);
  });
});