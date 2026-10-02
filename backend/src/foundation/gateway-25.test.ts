/**
 * Stage 25.5 — AI gateway expansion contract suite.
 * Covers: model discovery (9 providers incl. grok/deepseek/kimi/nemotron/north),
 * coding-optimized routing, reviewer provider exclusion, eligible-model
 * enforcement for agent assignment, honest all-providers-down failure, and the
 * OpenAI-compatible + Cohere adapter construction (no provider is contacted).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

const registry = vi.hoisted(() => ({
  getRegistry: vi.fn(async () => [] as unknown[]),
  configuredProviders: vi.fn(() => ['openai', 'anthropic', 'google', 'mistral', 'grok', 'deepseek', 'kimi', 'nemotron', 'north']),
  getModel: vi.fn(async () => {
    throw new Error('not used');
  }),
}));
vi.mock('../modules/ai/registry.js', () => registry);

const workspace = vi.hoisted(() => ({
  checkFreeLimits: vi.fn(async () => ({ ok: true, reason: null, limits: {} })),
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
  retrieveScopedContext: vi.fn(async () => ({ memories: [] as string[], dna: [] as string[] })),
}));
vi.mock('../modules/memory/context.js', () => context);

import type { AiModelDescriptor, ProviderState } from '@codeconclave/shared';
import { eligibleModels, routeModels } from '../modules/ai/gateway.js';
import { getAdapter, classifyProviderError } from '../modules/ai/providers.js';
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

const REGISTRY: AiModelDescriptor[] = [
  M({ modelId: 'grok-4.3', providerId: 'grok', displayName: 'Grok 4.3', computeClass: 'B', tier: 'CAPABLE', priority: 20, contextWindow: 1_000_000, supportsVision: true }),
  M({ modelId: 'grok-build-0.1', providerId: 'grok', displayName: 'Grok Build', computeClass: 'A', priority: 30, codingOptimized: true }),
  M({ modelId: 'deepseek-v4-pro', providerId: 'deepseek', displayName: 'DeepSeek V4 Pro', computeClass: 'B', tier: 'CAPABLE', priority: 22, codingOptimized: true }),
  M({ modelId: 'deepseek-v4-flash', providerId: 'deepseek', displayName: 'DeepSeek V4 Flash', computeClass: 'A', priority: 40 }),
  M({ modelId: 'kimi-k3', providerId: 'kimi', displayName: 'Kimi K3', computeClass: 'C', tier: 'PREMIUM', priority: 12, entitlement: 'PRO', supportsVision: true }),
  M({ modelId: 'kimi-k2.7-code', providerId: 'kimi', displayName: 'Kimi K2.7 Code', computeClass: 'B', tier: 'CAPABLE', priority: 42, codingOptimized: true }),
  M({ modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b', providerId: 'nemotron', displayName: 'Nemotron Lightning', computeClass: 'A', priority: 35, codingOptimized: true }),
  M({ modelId: 'north-mini-code-1.0', providerId: 'north', displayName: 'North Mini Code', computeClass: 'A', priority: 33, codingOptimized: true }),
  M({ modelId: 'mistral-large', providerId: 'mistral', displayName: 'Mistral Large', computeClass: 'B', tier: 'CAPABLE', priority: 10 }),
  M({ modelId: 'openai-gpt-5.2', providerId: 'openai', displayName: 'GPT-5.2', computeClass: 'B', tier: 'CAPABLE', priority: 11 }),
];

beforeEach(() => {
  registry.getRegistry.mockReset();
  registry.getRegistry.mockResolvedValue(REGISTRY as never);
  db.state.resolve = (text: string) => {
    if (text.includes('FROM users')) return [{ plan_id: 'pro' }];
    if (text.includes('provider_health')) return [];
    return null;
  };
});

afterEach(() => {
  db.state.resolve = null;
});

describe('MODEL DISCOVERY — 9-provider gateway', () => {
  it('discovers all five new provider models when configured', async () => {
    const models = await eligibleModels('u1');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('grok-4.3');
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain('kimi-k2.7-code');
    expect(ids).toContain('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(ids).toContain('north-mini-code-1.0');
  });

  it('excludes premium models for free plans (honest entitlement)', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('provider_health')) return [];
      return null;
    };
    const models = await eligibleModels('free-user');
    expect(models.some((m) => m.entitlement === 'PRO')).toBe(false);
    expect(models.some((m) => m.modelId === 'kimi-k3')).toBe(false);
  });

  it('excludes DOWN providers from routing', async () => {
    const withDown = REGISTRY.map((m) => (m.providerId === 'grok' ? { ...m, health: 'DOWN' as ProviderState } : m));
    registry.getRegistry.mockResolvedValue(withDown as never);
    const models = await eligibleModels('u1');
    expect(models.some((m) => m.providerId === 'grok')).toBe(false);
  });
});

describe('ROUTING — coding + provider exclusion', () => {
  it('prefers coding-optimized models for coding workloads', async () => {
    const ranked = await eligibleModels('u1', { coding: true, computeClass: 'A' });
    const coding = ranked.filter((m) => m.codingOptimized);
    const others = ranked.filter((m) => !m.codingOptimized);
    expect(coding.length).toBeGreaterThan(0);
    for (const c of coding) {
      for (const o of others) {
        expect(ranked.indexOf(c)).toBeLessThan(ranked.indexOf(o));
      }
    }
  });

  it('non-coding workloads rank by priority (coding flag ignored)', async () => {
    const ranked = await eligibleModels('u1', { computeClass: 'B' });
    expect(ranked[0]!.modelId).toBe('mistral-large');
  });

  it('excludeProvider removes the entire provider (reviewer independence)', async () => {
    const ranked = await eligibleModels('u1', { excludeProvider: 'deepseek', coding: true, computeClass: 'B' });
    expect(ranked.some((m) => m.providerId === 'deepseek')).toBe(false);
  });

  it('routeModels returns primary/fallback/tertiary from distinct models', async () => {
    const sel = await routeModels('u1', { coding: true, computeClass: 'A' });
    const ids = new Set([sel.primary.modelId, sel.fallback.modelId, sel.tertiary.modelId]);
    expect(ids.size).toBe(3);
    expect(sel.primary.codingOptimized).toBe(true);
  });

  it('requestedModelId is honored only when eligible (never silently swapped)', async () => {
    const sel = await routeModels('u1', { requestedModelId: 'deepseek-v4-pro', coding: true, computeClass: 'B' });
    expect(sel.primary.modelId).toBe('deepseek-v4-pro');
  });

  it('requested premium model on free plan falls back honestly (no silent premium grant)', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('provider_health')) return [];
      return null;
    };
    const models = await eligibleModels('free-user', { requestedModelId: 'kimi-k3' });
    expect(models.some((m) => m.modelId === 'kimi-k3')).toBe(false);
  });

  it('AI_DEFAULT_MODEL becomes the primary only when eligible (server-level default)', async () => {
    const { env } = await import('../config/env.js');
    const prev = (env as Record<string, unknown>).AI_DEFAULT_MODEL;
    Object.defineProperty(env, 'AI_DEFAULT_MODEL', { value: 'deepseek-v4-pro', configurable: true });
    try {
      const sel = await routeModels('u1', {});
      expect(sel.primary.modelId).toBe('deepseek-v4-pro');
      const selCoding = await routeModels('u1', { coding: true, computeClass: 'B' });
      expect(selCoding.primary.modelId).toBe('deepseek-v4-pro');
    } finally {
      Object.defineProperty(env, 'AI_DEFAULT_MODEL', { value: prev, configurable: true });
    }
  });

  it('ineligible AI_DEFAULT_MODEL falls back to ranked list (never fails the request)', async () => {
    const { env } = await import('../config/env.js');
    const prev = (env as Record<string, unknown>).AI_DEFAULT_MODEL;
    Object.defineProperty(env, 'AI_DEFAULT_MODEL', { value: 'kimi-k3', configurable: true });
    try {
      db.state.resolve = (text: string) => {
        if (text.includes('FROM users')) return [{ plan_id: 'free' }];
        if (text.includes('provider_health')) return [];
        return null;
      };
      const sel = await routeModels('free-user', {});
      expect(sel.primary.modelId).not.toBe('kimi-k3');
      expect(sel.primary).toBeTruthy();
    } finally {
      Object.defineProperty(env, 'AI_DEFAULT_MODEL', { value: prev, configurable: true });
      db.state.resolve = null;
    }
  });
});

describe('HONEST FAILURE — no model available', () => {
  it('throws no_model_available with zero providers configured', async () => {
    registry.configuredProviders.mockReturnValue([] as never);
    await expect(routeModels('u1', {})).rejects.toMatchObject({ errorCode: 'no_model_available' });
    registry.configuredProviders.mockReturnValue(['openai', 'anthropic', 'google', 'mistral', 'grok', 'deepseek', 'kimi', 'nemotron', 'north'] as never);
  });

  it('throws no_model_available when every provider is DOWN', async () => {
    const allDown = REGISTRY.map((m) => ({ ...m, health: 'DOWN' as ProviderState }));
    registry.getRegistry.mockResolvedValue(allDown as never);
    await expect(routeModels('u1', {})).rejects.toMatchObject({ errorCode: 'no_model_available' });
  });
});

describe('ADAPTER CONSTRUCTION — new providers (no network)', () => {
  it('builds OpenAI-compatible adapters for grok/deepseek/kimi/nemotron', async () => {
    const { env } = await import('../config/env.js');
    const keys = { GROK_API_KEY: 'xai-test', DEEPSEEK_API_KEY: 'ds-test', KIMI_API_KEY: 'kimi-test', NVIDIA_API_KEY: 'nim-test' };
    const prev = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(keys)) {
      prev.set(k, env[k as keyof typeof env] as string | undefined);
      Object.defineProperty(env, k, { value: v, configurable: true });
    }
    try {
      for (const provider of ['grok', 'deepseek', 'kimi', 'nemotron'] as const) {
        const adapter = getAdapter(provider, 'some-model');
        expect(adapter.providerId).toBe(provider);
        expect(adapter.supportsToolCalls).toBe(true);
      }
    } finally {
      for (const [k, v] of prev) Object.defineProperty(env, k, { value: v, configurable: true });
    }
  });

  it('builds the Cohere v2 adapter for north models', async () => {
    const { env } = await import('../config/env.js');
    const prev = env.COHERE_API_KEY;
    Object.defineProperty(env, 'COHERE_API_KEY', { value: 'cohere-test', configurable: true });
    try {
      const adapter = getAdapter('north', 'north-mini-code-1.0');
      expect(adapter.providerId).toBe('north');
      expect(adapter.supportsToolCalls).toBe(true);
    } finally {
      Object.defineProperty(env, 'COHERE_API_KEY', { value: prev, configurable: true });
    }
  });

  it('throws provider_not_configured when the key is missing', async () => {
    const previous = new Map<string, string | undefined>();
    const { env } = await import('../config/env.js');
    for (const k of ['GROK_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'NVIDIA_API_KEY', 'COHERE_API_KEY'] as const) {
      previous.set(k, env[k]);
      Object.defineProperty(env, k, { value: undefined, configurable: true });
    }
    try {
      for (const p of ['grok', 'deepseek', 'kimi', 'nemotron', 'north']) {
        expect(() => getAdapter(p, 'm')).toThrowError(/not configured/);
      }
    } finally {
      for (const [k, v] of previous) Object.defineProperty(env, k, { value: v, configurable: true });
    }
  });

  it('unknown providers are rejected', () => {
    expect(() => getAdapter('alien', 'm')).toThrowError(/Unknown provider/);
  });

  it('classifies provider failures into the shared taxonomy', () => {
    expect(classifyProviderError(AppError.unavailable('provider_billing', 'billing'))).toBe('billing');
    expect(classifyProviderError(AppError.unavailable('invalid_credentials', 'bad key'))).toBe('invalid_credentials');
    expect(classifyProviderError(AppError.unavailable('rate_limited', '429'))).toBe('rate_limited');
    expect(classifyProviderError(new Error('boom'))).toBe('provider_unavailable');
  });
});