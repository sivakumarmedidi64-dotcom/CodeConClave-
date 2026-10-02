/**
 * CodeConClave — model gateway foundation tests.
 * Covers: entitlement gating (free vs pro), tier/capability filtering,
 * compute-class preference, DOWN-health skip, honest fallback, no-provider
 * failure, cost estimation math. Registry + DB are mocked; no provider is hit.
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
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const registry = vi.hoisted(() => {
  return {
    getRegistry: vi.fn(async () => [] as unknown[]),
    configuredProviders: vi.fn(() => ['openai', 'anthropic']),
    getModel: vi.fn(async () => {
      throw new Error('not used in these tests');
    }),
  };
});
vi.mock('../modules/ai/registry.js', () => registry);

import { routeModels, estimateCost } from '../modules/ai/gateway.js';
import type { AiModelDescriptor } from '@codeconclave/shared';
import { AppError } from '../shared/errors.js';

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

function mockPlan(plan: 'free' | 'pro') {
  db.state.resolve = (text) => (text.includes('SELECT plan_id FROM users') ? [{ plan_id: plan }] : null);
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  vi.mocked(registry.getRegistry).mockClear();
  vi.mocked(registry.configuredProviders).mockClear();
  vi.mocked(registry.configuredProviders).mockReturnValue(['openai', 'anthropic']);
});

afterEach(() => {
  registry.getRegistry.mockReset();
});

describe('routeModels — entitlement + capability gating', () => {
  it('free plan only sees EFFICIENT, FREE-entitlement models', async () => {
    mockPlan('free');
    const efficient = model('eff-1');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('prem-1', { tier: 'PREMIUM', entitlement: 'PRO', priority: 1, providerId: 'openai' }),
      model('cap-1', { tier: 'CAPABLE', priority: 2, providerId: 'anthropic' }),
      { ...efficient, priority: 3 },
    ]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('eff-1');
  });

  it('pro plan unlocks PREMIUM/CAPABLE tiers and PRO entitlements', async () => {
    mockPlan('pro');
    const pro = model('prem-1', { tier: 'PREMIUM', entitlement: 'PRO', priority: 1 });
    vi.mocked(registry.getRegistry).mockResolvedValue([pro, model('eff-1', { priority: 2 })]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('prem-1');
  });

  it('filters by tools/vision/context capabilities', async () => {
    mockPlan('pro');
    const withTools = model('tool-1', {
      tier: 'CAPABLE',
      priority: 1,
      supportsTools: true,
      supportsVision: true,
      contextWindow: 128_000,
    });
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('notool-1', { tier: 'PREMIUM', priority: 0, supportsTools: false }),
      model('novision-1', { tier: 'PREMIUM', priority: 1, supportsVision: false }),
      model('smallctx-1', { tier: 'PREMIUM', priority: 2, contextWindow: 8_000 }),
      withTools,
    ]);
    const selection = await routeModels('u1', { needsTools: true, needsVision: true, maxContextTokens: 32_000 });
    expect(selection.primary.modelId).toBe('tool-1');
  });

  it('prefers compute class A for A-class workloads on pro', async () => {
    mockPlan('pro');
    const aModel = model('a-1', { computeClass: 'A', priority: 50 });
    vi.mocked(registry.getRegistry).mockResolvedValue([
      aModel,
      model('b-1', { computeClass: 'B', priority: 1 }),
    ]);
    const selection = await routeModels('u1', { computeClass: 'A' });
    expect(selection.primary.modelId).toBe('a-1');
  });

  it('honors the requested model id when healthy, falls back when DOWN', async () => {
    mockPlan('pro');
    const requested = model('req-1', { priority: 5 });
    const winner = model('win-1', { priority: 1 });
    vi.mocked(registry.getRegistry).mockResolvedValue([requested, winner]);
    let selection = await routeModels('u1', { requestedModelId: 'req-1' });
    expect(selection.primary.modelId).toBe('req-1');

    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('req-1', { priority: 5, health: 'DOWN' }),
      winner,
    ]);
    selection = await routeModels('u1', { requestedModelId: 'req-1' });
    expect(selection.primary.modelId).toBe('win-1');
  });

  it('never selects a DOWN model as primary/fallback', async () => {
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([
      model('down-1', { priority: 1, health: 'DOWN' }),
      model('ok-1', { priority: 2 }),
    ]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('ok-1');
  });

  it('throws an honest unavailable error when no provider is configured', async () => {
    mockPlan('free');
    vi.mocked(registry.configuredProviders).mockReturnValue([]);
    vi.mocked(registry.getRegistry).mockResolvedValue([model('only-1')]);
    await expect(routeModels('u1', {})).rejects.toMatchObject({ errorCode: 'no_model_available' });
    await expect(routeModels('u1', {})).rejects.toThrow(/No AI provider is configured/);
  });

  it('throws when nothing is eligible (entitlement/capability/health)', async () => {
    mockPlan('free');
    vi.mocked(registry.getRegistry).mockResolvedValue([model('prem-1', { tier: 'PREMIUM', entitlement: 'PRO' })]);
    await expect(routeModels('u1', {})).rejects.toMatchObject({ errorCode: 'no_model_available' });
  });

  it('produces distinct primary/fallback/tertiary when possible, honest collapse otherwise', async () => {
    mockPlan('pro');
    const a = model('m1', { priority: 1 });
    const b = model('m2', { priority: 2 });
    const c = model('m3', { priority: 3 });
    vi.mocked(registry.getRegistry).mockResolvedValue([a, b, c]);
    const selection = await routeModels('u1', {});
    expect(selection.primary.modelId).toBe('m1');
    expect(selection.fallback.modelId).toBe('m2');
    expect(selection.tertiary.modelId).toBe('m3');

    vi.mocked(registry.getRegistry).mockResolvedValue([a]);
    const single = await routeModels('u1', {});
    expect(single.fallback.modelId).toBe('m1');
    expect(single.tertiary.modelId).toBe('m1');
  });
});

describe('estimateCost — deterministic cost math', () => {
  it('computes USD from per-million token prices', () => {
    const m = model('m', { inputCostPerM: 10, outputCostPerM: 30 });
    expect(estimateCost(m, 1_000_000, 0)).toBe(10);
    expect(estimateCost(m, 0, 1_000_000)).toBe(30);
    expect(estimateCost(m, 100_000, 50_000)).toBeCloseTo(1 + 1.5, 10);
  });

  it('is monotonic in token counts', () => {
    const m = model('m', { inputCostPerM: 1, outputCostPerM: 2 });
    expect(estimateCost(m, 1000, 1000)).toBeLessThan(estimateCost(m, 2000, 1000));
    expect(estimateCost(m, 1000, 1000)).toBeLessThan(estimateCost(m, 1000, 2000));
  });
});

describe('AppError code for unavailable routing', () => {
  it('carries a stable machine-readable code', async () => {
    mockPlan('pro');
    vi.mocked(registry.configuredProviders).mockReturnValue([]);
    vi.mocked(registry.getRegistry).mockResolvedValue([model('x')]);
    try {
      await routeModels('u1', {});
      throw new Error('expected routeModels to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).errorCode).toBe('no_model_available');
    }
  });
});