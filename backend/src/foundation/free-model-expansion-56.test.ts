/**
 * CODECONCLAVE FREE-MODEL EXPANSION — contract suite for the 10 zero-cost
 * model entries (NVIDIA NIM + Google Gemini + Mistral).
 *
 * Covers the corrected 0128/0129 seed contract: 10 model IDs at zero cost,
 * slash-prefixed ids served by the 'nemotron' (NVIDIA NIM) provider,
 * capability_category respecting the shared 'MODEL' | 'EXTERNAL_AGENT' type
 * (never free-form taxonomy), honest tool-call flags for the google adapter
 * (supports_tools/function_calling = false), credential mapping + missing-key
 * handling, failure classification (billing/429/timeout), capability-gated and
 * free-tier-safe routing with NO paid fallback, no secret leakage, and
 * regression that existing Gemini/NVIDIA/Mistral adapters still construct.
 * DB, env keys, and provider HTTP are mocked; no provider is contacted and no
 * API key value is printed or asserted by value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError } from '../shared/errors.js';

// ---- env mock: the three free-tier providers are configured (test values) ----
const envState = vi.hoisted(() => {
  const current: Record<string, string | undefined> = {
    GEMINI_API_KEY: 'test-gemini-key-abc123',
    NVIDIA_API_KEY: 'test-nvidia-key-abc123',
    MISTRAL_API_KEY: 'test-mistral-key-abc123',
    QWEN_API_KEY: 'test-qwen-key',
    DEVIN_API_KEY: 'cog_test-devin',
    DEVIN_ORG_ID: 'org-1',
  };
  return { current };
});
vi.mock('../config/env.js', () => ({
  env: envState.current,
  enabledProviders: [
    'anthropic', 'openai', 'google', 'mistral', 'grok', 'deepseek', 'kimi',
    'nemotron', 'north', 'cohere', 'qwen', 'gemma', 'devin', 'ox_alpha',
    'manus', 'z_code_5_3',
  ],
}));

// ---- db mock: servable registry rows + plan + provider health ----------------
const db = vi.hoisted(() => {
  const state: {
    plan: string;
    registryRows: unknown[];
    healthRows: unknown[];
    calls: { text: string; params: unknown[] }[];
  } = { plan: 'pro', registryRows: [], healthRows: [], calls: [] };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    if (text.includes('SELECT plan_id')) return { rows: [{ plan_id: state.plan }], rowCount: 0 };
    if (text.includes('FROM ai_model_registry')) return { rows: state.registryRows, rowCount: state.registryRows.length };
    if (text.includes('FROM provider_health')) return { rows: state.healthRows, rowCount: state.healthRows.length };
    return { rows: [], rowCount: 0 };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    }),
  };
});
vi.mock('../shared/db.js', () => db);

vi.mock('../shared/cache.js', () => ({
  cache: {
    kind: 'memory',
    get: async () => null,
    set: async () => {},
    del: async () => {},
    incr: async () => 1,
    health: async () => true,
  },
  memoryStore: {
    kind: 'memory',
    get: async () => null,
    set: async () => {},
    del: async () => {},
    incr: async () => 1,
    health: async () => true,
  },
}));

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

const registerMock = vi.hoisted(() => ({
  notify: vi.fn(async () => {}),
}));
vi.mock('../modules/notifications/service.js', () => ({ notify: registerMock.notify, notifyUser: registerMock.notify }));

const audit = vi.hoisted(() => ({
  recordAudit: vi.fn(async () => {}),
}));
vi.mock('../modules/audit/service.js', () => audit);

const memory = vi.hoisted(() => ({
  retrieveMemoriesForPrompt: vi.fn(async () => [] as string[]),
  extractEpisodicMemory: vi.fn(async () => {}),
}));
vi.mock('../modules/memory/service.js', () => memory);

const context = vi.hoisted(() => ({
  retrieveScopedContext: vi.fn(async () => ({ memories: [] as string[], dna: [] as string[] })),
}));
vi.mock('../modules/memory/context.js', () => context);

// ---- modules under test (REAL registry + REAL adapters; only HTTP mocked) ----
import { getRegistry } from '../modules/ai/registry.js';
import { getAdapter, classifyProviderError, deriveStatusFromFailure, GEMINI_IMAGE_MODEL_IDS } from '../modules/ai/providers.js';
import { eligibleModels, routeModels } from '../modules/ai/gateway.js';
import type { AiModelDescriptor } from '@codeconclave/shared';

// The 10 corrected 0128/0129 rows (what the DB now provably returns):
const TARGET_IDS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'moonshotai/kimi-k3',
  'google/gemma-4-31b-it',
  'openai/gpt-oss-120b',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'mistral-small-4',
];

/**
 * Mirror of database/migrations/0128_model_seeds.sql (corrected by 0129).
 * Every field must match the real seed row — never simplified by prefix.
 */
const REAL_ROWS: Record<string, { tier: string; compute_class: string; vision: boolean; tools: boolean; fn: boolean; coding: boolean }> = {
  'nvidia/nemotron-3-ultra-550b-a55b': { tier: 'CAPABLE', compute_class: 'B', vision: false, tools: true, fn: true, coding: true },
  'nvidia/nemotron-3.5-lightning-30b-a3b': { tier: 'EFFICIENT', compute_class: 'A', vision: false, tools: true, fn: true, coding: true },
  'moonshotai/kimi-k3': { tier: 'CAPABLE', compute_class: 'B', vision: true, tools: true, fn: true, coding: false },
  'google/gemma-4-31b-it': { tier: 'CAPABLE', compute_class: 'B', vision: true, tools: true, fn: true, coding: false },
  'openai/gpt-oss-120b': { tier: 'CAPABLE', compute_class: 'B', vision: false, tools: true, fn: true, coding: true },
  'gemini-3.8-flash': { tier: 'CAPABLE', compute_class: 'B', vision: true, tools: false, fn: false, coding: false },
  'gemini-3.7-flash': { tier: 'CAPABLE', compute_class: 'B', vision: true, tools: false, fn: false, coding: true },
  'gemini-3.6-flash': { tier: 'EFFICIENT', compute_class: 'A', vision: true, tools: false, fn: false, coding: false },
  'gemini-3.1-flash-lite': { tier: 'EFFICIENT', compute_class: 'A', vision: true, tools: false, fn: false, coding: false },
  'mistral-small-4': { tier: 'EFFICIENT', compute_class: 'A', vision: false, tools: true, fn: true, coding: true },
};

function row(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  const provider = id.startsWith('gemini-') ? 'google' : id === 'mistral-small-4' ? 'mistral' : 'nemotron';
  const real = REAL_ROWS[id] ?? { tier: 'CAPABLE', compute_class: 'B', vision: false, tools: true, fn: true, coding: false };
  return {
    model_id: id,
    provider_id: provider,
    display_name: id,
    tier: real.tier,
    compute_class: real.compute_class,
    context_window: id === 'google/gemma-4-31b-it' ? 262144 : id === 'openai/gpt-oss-120b' ? 131072 : id === 'mistral-small-4' ? 262144 : 1048576,
    supports_vision: real.vision,
    supports_tools: real.tools,
    supports_function_calling: real.fn,
    input_cost_per_m: '0',
    output_cost_per_m: '0',
    entitlement: provider === 'google' || id === 'mistral-small-4' ? 'FREE' : 'PRO',
    privacy_class: 'STANDARD',
    target_latency_ms: 2000,
    health: 'UNKNOWN',
    priority: TARGET_IDS.indexOf(id) + 1,
    fallback_list: [],
    enabled: true,
    effective_date: '2026-01-01',
    deprecation_date: null,
    coding_optimized: real.coding,
    capability_category: 'MODEL',
    image_generation: false,
    image_editing: false,
    ...overrides,
  };
}

function seedRegistry(): void {
  db.state.registryRows = TARGET_IDS.map((id) => row(id));
  db.state.healthRows = [];
}

// ---- fetch mock: scripted HTTP per provider URL (never a real request) -------
type Call = { url: string; headers: Record<string, string>; body: unknown };
const fetchCalls: Call[] = [];
const scripts: Record<string, (url: string) => Response> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  fetchCalls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : null });
  const script = scripts[url];
  if (script) return script(url);
  return new Response('{"error":"no-script"}', { status: 500 });
});
function sseBody(payloads: unknown[]): Response {
  const text = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).concat('data: [DONE]\n\n').join('');
  return new Response(text, { status: 200 });
}
vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal('Response', Response);

beforeEach(() => {
  seedRegistry();
  db.state.plan = 'pro';
  fetchCalls.length = 0;
  scripts['*'] = () => sseBody([{ choices: [{ delta: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }]);
});
afterEach(() => {
  for (const k of Object.keys(scripts)) delete scripts[k];
});

// ---------------------------------------------------------------- REGISTRY

describe('FREE MODEL EXPANSION — registry contract', () => {
  it('1. loads exactly the 10 target free-tier model IDs with corrected providers', async () => {
    const list = await getRegistry(true);
    expect(list.map((m) => m.modelId).sort()).toEqual([...TARGET_IDS].sort());
    // The data-defect regression: slash-prefixed ids are served by NVIDIA NIM.
    expect(list.find((m) => m.modelId === 'moonshotai/kimi-k3')?.providerId).toBe('nemotron');
    expect(list.find((m) => m.modelId === 'google/gemma-4-31b-it')?.providerId).toBe('nemotron');
    expect(list.find((m) => m.modelId === 'openai/gpt-oss-120b')?.providerId).toBe('nemotron');
    expect(list.find((m) => m.modelId === 'gemini-3.8-flash')?.providerId).toBe('google');
    expect(list.find((m) => m.modelId === 'mistral-small-4')?.providerId).toBe('mistral');
  });

  it('2. capability_category respects the shared MODEL|EXTERNAL_AGENT type for every row', async () => {
    const list = await getRegistry(true);
    const categories = new Set(list.map((m) => m.capabilityCategory));
    expect([...categories].every((c) => c === 'MODEL' || c === 'EXTERNAL_AGENT')).toBe(true);
    expect(list.every((m) => m.capabilityCategory === 'MODEL')).toBe(true);
  });

  it('3. all 10 entries are zero-cost (no paid fallback can ever be billed)', async () => {
    const list = await getRegistry(true);
    for (const m of list) {
      expect(m.inputCostPerM).toBe(0);
      expect(m.outputCostPerM).toBe(0);
    }
  });

  it('4. honest capability flags: google rows report no typed tool-call support; NIM/mistral do', async () => {
    const list = await getRegistry(true);
    for (const m of list.filter((x) => x.providerId === 'google')) {
      expect(m.supportsTools).toBe(false);
      expect(m.supportsFunctionCalling).toBe(false);
    }
    for (const m of list.filter((x) => x.providerId === 'nemotron' || x.providerId === 'mistral')) {
      expect(m.supportsTools).toBe(true);
      expect(m.supportsFunctionCalling).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- CREDENTIALS

describe('FREE MODEL EXPANSION — credential mapping + missing keys', () => {
  it('5. one API key serves many model ids (provider → env variable mapping)', () => {
    // nemotron (NVIDIA NIM) serves all slash-prefixed ids with NVIDIA_API_KEY.
    expect(getAdapter('nemotron', 'moonshotai/kimi-k3').providerId).toBe('nemotron');
    expect(getAdapter('nemotron', 'google/gemma-4-31b-it').providerId).toBe('nemotron');
    expect(getAdapter('nemotron', 'openai/gpt-oss-120b').providerId).toBe('nemotron');
    // google serves the gemini flash family with GEMINI_API_KEY (shared with gemma provider).
    expect(getAdapter('google', 'gemini-3.8-flash').providerId).toBe('google');
    // mistral serves mistral-small-4 with MISTRAL_API_KEY.
    expect(getAdapter('mistral', 'mistral-small-4').providerId).toBe('mistral');
  });

  it('6. missing key fails closed with provider_not_configured (never a blank adapter)', async () => {
    const key = envState.current.NVIDIA_API_KEY;
    envState.current.NVIDIA_API_KEY = undefined;
    try {
      expect(() => getAdapter('nemotron', 'nvidia/nemotron-3-ultra-550b-a55b')).toThrowError('NVIDIA NIM is not configured');
      expect(classifyProviderError(AppError.unavailable('provider_not_configured', 'NVIDIA NIM is not configured'))).toBe('provider_not_configured');
    } finally {
      envState.current.NVIDIA_API_KEY = key;
    }
  });

  it('7. Gemini image-generation ids still select the dedicated image adapter', () => {
    for (const id of GEMINI_IMAGE_MODEL_IDS) {
      expect(getAdapter('google', id).providerId).toBe('google');
    }
    expect(getAdapter('google', 'gemini-3.8-flash').supportsToolCalls).toBe(false);
  });
});

// ---------------------------------------------------------------- FAILURES

describe('FREE MODEL EXPANSION — honest failure classification', () => {
  it('8. quota/billing exhaustion classifies as billing → QUOTA_EXHAUSTED', () => {
    const err = AppError.unavailable('provider_billing', 'NVIDIA NIM billing quota exhausted');
    expect(classifyProviderError(err)).toBe('billing');
    expect(deriveStatusFromFailure(err)).toBe('QUOTA_EXHAUSTED');
  });

  it('9. 429 rate limit classifies as rate_limited → RATE_LIMITED (distinct from billing)', () => {
    expect(classifyProviderError(AppError.unavailable('rate_limited', 'rate limit'))).toBe('rate_limited');
    expect(deriveStatusFromFailure(AppError.unavailable('rate_limited', 'rate limit'))).toBe('RATE_LIMITED');
  });

  it('10. timeout classifies as timeout → DEGRADED', () => {
    const err = AppError.unavailable('provider_timeout', 'NVIDIA NIM request timed out');
    expect(classifyProviderError(err)).toBe('timeout');
    expect(deriveStatusFromFailure(err)).toBe('DEGRADED');
  });
});

// ---------------------------------------------------------------- ROUTING

describe('FREE MODEL EXPANSION — capability-gated, free-tier-safe routing', () => {
  it('11. capability gating: needsTools routes to NIM/mistral, never to google rows', async () => {
    const toolEligible = await eligibleModels('u1', { needsTools: true });
    expect(toolEligible.length).toBeGreaterThan(0);
    expect(toolEligible.every((m) => m.supportsTools)).toBe(true);
    expect(toolEligible.every((m) => !m.modelId.startsWith('gemini-'))).toBe(true);
    const selection = await routeModels('u1', { needsTools: true });
    expect(['nemotron', 'mistral']).toContain(selection.primary.providerId);
  });

  it('12. free plan never routes to PRO-entitlement or non-EFFICIENT rows (no paid fallback)', async () => {
    db.state.plan = 'free';
    const eligible = await eligibleModels('u1', {});
    expect(eligible.every((m) => m.entitlement === 'FREE')).toBe(true);
    expect(eligible.every((m) => m.tier === 'EFFICIENT')).toBe(true);
    const selection = await routeModels('u1', {});
    expect(selection.primary.entitlement).toBe('FREE');
    expect(selection.primary.inputCostPerM).toBe(0);
    expect(selection.primary.outputCostPerM).toBe(0);
  });

  it('13. when all free-tier rows are DOWN, routing fails honestly (never silently upgrades to paid)', async () => {
    db.state.plan = 'free';
    db.state.healthRows = [
      { provider_id: 'google', state: 'DOWN' },
      { provider_id: 'mistral', state: 'DOWN' },
      { provider_id: 'nemotron', state: 'DOWN' },
    ];
    await expect(routeModels('u1', {})).rejects.toThrow(AppError);
    // no paid model fallback was selected — eligible free models are empty.
    const eligible = await eligibleModels('u1', {});
    expect(eligible.filter((m) => m.entitlement === 'PRO')).toHaveLength(0);
  });

  it('14. pro user sees all 10 zero-cost models eligible (regression: Gemini/NVIDIA/Mistral all present)', async () => {
    const eligible = await eligibleModels('u1', {});
    const ids = eligible.map((m) => m.modelId);
    for (const id of TARGET_IDS) expect(ids).toContain(id);
    expect(eligible.every((m) => m.inputCostPerM === 0)).toBe(true);
  });
});