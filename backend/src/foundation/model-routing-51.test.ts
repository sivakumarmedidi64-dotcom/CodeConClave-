/**
 * CODECONCLAVE PRO PROMPT 2 — INTELLIGENT MODEL ROUTING contract suite.
 * Covers the Model Routing 2026 intelligence layer: intent classification,
 * capability matrix, preference ranking, planRoute decisions, explainable
 * reasons, user routing preferences, and routing observability columns.
 * No provider is contacted; gateway/registry/db are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { TaskType, RoutingPreference } from '@codeconclave/shared';

// ---- gateway mock (router imports eligibleModels) --------------------------
// Emulates the real gateway gates that planRoute delegates to: DOWN/DEGRADED
// health filtering + external-agent opt-in (never auto-selected for chat).
const gateway = vi.hoisted(() => {
  const state: { eligible: Array<Record<string, unknown>> } = { eligible: [] };
  const eligibleModels = vi.fn(async (_userId: string, opts: { allowExternalAgents?: boolean; maxContextTokens?: number }) => {
    return state.eligible.filter(
      (m) =>
        (m.health ?? 'HEALTHY') !== 'DOWN' &&
        (m.health ?? 'HEALTHY') !== 'DEGRADED' &&
        (m.capabilityCategory !== 'EXTERNAL_AGENT' || opts.allowExternalAgents === true) &&
        (!opts.maxContextTokens || (m.contextWindow ?? 0) >= opts.maxContextTokens),
    );
  });
  return { state, eligibleModels };
});

vi.mock('../modules/ai/gateway.js', () => ({
  eligibleModels: gateway.eligibleModels,
}));

// ---- workspace mock (routing-preferences imports get/updatePreferences) ----
const workspace = vi.hoisted(() => ({
  getPreferences: vi.fn(async () => ({}) as Promise<Record<string, unknown>>),
  updatePreferences: vi.fn(async () => ({}) as Promise<Record<string, unknown>>),
}));
vi.mock('../modules/workspace/service.js', () => workspace);
vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

// ---- module under test -----------------------------------------------------
import { classifyIntent, type IntentSignals } from '../modules/ai/intent.js';
import { modelCapabilities, supportsRequiredCapabilities, VERIFIED_PROVIDERS, UNVERIFIED_PROVIDERS } from '../modules/ai/capabilities.js';
import { planRoute, rankByPreference, reasonFor, TASK_POLICY } from '../modules/ai/router.js';
import {
  loadRoutingPreferences,
  saveRoutingPreferences,
  DEFAULT_ROUTING_PREFERENCES,
  isRoutingPreferenceValue,
} from '../modules/ai/routing-preferences.js';
import type { AiModelDescriptor } from '@codeconclave/shared';

/** Fixture models with distinct priority / cost / caps for ranking assertions. */
function fixtureModel(partial: Partial<AiModelDescriptor>): AiModelDescriptor {
  return {
    modelId: 'm',
    providerId: 'openai',
    displayName: 'Model',
    tier: 'EFFICIENT',
    computeClass: 'A',
    contextWindow: 128000,
    supportsVision: false,
    supportsTools: true,
    supportsFunctionCalling: true,
    inputCostPerM: 1,
    outputCostPerM: 2,
    entitlement: 'FREE',
    privacyClass: 'STANDARD',
    targetLatencyMs: 2000,
    health: 'HEALTHY',
    priority: 50,
    fallbackList: [],
    enabled: true,
    codingOptimized: false,
    capabilityCategory: 'MODEL',
    ...partial,
  } as AiModelDescriptor;
}

const MODEL_OPUS = fixtureModel({
  modelId: 'claude-opus', providerId: 'anthropic', displayName: 'Claude Opus',
  tier: 'PREMIUM', computeClass: 'C', priority: 10, codingOptimized: true,
  inputCostPerM: 15, outputCostPerM: 75, targetLatencyMs: 2500,
});
const MODEL_SONNET = fixtureModel({
  modelId: 'claude-sonnet', providerId: 'anthropic', displayName: 'Claude Sonnet',
  tier: 'CAPABLE', computeClass: 'B', priority: 20, codingOptimized: true,
  inputCostPerM: 3, outputCostPerM: 15, targetLatencyMs: 1800,
});
const MODEL_GPT4O = fixtureModel({
  modelId: 'gpt-4o', providerId: 'openai', displayName: 'GPT-4o',
  tier: 'CAPABLE', computeClass: 'B', priority: 30, codingOptimized: false,
  inputCostPerM: 2.5, outputCostPerM: 10, targetLatencyMs: 1700,
});
const MODEL_MINIFLASH = fixtureModel({
  modelId: 'gemini-flash', providerId: 'google', displayName: 'Gemini Flash',
  tier: 'EFFICIENT', computeClass: 'A', priority: 60,
  inputCostPerM: 0.1, outputCostPerM: 0.4, targetLatencyMs: 800,
});
const MODEL_GEMINI = fixtureModel({
  modelId: 'gemini-pro', providerId: 'google', displayName: 'Gemini Pro',
  tier: 'CAPABLE', computeClass: 'B', priority: 31, supportsVision: true,
  contextWindow: 1_048_576,
  imageEditing: true, // explicit registry fact (image_editing column) — Gemini image row
  inputCostPerM: 1.25, outputCostPerM: 5, targetLatencyMs: 1600,
});
const MODEL_DEVIN = fixtureModel({
  modelId: 'devin-session', providerId: 'devin', displayName: 'Devin',
  tier: 'PREMIUM', computeClass: 'C', priority: 5, codingOptimized: true,
  inputCostPerM: 0, outputCostPerM: 0, privacyClass: 'STRICT',
  capabilityCategory: 'EXTERNAL_AGENT',
});
const MODEL_ZCODE = fixtureModel({
  modelId: 'z-code-5-3', providerId: 'z_code_5_3', displayName: 'Z Code 5.3',
  tier: 'EFFICIENT', computeClass: 'A', priority: 99, health: 'DOWN', enabled: false,
});

const ALL_MODELS = [MODEL_OPUS, MODEL_SONNET, MODEL_GPT4O, MODEL_MINIFLASH, MODEL_GEMINI, MODEL_DEVIN, MODEL_ZCODE];

describe('Model Routing 2026 — intent classification', () => {
  it('classifies short text as FAST_SIMPLE_QUERY', () => {
    const c = classifyIntent({ text: 'hi' });
    expect(c.taskType).toBe(TaskType.FAST_SIMPLE_QUERY);
    expect(c.capabilityHints.needsCoding).toBe(false);
  });

  it('classifies image input as MULTIMODAL_ANALYSIS', () => {
    const c = classifyIntent({ text: 'what is this?', hasImage: true });
    expect(c.taskType).toBe(TaskType.MULTIMODAL_ANALYSIS);
    expect(c.capabilityHints.needsVision).toBe(true);
  });

  it('honors explicit needsImageGeneration hint', () => {
    const c = classifyIntent({ text: 'make a logo', capabilityHints: { needsImageGeneration: true } });
    expect(c.taskType).toBe(TaskType.IMAGE_GENERATION);
  });

  it('honors explicit taskTypeHint', () => {
    const c = classifyIntent({ text: 'code review please', taskTypeHint: TaskType.CODE_REVIEW });
    expect(c.taskType).toBe(TaskType.CODE_REVIEW);
  });

  it('detects CODING and SUMMARIZATION patterns', () => {
    expect(classifyIntent({ text: 'implement a login form in react' }).taskType).toBe(TaskType.CODING);
    expect(classifyIntent({ text: 'summarize the attached report' }).taskType).toBe(TaskType.SUMMARIZATION);
  });

  it('classifies general chat when no signal', () => {
    const c = classifyIntent({ text: 'tell me about your pronunciation' });
    expect(c.taskType).toBe(TaskType.GENERAL_CHAT);
  });

  it('never invokes a model — all classification is deterministic', () => {
    expect(gateway.eligibleModels).not.toHaveBeenCalled();
  });
});

describe('Model Routing 2026 — capability matrix', () => {
  it('derives capabilities from registry metadata without invention', () => {
    const caps = modelCapabilities(MODEL_GEMINI);
    expect(caps.vision).toBe(true);
    expect(caps.text).toBe(true);
    expect(caps.structuredOutput).toBe(true); // supportsFunctionCalling
  });

  it('external agent is autonomousAgent but not a streaming/image model', () => {
    const caps = modelCapabilities(MODEL_DEVIN);
    expect(caps.autonomousAgent).toBe(true);
    expect(caps.streaming).toBe(false);
    expect(caps.vision).toBe(false);
  });

  it('supportsRequiredCapabilities respects required leaves', () => {
    expect(supportsRequiredCapabilities(MODEL_GEMINI, { vision: true })).toBe(true);
    expect(supportsRequiredCapabilities(MODEL_GPT4O, { vision: true })).toBe(false);
    expect(supportsRequiredCapabilities(MODEL_MINIFLASH, { toolCalling: true })).toBe(true);
  });

  it('verified provider set covers z_code_5_3 (endpoint identity verified, Prompt 3); unverified set is empty', () => {
    // Prompt 3 outcome: z_code_5_3/ox_alpha/manus endpoint identity documented +
    // adapter-backed, so they are no longer UNVERIFIED. Real-call credential
    // status is tracked separately (providerKeySpec: KEY_INVALID/ENVIRONMENT_BLOCKED).
    expect(VERIFIED_PROVIDERS.has('z_code_5_3')).toBe(true);
    expect(UNVERIFIED_PROVIDERS.has('z_code_5_3')).toBe(false);
    expect(UNVERIFIED_PROVIDERS.size).toBe(0);
    expect(VERIFIED_PROVIDERS.has('anthropic')).toBe(true);
    expect(VERIFIED_PROVIDERS.has('ox_alpha')).toBe(true);
    expect(VERIFIED_PROVIDERS.has('manus')).toBe(true);
  });
});

describe('Model Routing 2026 — preference ranking', () => {
  const pool = [MODEL_MINIFLASH, MODEL_GPT4O, MODEL_OPUS, MODEL_SONNET];

  it('QUALITY prefers highest compute class then priority', () => {
    const r = rankByPreference(pool, RoutingPreference.QUALITY);
    expect(r[0]!.modelId).toBe(MODEL_OPUS.modelId);
  });

  it('COST_SAVER prefers cheapest capable model', () => {
    const r = rankByPreference(pool, RoutingPreference.COST_SAVER);
    expect(r[0]!.modelId).toBe(MODEL_MINIFLASH.modelId);
  });

  it('FAST prefers lowest latency then priority', () => {
    const r = rankByPreference(pool, RoutingPreference.FAST);
    expect(r[0]!.modelId).toBe(MODEL_MINIFLASH.modelId);
  });

  it('BALANCED and AUTO prefer registry priority then cost', () => {
    expect(rankByPreference(pool, RoutingPreference.BALANCED)[0]!.modelId).toBe(MODEL_OPUS.modelId);
    expect(rankByPreference(pool, RoutingPreference.AUTO)[0]!.modelId).toBe(MODEL_OPUS.modelId);
  });

  it('rankByPreference never mutates input', () => {
    const input = [...pool];
    rankByPreference(input, RoutingPreference.COST_SAVER);
    expect(input.map((m) => m.modelId)).toEqual(pool.map((m) => m.modelId));
  });
});

describe('Model Routing 2026 — planRoute decisions', () => {
  const USER = 'user-routing-test';

  beforeAll(() => void vi.clearAllMocks());
  afterAll(() => void vi.clearAllMocks());

  it('selects highest-ranked capable model and builds fallback chain', async () => {
    gateway.state.eligible = [MODEL_GPT4O, MODEL_SONNET, MODEL_MINIFLASH];
    const d = await planRoute({ userId: USER, text: 'write tests for the parser', routingPreference: RoutingPreference.AUTO });
    expect(d.selectedModel).toBe(MODEL_SONNET.modelId); // coding: true, priority 20
    expect(d.fallbackChain.length).toBeGreaterThanOrEqual(2);
    expect(d.reason).toContain('TEST_GENERATION');
  });

  it('honors a requested model id when it satisfies policy', async () => {
    gateway.state.eligible = [MODEL_GPT4O, MODEL_SONNET];
    const d = await planRoute({ userId: USER, text: 'summarize', requestedModelId: MODEL_GPT4O.modelId });
    expect(d.selectedModel).toBe(MODEL_GPT4O.modelId);
    expect(d.requestedModelHonored).toBe(true);
    expect(d.requestedModelSubstituted).toBe(false);
    expect(d.confidence).toBe('high');
  });

  it('substitutes when the requested model is unavailable and explains why', async () => {
    gateway.state.eligible = [MODEL_SONNET];
    const d = await planRoute({ userId: USER, text: 'summarize', requestedModelId: 'gpt-4o', routingPreference: RoutingPreference.AUTO });
    expect(d.selectedModel).toBe(MODEL_SONNET.modelId);
    expect(d.requestedModelHonored).toBe(false);
    expect(d.requestedModelSubstituted).toBe(true);
    expect(d.reason).toContain('Requested model unavailable');
  });

  it('returns an honest UNAVAILABLE decision when nothing is eligible', async () => {
    gateway.state.eligible = [];
    const d = await planRoute({ userId: USER, text: 'hello there', routingPreference: RoutingPreference.AUTO });
    expect(d.selectedModel).toBe('');
    expect(d.capabilityMatch).toBe(false);
    expect(d.healthState).toBe('UNAVAILABLE');
    expect(d.confidence).toBe('low');
  });

  it('filters models that lack required capabilities for MULTIMODAL_ANALYSIS', async () => {
    gateway.state.eligible = [MODEL_GPT4O, MODEL_GEMINI, MODEL_MINIFLASH];
    const d = await planRoute({ userId: USER, text: 'what is in this image?', intent: { text: 'what is in this image?', hasImage: true } });
    expect(d.selectedModel).toBe(MODEL_GEMINI.modelId); // only vision-capable eligible
    expect(d.reason).toContain('image/visual analysis');
  });

  it('never picks an external agent for a normal chat task', async () => {
    gateway.state.eligible = [MODEL_DEVIN, MODEL_GPT4O];
    const d = await planRoute({ userId: USER, text: 'hello there friend', routingPreference: RoutingPreference.AUTO });
    expect(d.selectedModel).toBe(MODEL_GPT4O.modelId);
  });

  it('allows external agents only for explicit autonomous engineering', async () => {
    gateway.state.eligible = [MODEL_DEVIN, MODEL_GPT4O];
    const d = await planRoute({ userId: USER, text: 'take over as an engineer', routingPreference: RoutingPreference.AUTO });
    expect(d.selectedModel).toBe(MODEL_DEVIN.modelId);
    expect(d.reason).toContain('autonomous');
  });

  it('selects vision model for image editing (explicit imageEditing registry flag)', async () => {
    gateway.state.eligible = [MODEL_GEMINI, MODEL_GPT4O];
    const d = await planRoute({ userId: USER, text: 'edit this image to remove the background' });
    // image editing requires imageEditing:true — only the Gemini image row flags it
    expect(d.selectedModel).toBe(MODEL_GEMINI.modelId);
  });

  it('image capabilities are EXPLICIT registry facts, never derived from the provider id', () => {
    // TEXT_PLUS_IMAGE / IMAGE_GENERATION capabilities come from registry flags;
    // a non-flagged Gemini text model must NOT claim image generation.
    const flagged = modelCapabilities(MODEL_GEMINI);
    expect(flagged.imageGeneration).toBe(false); // fixture only sets imageEditing
    expect(flagged.imageEditing).toBe(true);
    const img = modelCapabilities({ ...MODEL_GEMINI, imageGeneration: true });
    expect(img.imageGeneration).toBe(true);
    const textOnly = modelCapabilities(fixtureModel({ providerId: 'google', supportsVision: true }));
    expect(textOnly.imageGeneration).toBe(false);
    expect(textOnly.imageEditing).toBe(false);
  });

  it('computes estimatedCost only when input length is known (never fabricates pricing)', async () => {
    gateway.state.eligible = [MODEL_GPT4O];
    const noSize = await planRoute({ userId: USER, text: 'hello there' });
    expect(noSize.estimatedCost).toBeNull();
    const sized = await planRoute({ userId: USER, text: 'hello there', estimateInputTokens: 1_000_000 });
    expect(sized.estimatedCost).toBeCloseTo(MODEL_GPT4O.inputCostPerM, 6);
  });

  it('excludes DOWN/unenabled models like the z-code sentinel', async () => {
    gateway.state.eligible = [MODEL_ZCODE, MODEL_MINIFLASH];
    const d = await planRoute({ userId: USER, text: 'simple hello' });
    expect(d.selectedModel).toBe(MODEL_MINIFLASH.modelId);
  });

  it('produces a decision that never contains secrets or unsafe detail', async () => {
    gateway.state.eligible = [MODEL_GPT4O, MODEL_SONNET];
    const d = await planRoute({ userId: USER, text: 'hello there my friend', routingPreference: RoutingPreference.COST_SAVER });
    expect(d.reason).not.toMatch(/key|secret|credential|token|Bearer|api_key|sk-|cog_/i);
  });

  it('TERMINAL_EXECUTION policy is sensitive (no silent model switching path)', () => {
    expect(TASK_POLICY[TaskType.TERMINAL_EXECUTION].sensitive).toBe(true);
  });

  it('memory-aware routing raises the context floor for long-context models', async () => {
    // Gemini Pro has a 1M context; GPT-4o fixture has 128k. When the incoming
    // memory/context block needs more than 128k tokens, only long-context
    // models stay eligible.
    gateway.state.eligible = [MODEL_GPT4O, MODEL_GEMINI];
    const d = await planRoute({ userId: USER, text: 'summarize my notes', intent: { text: 'summarize my notes' }, minContextTokens: 200_000 });
    expect(d.selectedModel).toBe(MODEL_GEMINI.modelId);
  });

  it('autonomous task routing passes through the external-agent gate', async () => {
    gateway.state.eligible = [MODEL_DEVIN, MODEL_GPT4O, MODEL_SONNET];
    const d = await planRoute({
      userId: USER,
      text: 'implement the module on your own',
      taskType: TaskType.AUTONOMOUS_ENGINEERING,
      routingPreference: RoutingPreference.AUTO,
    });
    expect(d.selectedModel).toBe(MODEL_DEVIN.modelId);
    expect(d.features.autonomousAgent).toBe(true);
  });

  it('routing decision exposes honest audit-friendly fields', async () => {
    gateway.state.eligible = [MODEL_GPT4O, MODEL_SONNET];
    const d = await planRoute({ userId: USER, text: 'summarize the report', intent: { text: 'summarize the report' } });
    expect(d.taskType).toBe(TaskType.SUMMARIZATION);
    expect(d.selectedProvider).toBeTruthy();
    expect(typeof d.capabilityMatch).toBe('boolean');
    expect(typeof d.estimatedCost === 'number' || d.estimatedCost === null).toBe(true);
    expect(d.fallbackChain.length).toBeGreaterThan(0);
  });
});

describe('Model Routing 2026 — user routing preferences', () => {
  const USER = 'user-prefs-test';

  it('returns defaults when nothing stored', async () => {
    workspace.getPreferences.mockResolvedValue({});
    const prefs = await loadRoutingPreferences(USER);
    expect(prefs).toEqual(DEFAULT_ROUTING_PREFERENCES);
  });

  it('sanitizes a stored routing preference', async () => {
    workspace.getPreferences.mockResolvedValue({ aiRouting: { routingPreference: 'FAST', preferredModelId: 'claude-sonnet' } });
    const prefs = await loadRoutingPreferences(USER);
    expect(prefs.routingPreference).toBe(RoutingPreference.FAST);
    expect(prefs.preferredModelId).toBe('claude-sonnet');
  });

  it('never accepts an invalid routing preference value', () => {
    expect(isRoutingPreferenceValue('SUPER_FAST')).toBe(false);
    expect(isRoutingPreferenceValue(RoutingPreference.COST_SAVER)).toBe(true);
  });

  it('clears preferred model with null', async () => {
    workspace.getPreferences.mockResolvedValue({ aiRouting: { routingPreference: 'AUTO', preferredModelId: 'gpt-4o' } });
    const prefs = await saveRoutingPreferences(USER, { preferredModelId: null });
    expect(prefs.preferredModelId).toBeNull();
    expect(workspace.updatePreferences).toHaveBeenCalled();
  });
});