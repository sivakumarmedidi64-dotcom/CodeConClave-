/**
 * CODECONCLAVE PRO PROMPT 5 — PROVIDER AUDIT contract suite (inert).
 * Covers the honest-failure behaviors introduced in the final provider audit:
 *   (a) HTTP 402 is classified as billing quota exhaustion (DeepSeek
 *       "Insufficient Balance"); (b) OpenAI-compatible adapters surface an
 *       empty HTTP 200 completion as an explicit provider error instead of
 *       swallowing a Z.ai-style 200-with-JSON-error body as a silent success;
 *   (c) Anthropic requests carry the optional anthropic-workspace-id header
 *       when ANTHROPIC_WORKSPACE_ID is configured; (d) a healthy streamed
 *       chunk still passes through (no regression against the guard).
 * No provider is contacted and db/cache are inert — fetch is always mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from '../config/env.js';
import { getAdapter, deriveStatusFromFailure, classifyProviderError } from '../modules/ai/providers.js';

const ORIG = {
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  ANTHROPIC_WORKSPACE_ID: env.ANTHROPIC_WORKSPACE_ID,
  DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
  QWEN_API_KEY: env.QWEN_API_KEY,
};

// The Qwen empty-200 classification tests exercise REAL adapter construction
// (fetch is mocked, so no provider is contacted), which requires Qwen to be
// configured. When Qwen is unconfigured the adapter throws before reaching the
// mocked fetch, so the empty-completion guard is untestable — those tests are
// skipped rather than fabricating a credential.
const HAS_QWEN = Boolean(ORIG.QWEN_API_KEY && ORIG.QWEN_API_KEY.trim().length >= 20);

afterEach(() => {
  env.ANTHROPIC_API_KEY = ORIG.ANTHROPIC_API_KEY;
  env.ANTHROPIC_WORKSPACE_ID = ORIG.ANTHROPIC_WORKSPACE_ID;
  env.DEEPSEEK_API_KEY = ORIG.DEEPSEEK_API_KEY;
  env.QWEN_API_KEY = ORIG.QWEN_API_KEY;
  vi.restoreAllMocks();
});

async function collect(providerId: string, model: string, messages: unknown, maxTokens = 16) {
  const chunks: string[] = [];
  for await (const c of getAdapter(providerId, model).complete(
    { messages: messages as never, maxTokens },
    undefined,
  )) {
    if (c.delta) chunks.push(c.delta);
  }
  return chunks;
}

describe('PVA-55.1 HTTP 402 is honest billing classification', () => {
  it('classifies a DeepSeek-style 402 Insufficient Balance as billing (QUOTA_EXHAUSTED)', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    env.DEEPSEEK_API_KEY = ORIG.DEEPSEEK_API_KEY || 'sk-ds-test-123456789';
    let thrown: unknown;
    try {
      await collect('deepseek', 'deepseek-v4-flash', [{ role: 'user', content: 'hi' }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(classifyProviderError(thrown)).toBe('billing');
    expect(deriveStatusFromFailure(thrown)).toBe('QUOTA_EXHAUSTED');
  });
});

describe('PVA-55.2 empty HTTP 200 completion is an explicit failure, not a silent success', () => {
  it.runIf(HAS_QWEN)('Z.ai-style 200 + non-SSE JSON error body -> provider_error (no fabrication)', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response('{"code":401,"msg":"token expired or incorrect","success":false}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    env.QWEN_API_KEY = ORIG.QWEN_API_KEY;
    let thrown: unknown;
    try {
      await collect('qwen', 'qwen3.7-plus', [{ role: 'user', content: 'hi' }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { message: string }).message).toContain('empty completion');
    expect(classifyProviderError(thrown)).toBe('provider_unavailable');
  });

  it('[DONE]-only empty stream -> provider_error', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response('data: [DONE]\n\n', { status: 200 }),
    );
    env.DEEPSEEK_API_KEY = ORIG.DEEPSEEK_API_KEY || 'sk-ds-test-123456789';
    await expect(
      collect('deepseek', 'deepseek-v4-flash', [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/empty completion/);
  });

  it.runIf(HAS_QWEN)('a healthy streamed chunk passes through (guard does not trip on real output)', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
    );
    env.QWEN_API_KEY = ORIG.QWEN_API_KEY;
    const chunks = await collect('qwen', 'qwen3.7-plus', [{ role: 'user', content: 'hi' }]);
    expect(chunks).toEqual(['OK']);
  });
});

describe('PVA-55.3 optional anthropic-workspace-id header', () => {
  const SSE_OK =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n';

  async function probe(withWorkspace: boolean): Promise<Array<string>> {
    const prev = { A: process.env.ANTHROPIC_API_KEY, W: process.env.ANTHROPIC_WORKSPACE_ID };
    const seen: Array<string> = [];
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-apikey-long-enough-1234567890';
      if (withWorkspace) process.env.ANTHROPIC_WORKSPACE_ID = 'ws_123';
      else delete process.env.ANTHROPIC_WORKSPACE_ID;
      vi.resetModules();
      const prov = await import('../modules/ai/providers.js');
      void prov;
      spy = vi.spyOn(globalThis, 'fetch' as never).mockImplementation(async (_url: never, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        seen.push(h['anthropic-workspace-id'] ?? 'MISSING');
        return new Response(SSE_OK, { status: 200 });
      });
      for await (const c of prov
        .getAdapter('anthropic', 'claude-haiku-4-5')
        .complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }, undefined)) {
        void c;
      }
      return seen;
    } finally {
      spy?.mockRestore();
      if (prev.A !== undefined) process.env.ANTHROPIC_API_KEY = prev.A;
      else delete process.env.ANTHROPIC_API_KEY;
      if (prev.W !== undefined) process.env.ANTHROPIC_WORKSPACE_ID = prev.W;
      else delete process.env.ANTHROPIC_WORKSPACE_ID;
      vi.resetModules();
    }
  }

  it('adds the header only when ANTHROPIC_WORKSPACE_ID is configured', async () => {
    expect(await probe(true)).toEqual(['ws_123']);
  });

  it('omits the header when not configured', async () => {
    expect(await probe(false)).toEqual(['MISSING']);
  });
});