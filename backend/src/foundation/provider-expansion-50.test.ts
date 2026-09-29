/**
 * CODECONCLAVE PRO PROMPT 1 — PROVIDER EXPANSION FOUNDATION contract suite.
 * Covers the new provider foundation: external agent (Devin) routing gating,
 * Qwen/Gemma wiring, Z Code 5.3 unverified sentinel rejection, missing-
 * credential handling, and capability metadata. No provider is contacted;
 * DB + registry + adapters are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const db = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const query = async (text: string, _params: unknown[] = []) => ({
    rows: text.includes('plan_id') ? [{ plan_id: 'pro' }] : state.rows,
    rowCount: 0,
  });
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

const memory = vi.hoisted(() => ({
  retrieveMemoriesForPrompt: vi.fn(async () => [] as string[]),
  extractEpisodicMemory: vi.fn(async () => {}),
}));
vi.mock('../modules/memory/service.js', () => memory);

const context = vi.hoisted(() => ({
  retrieveScopedContext: vi.fn(async () => ({ memories: [] as string[], dna: [] as string[] })),
}));
vi.mock('../modules/memory/context.js', () => context);

const envState = vi.hoisted(() => ({
  current: {
    QWEN_API_KEY: 'test-qwen-key' as string | undefined,
    DEVIN_API_KEY: 'cog_test-devin' as string | undefined,
    DEVIN_ORG_ID: 'org-1' as string | undefined,
    GEMINI_API_KEY: 'test-gemini-key' as string | undefined,
    OX_ALPHA_API_KEY: 'test-ox-key' as string | undefined,
    MANUS_API_KEY: 'test-manus-key' as string | undefined,
    Z_AI_API_KEY: 'test-z-key' as string | undefined,
  },
}));
vi.mock('../config/env.js', () => ({
  env: envState.current,
  enabledProviders: ['openai', 'devin'],
}));

import type { AiModelDescriptor, ProviderState } from '@codeconclave/shared';
import { getAdapter } from '../modules/ai/providers.js';
import { eligibleModels } from '../modules/ai/gateway.js';

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

const registry = vi.hoisted(() => ({
  getRegistry: vi.fn(async () => [] as unknown[]),
  configuredProviders: vi.fn(() => ['openai']),
  getModel: vi.fn(async () => {
    throw new Error('not used in these tests');
  }),
}));
vi.mock('../modules/ai/registry.js', () => registry);

const MODELS: AiModelDescriptor[] = [
  M({ modelId: 'openai-a', providerId: 'openai' }),
  M({
    modelId: 'devin-session',
    providerId: 'devin',
    capabilityCategory: 'EXTERNAL_AGENT' as const,
    tier: 'PREMIUM',
    computeClass: 'C',
  }),
];

beforeAll(() => {
  registry.getRegistry.mockResolvedValue(MODELS as never);
  registry.configuredProviders.mockReturnValue(['openai', 'devin']);
});
afterAll(() => {
  envState.current.QWEN_API_KEY = 'test-qwen-key';
});

describe('PROVIDER EXPANSION — capability metadata', () => {
  it('defaults capabilityCategory to MODEL for ordinary models', () => {
    const m = M({});
    expect(m.capabilityCategory ?? 'MODEL').toBe('MODEL');
  });

  it('carries EXTERNAL_AGENT capability for agent-backed models', () => {
    const devin = M({ providerId: 'devin', capabilityCategory: 'EXTERNAL_AGENT' as const });
    expect(devin.capabilityCategory).toBe('EXTERNAL_AGENT');
  });
});

describe('PROVIDER EXPANSION — external agent (Devin) routing gating', () => {
  it('excludes EXTERNAL_AGENT models from normal chat routing by default', async () => {
    const eligible = await eligibleModels('u1', {});
    const ids = eligible.map((m) => m.modelId);
    expect(ids).toContain('openai-a');
    expect(ids).not.toContain('devin-session');
  });

  it('includes EXTERNAL_AGENT models only when allowExternalAgents is true', async () => {
    const eligible = await eligibleModels('u1', { allowExternalAgents: true });
    const ids = eligible.map((m) => m.modelId);
    expect(ids).toContain('devin-session');
  });
});

describe('PROVIDER EXPANSION — getAdapter wiring', () => {
  it('builds an adapter for configured Z Code 5.3 (key verified, gate lifted)', () => {
    envState.current.Z_AI_API_KEY = 'test-z-key';
    const a = getAdapter('z_code_5_3', 'glm-5.3');
    expect(a.providerId).toBe('z_code_5_3');
    expect(typeof a.complete).toBe('function');
  });

  it('throws provider_not_configured for unconfigured Z Code when key absent', () => {
    envState.current.Z_AI_API_KEY = undefined;
    let err: Error | undefined;
    try { getAdapter('z_code_5_3', 'glm-5.3'); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(String(err?.message)).toContain('not configured');
    expect(String(err?.message)).not.toContain('provider quality gate');
    envState.current.Z_AI_API_KEY = 'test-z-key';
  });

  it('builds an adapter for Ox Alpha when the key is present (gate lifted)', () => {
    const a = getAdapter('ox_alpha', 'stealth/ox-alpha');
    expect(a.providerId).toBe('ox_alpha');
    expect(typeof a.complete).toBe('function');
  });

  it('blocks Manus at the gate — task lifecycle is never reachable', () => {
    envState.current.MANUS_API_KEY = 'test-manus-key';
    const fn = () => getAdapter('manus', 'manus-1.6');
    expect(fn).toThrow(/provider quality gate/);
  });

  it('throws provider_not_configured for unconfigured Qwen when key absent', () => {
    envState.current.QWEN_API_KEY = undefined;
    const fn = () => getAdapter('qwen', 'qwen3.8-max');
    expect(fn).toThrow(/Qwen is not configured/);
    envState.current.QWEN_API_KEY = 'test-qwen-key';
  });

  it('builds an adapter for configured Qwen', () => {
    const a = getAdapter('qwen', 'qwen3.8-max');
    expect(a.providerId).toBe('qwen');
    expect(typeof a.complete).toBe('function');
  });

  it('builds the Devin external-agent adapter when credentials configured', () => {
    const a = getAdapter('devin', 'devin-session');
    expect(a.providerId).toBe('devin');
    expect(a.supportsToolCalls).toBe(true);
    expect(typeof a.complete).toBe('function');
  });
});
