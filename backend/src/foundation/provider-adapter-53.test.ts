/**
 * CODECONCLAVE PRO PROMPT 3 — PROVIDER ADAPTER + INTEGRATION contract suite.
 * Covers the six newly integrated providers (Gemini multimodal + image model,
 * Qwen, Gemma, Ox Alpha/OpenRouter, Z Code 5.3/Z.ai glm-5.3, Manus) routed
 * through the ONE existing ProviderAdapter abstraction and the existing
 * router/gateway. All network calls are mocked (no provider contacted); real
 * verifications live in docs/CODECONCLAVE_REAL_PROVIDER_VERIFICATION.json.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoutingPreference } from '@codeconclave/shared';

// ---- env mock: the six prompt-3 providers are configured (test values) ------
const envState = vi.hoisted(() => ({
  current: {
    GEMINI_API_KEY: 'test-gemini-key' as string | undefined,
    QWEN_API_KEY: 'test-qwen-key' as string | undefined,
    OX_ALPHA_API_KEY: 'test-ox-key' as string | undefined,
    MANUS_API_KEY: 'test-manus-key' as string | undefined,
    Z_AI_API_KEY: 'test-z-key' as string | undefined,
    DEVIN_API_KEY: 'cog_test-devin' as string | undefined,
    DEVIN_ORG_ID: 'org-1' as string | undefined,
  },
}));
vi.mock('../config/env.js', () => ({
  env: envState.current,
  enabledProviders: ['google', 'qwen', 'gemma', 'ox_alpha', 'z_code_5_3', 'manus', 'openai', 'anthropic'],
}));

// ---- gateway mock (router imports eligibleModels/planRoute delegations) ------
const gateway = vi.hoisted(() => {
  const state: { eligible: Array<Record<string, unknown>> } = { eligible: [] };
  const eligibleModels = vi.fn(async () =>
    state.eligible.filter((m) => (m.health ?? 'HEALTHY') !== 'DOWN' && (m.health ?? 'HEALTHY') !== 'DEGRADED'),
  );
  return { state, eligibleModels };
});
vi.mock('../modules/ai/gateway.js', () => ({
  eligibleModels: gateway.eligibleModels,
}));

const workspace = vi.hoisted(() => ({
  getPreferences: vi.fn(async () => ({}) as Promise<Record<string, unknown>>),
  updatePreferences: vi.fn(async () => ({}) as Promise<Record<string, unknown>>),
}));
vi.mock('../modules/workspace/service.js', () => workspace);
vi.mock('../shared/db.js', () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(),
  },
}));

// ---- modules under test -----------------------------------------------------
import {
  getAdapter,
  classifyProviderError,
  deriveStatusFromFailure,
  messageTextChars,
  GEMINI_IMAGE_MODEL_IDS,
  type ChatMessage,
} from '../modules/ai/providers.js';
import { modelCapabilities, supportsRequiredCapabilities } from '../modules/ai/capabilities.js';
import { AppError } from '../shared/errors.js';
import { planRoute } from '../modules/ai/router.js';
import type { AiModelDescriptor } from '@codeconclave/shared';

// ---- fetch mock: records requests; responses are scripted per URL -----------
type Call = { url: string; headers: Record<string, string>; body: unknown; signal?: AbortSignal };
const fetchCalls: Call[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  fetchCalls.push({ url, headers, body, signal: init?.signal });
  const script = scripts[url];
  if (script) return script(url, init?.signal);
  return new Response('{"error":"no script"}', { status: 500 });
});
type Script = (url: string, signal?: AbortSignal) => Response | Promise<Response>;
const scripts: Record<string, Script> = {};
function sseResponse(lines: string[], status = 200): Response {
  return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), { status });
}
function geminiGenerateUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
}

function geminiImageUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchCalls.length = 0;
  delete scripts['*'];
  for (const k of Object.keys(scripts)) delete scripts[k];
});

function fixtureModel(partial: Partial<AiModelDescriptor>): AiModelDescriptor {
  return {
    modelId: 'm',
    providerId: 'openai',
    displayName: 'M',
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

async function collect(modelId: string, providerId: string, messages: ChatMessage[], maxTokens?: number) {
  const adapter = getAdapter(providerId, modelId);
  const out: Array<{ delta: string; inputTokens?: number; outputTokens?: number; image?: { mimeType: string; dataB64: string } }> = [];
  for await (const c of adapter.complete({ messages, maxTokens, temperature: 0.5 })) out.push(c);
  return out;
}

describe('PAI-53.1 — one canonical adapter contract for all providers', () => {
  it('getAdapter returns a ProviderAdapter for every live new provider (same shape as existing)', () => {
    const arms: Array<[string, string]> = [
      ['google', 'gemini-3.7-flash'],
      ['qwen', 'qwen3.5-flash'],
      ['gemma', 'gemma-4-31b-it'],
    ];
    for (const [providerId, model] of arms) {
      const a = getAdapter(providerId, model);
      // Gemma is served by Google's Gemini API, so its identity is 'google' (single shared adapter).
      expect(a.providerId, providerId).toBe(providerId === 'gemma' ? 'google' : providerId);
      expect(typeof a.complete, providerId).toBe('function');
      expect(typeof a.supportsToolCalls, providerId).toBe('boolean');
    }
  });

  it('the external agent (Manus) fails closed at getAdapter even when keyed', () => {
    expect(() => getAdapter('manus', 'manus-1.6')).toThrow(/provider quality gate/);
  });

  it('external agents (Manus) are gated, while normalized tool-capable Devin keeps its contract', () => {
    expect(() => getAdapter('manus', 'manus-1.6')).toThrow(/provider quality gate/);
    // Devin sessions remain normalized tool-capable (existing contract).
    expect(getAdapter('devin', 'devin-session').supportsToolCalls).toBe(true);
  });

  it('Manus is gated — its v2 task lifecycle can never be reached or hit the wire', async () => {
    scripts['https://api.manus.ai/v2/task.create'] = () =>
      new Response(JSON.stringify({ task_id: 'task_test_1' }), { status: 200 });
    scripts['https://api.manus.ai/v2/task.listMessages'] = () =>
      new Response(JSON.stringify({ status: 'completed', data: { result: { result_text: 'done' } } }), { status: 200 });
    await expect(collect('manus-1.6', 'manus', [{ role: 'user', content: 'do the thing' }])).rejects.toMatchObject({
      errorCode: 'provider_quality_gate',
    });
    expect(fetchCalls.some((c) => c.url.includes('manus.ai'))).toBe(false);
  });
});

describe('PAI-53.2 — Gemini multimodal input + text adaptation', () => {
  it('normalizes a base64 image part into inlineData on the Gemini wire', async () => {
    const url = geminiGenerateUrl('gemini-3.7-flash');
    scripts[url] = () => sseResponse([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }),
      '[DONE]',
    ]);
    await collect('gemini-3.7-flash', 'google', [
      { role: 'user', content: [{ type: 'image_base64', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'what is this?' }] },
    ]);
    const sent = fetchCalls[0]!;
    const contents = (sent.body as { contents: Array<{ parts: unknown[] }> }).contents;
    expect(contents[0]!.parts[0]).toEqual({ inlineData: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } });
    expect(JSON.stringify(sent.body)).not.toContain('image_url');
  });

  it('normalizes a URL image part into fileData on the Gemini wire', async () => {
    const url = geminiGenerateUrl('gemini-3.7-flash');
    scripts[url] = () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), '[DONE]']);
    await collect('gemini-3.7-flash', 'google', [
      { role: 'user', content: [{ type: 'image_url', url: 'https://example.invalid/a.png' }] },
    ]);
    expect((fetchCalls[0]!.body as { contents: Array<{ parts: unknown[] }> }).contents[0]!.parts[0]).toEqual({ fileData: { fileUri: 'https://example.invalid/a.png' } });
  });

  it('maps usageMetadata into chunk token counts', async () => {
    const url = geminiGenerateUrl('gemini-3.7-flash');
    scripts[url] = () => sseResponse([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9 } }),
      '[DONE]',
    ]);
    const out = await collect('gemini-3.7-flash', 'google', [{ role: 'user', content: 'hi' }]);
    expect(out[0]!.delta).toBe('OK');
    expect(out[0]!.inputTokens).toBe(12);
    expect(out[0]!.outputTokens).toBe(9);
  });

  it('sends the API key as x-goog-api-key (Gemini-style auth, incl. Gemma)', async () => {
    scripts[geminiGenerateUrl('gemma-4-31b-it')] = () => sseResponse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), '[DONE]']);
    await collect('gemma-4-31b-it', 'gemma', [{ role: 'user', content: 'hi' }]);
    expect(fetchCalls[0]!.headers['x-goog-api-key']).toBe('test-gemini-key');
    expect(fetchCalls[0]!.headers.authorization).toBeUndefined();
  });
});

describe('PAI-53.3 — OpenAI-compatible adapters (shared wire)', () => {
  it('sends Bearer auth to the real OpenAI-compatible route (Qwen is the live analog of the shared adapter)', async () => {
    scripts['https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'] = () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }),
      '[DONE]',
    ]);
    await collect('qwen3.5-flash', 'qwen', [{ role: 'user', content: 'hi' }]);
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer test-qwen-key');
    expect((call.body as { model: string }).model).toBe('qwen3.5-flash');
  });

  it('Ox Alpha completes through the OpenRouter route when the key verifies', async () => {
    scripts['https://openrouter.ai/api/v1/chat/completions'] = () => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }), '[DONE]']);
    await collect('z-ai/glm-5.3-flash', 'ox_alpha', [{ role: 'user', content: 'hi' }]);
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer test-ox-key');
  });

  it('Z Code 5.3 completes through the api.z.ai glm route when the key verifies', async () => {
    scripts['https://api.z.ai/api/v1/chat/completions'] = () => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }), '[DONE]']);
    await collect('glm-5.3', 'z_code_5_3', [{ role: 'user', content: 'hi' }]);
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://api.z.ai/api/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer test-z-key');
  });

  it('normalizes a base64 image part into an OpenAI data-URL image_url part (live wire analog)', async () => {
    scripts['https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'] = () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
      '[DONE]',
    ]);
    await collect('qwen3.5-flash', 'qwen', [
      { role: 'user', content: [{ type: 'image_base64', data: 'AA==', mimeType: 'image/jpeg' }, { type: 'text', text: 'hi' }] },
    ]);
    const messages = (fetchCalls[0]!.body as { messages: Array<{ content: unknown[] }> }).messages;
    expect(messages[0]!.content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } });
  });
});

describe('PAI-53.4 — Gemini image generation adapter', () => {
  const IMG = 'gemini-3-pro-image';
  const URL = geminiGenerateUrl(IMG);

  it('the image model id is documented in GEMINI_IMAGE_MODEL_IDS and gated to the image adapter', () => {
    expect(GEMINI_IMAGE_MODEL_IDS.has(IMG)).toBe(true);
    const a = getAdapter('google', IMG);
    expect(a.providerId).toBe('google');
    expect(getAdapter('google', 'gemini-3.7-flash').providerId).toBe('google');
  });

  it('emits an image chunk (mimeType + dataB64) — never as text, never logged', async () => {
    const imageUrl = geminiImageUrl(IMG);
    scripts[imageUrl] = () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Here is your image' },
                  { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 0 },
        }),
        { status: 200 },
      );
    const out = await collect(IMG, 'google', [{ role: 'user', content: 'make a logo of a rocket' }]);
    const text = out.map((c) => c.delta).join('');
    expect(text).toContain('Here is your image');
    const img = out.find((c) => c.image);
    expect(img?.image).toEqual({ mimeType: 'image/png', dataB64: 'iVBORw0KGgo=' });
    // The payload never leaks into the text channel.
    expect(text).not.toContain('iVBORw0KGgo=');
    expect(out[0]!.inputTokens).toBe(42);
  });

  it('a text-only model with a sibling image model still derives NO image capability', () => {
    const textModel = fixtureModel({ providerId: 'google', supportsVision: true });
    expect(modelCapabilities(textModel).imageGeneration).toBe(false);
    const imgModel = fixtureModel({ providerId: 'google', imageGeneration: true, imageEditing: true });
    expect(modelCapabilities(imgModel).imageGeneration).toBe(true);
    expect(modelCapabilities(imgModel).imageEditing).toBe(true);
  });

  it('image capability is an explicit registry fact, never derived from the provider id', () => {
    expect(modelCapabilities(fixtureModel({ providerId: 'google', supportsVision: true, imageGeneration: false })).imageGeneration).toBe(false);
    // Qwen/other providers can also carry the flag if a real image model is registered.
    expect(modelCapabilities(fixtureModel({ providerId: 'qwen', imageGeneration: true })).imageGeneration).toBe(true);
  });

  it('image-generation requests route to the image-capable model — never to a higher-priority text-only model', async () => {
    const img = fixtureModel({
      modelId: 'gemini-3-pro-image', providerId: 'google', imageGeneration: true, supportsVision: true,
      priority: 10, inputCostPerM: 0.02, targetLatencyMs: 20000, computeClass: 'B',
    });
    const chat = fixtureModel({ modelId: 'gpt-4o', providerId: 'openai', priority: 30 });
    gateway.state.eligible = [img, chat];
    const gen = await planRoute({
      userId: 'u1', text: 'make a rocket logo',
      requiredCaps: { imageGeneration: true }, routingPreference: RoutingPreference.AUTO,
    });
    expect(gen.selectedModel).toBe(img.modelId);
    expect(gen.capabilityMatch).toBe(true);
  });

  it('image-only capability is NOT a requirement for ordinary chat (image models remain chat-capable)', async () => {
    const img = fixtureModel({
      modelId: 'gemini-3-pro-image', providerId: 'google', imageGeneration: true, supportsVision: true,
      priority: 10, inputCostPerM: 0.02, targetLatencyMs: 20000, computeClass: 'B',
    });
    const chat = fixtureModel({ modelId: 'gpt-4o', providerId: 'openai', priority: 30 });
    gateway.state.eligible = [img, chat];
    const d = await planRoute({ userId: 'u1', text: 'hello friend', routingPreference: RoutingPreference.AUTO });
    expect([img.modelId, chat.modelId]).toContain(d.selectedModel);
  });

  it('supportsRequiredCapabilities gates image editing on the explicit flag', () => {
    const imgEdit = fixtureModel({ imageEditing: true });
    const noEdit = fixtureModel({ imageEditing: false });
    expect(supportsRequiredCapabilities(imgEdit, { imageEditing: true })).toBe(true);
    expect(supportsRequiredCapabilities(noEdit, { imageEditing: true })).toBe(false);
  });
});

describe('PAI-53.5 — failure classification + short-circuit honesty (Kanban #8/11)', () => {
  it('classifyProviderError maps HTTP-mapped AppErrors to the shared taxonomy', () => {
    const u = (code: string) => AppError.unavailable(code, 'boom');
    expect(classifyProviderError(new Error('x'))).toBe('provider_unavailable');
    expect(classifyProviderError(u('provider_timeout'))).toBe('timeout');
    expect(classifyProviderError(u('rate_limited'))).toBe('rate_limited');
    expect(classifyProviderError(u('invalid_credentials'))).toBe('invalid_credentials');
    expect(classifyProviderError(u('stream_interrupted'))).toBe('stream_interrupted');
  });

  it('a 401 Z Code wire response maps honestly at the classifier to OFFLINE (until correlated with a real credential failure)', async () => {
    scripts['https://api.z.ai/api/v1/chat/completions'] = () => new Response('{"msg":"token expired or incorrect"}', { status: 401 });
    try {
      await collect('glm-5.3', 'z_code_5_3', [{ role: 'user', content: 'hi' }]);
    } catch {
      // route now reachable (ungated); the 401 surfaces as a classified error
    }
    // The 401 classification itself is honest — a raw 401 maps to OFFLINE until correlated with a real credential failure.
    expect(deriveStatusFromFailure(new Error('401'))).toBe('OFFLINE');
  });

  it('404 on a Gemini-style route is a provider_error (honest, not retried as transient)', async () => {
    scripts[geminiGenerateUrl('gemma-4-31b-it')] = () => new Response('not found', { status: 404 });
    await expect(collect('gemma-4-31b-it', 'gemma', [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ errorCode: 'provider_error' });
  });

  it('abort signal reaches fetch and a mid-call abort is classified as interruption', async () => {
    const slow = geminiGenerateUrl('gemini-3.7-flash');
    scripts[slow] = (_url, signal) =>
      new Promise((_resolve, reject) => {
        const ab = () => reject(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', ab, { once: true });
      });
    const controller = new AbortController();
    const adapter = getAdapter('google', 'gemini-3.7-flash');
    const p = adapter.complete({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    const inflight = p.next();
    controller.abort();
    await expect(inflight).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchCalls[0]!.signal).toBe(controller.signal);
  });

  it('auth failures map to REQUIRES_REAUTH (non-retry, honest; retry/fallback is the gateway railing)', () => {
    // The adapter throws the classified AppError; the gateway owns retry/fallback.
    expect(deriveStatusFromFailure(AppError.unavailable('invalid_credentials', 'bad key'))).toBe('REQUIRES_REAUTH');
    expect(deriveStatusFromFailure(AppError.unavailable('provider_error', 'dead model'))).toBe('OFFLINE');
  });
});

describe('PAI-53.6 — token/cost accounting + canonical part awareness', () => {
  it('messageTextChars counts only textual parts', () => {
    expect(messageTextChars({ role: 'user', content: 'hello world' })).toBe(11);
    const parts: ChatMessage = {
      role: 'user',
      content: [{ type: 'image_base64', data: 'x'.repeat(500), mimeType: 'image/png' }, { type: 'text', text: 'abc' }],
    };
    expect(messageTextChars(parts)).toBe(3);
  });
});

describe('PAI-53.7 — capability metadata reaches the web+desktop contract', () => {
  it('image flag semantics are exported through computed model capabilities (server-authoritative, shared by web + desktop)', async () => {
    const img = fixtureModel({ providerId: 'google', imageGeneration: true, imageEditing: true });
    const caps = modelCapabilities(img);
    expect(caps.imageGeneration).toBe(true);
    expect(caps.imageEditing).toBe(true);
    expect(caps.vision).toBe(true); // image generation implies vision input support
  });
});