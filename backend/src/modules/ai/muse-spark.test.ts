/**
 * CodeConClave — Meta Muse Spark provider contract suite.
 *
 * Covers the opt-in Muse Spark integration through the ONE existing
 * ProviderAdapter abstraction + gateway rails. Every network call is mocked —
 * no Meta API is contacted, nothing billable runs. A genuine smoke test with
 * real credentials is deliberately NOT part of this suite (see
 * MUSE_SPARK_HYBRID_COWORKER_FINAL_REPORT.md for the authorized procedure).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ---- env mock: mutable flag + key -------------------------------------------
const envState = vi.hoisted(() => ({
  current: {
    MUSE_SPARK_API_KEY: undefined as string | undefined,
    MUSE_SPARK_ENABLED: 'false' as string,
    ANTHROPIC_WORKSPACE_ID: undefined as string | undefined,
    AI_REQUEST_TIMEOUT_MS: 120_000,
    AI_CHAIN_TIMEOUT_MS: 180_000,
  },
}));
vi.mock('../../config/env.js', () => ({
  env: envState.current,
  enabledProviders: ['muse_spark', 'openai'],
}));

vi.mock('../../shared/db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() },
}));
vi.mock('../../shared/cache.js', () => ({
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
}));
vi.mock('../workspace/service.js', () => ({
  getPreferences: async () => ({}),
  updatePreferences: async () => ({}),
}));

import {
  getAdapter,
  museSparkEnabled,
  classifyProviderError,
  deriveStatusFromFailure,
  MUSE_SPARK_DEFAULT_MODEL,
} from './providers.js';
import { configuredProviders } from './registry.js';
import { providerKeyState } from './providerKeySpec.js';
import { AppError } from '../../shared/errors.js';

// ---- fetch mock --------------------------------------------------------------
type Call = { url: string; headers: Record<string, string>; body: unknown };
const fetchCalls: Call[] = [];
const scripts: Record<string, () => Response | Promise<Response>> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  fetchCalls.push({
    url,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const script = scripts[url];
  if (script) return script();
  return new Response('{"error":"no script"}', { status: 500 });
});
vi.stubGlobal('fetch', fetchMock);

function sseResponse(lines: string[], status = 200, headers: Record<string, string> = {}): Response {
  return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), { status, headers });
}

const SPARK_URL = 'https://api.meta.ai/v1/chat/completions';

beforeEach(() => {
  envState.current.MUSE_SPARK_ENABLED = 'false';
  envState.current.MUSE_SPARK_API_KEY = undefined;
});
afterEach(() => {
  fetchCalls.length = 0;
  for (const k of Object.keys(scripts)) delete scripts[k];
});

describe('Muse Spark — feature flag gate (default OFF)', () => {
  it('is disabled by default', () => {
    expect(museSparkEnabled()).toBe(false);
  });

  it('reports CONFIGURATION REQUIRED with no network call when the flag is off', async () => {
    envState.current.MUSE_SPARK_API_KEY = 'test-spark-key-abc123';
    let err: unknown;
    try {
      getAdapter('muse_spark', MUSE_SPARK_DEFAULT_MODEL);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ errorCode: 'provider_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it('reports CONFIGURATION REQUIRED when the flag is on but no key is set', () => {
    envState.current.MUSE_SPARK_ENABLED = 'true';
    let err: unknown;
    try {
      getAdapter('muse_spark', MUSE_SPARK_DEFAULT_MODEL);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ errorCode: 'provider_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('configuredProviders() excludes muse_spark while the flag is off (default routing unchanged)', () => {
    envState.current.MUSE_SPARK_API_KEY = 'test-spark-key-abc123';
    expect(configuredProviders()).not.toContain('muse_spark');
  });

  it('status key state is MISSING_KEY without credentials (never CONNECTED)', () => {
    expect(providerKeyState('muse_spark')).toBe('MISSING_KEY');
  });
});

describe('Muse Spark — enabled path (mocked HTTP)', () => {
  beforeEach(() => {
    envState.current.MUSE_SPARK_ENABLED = 'true';
    envState.current.MUSE_SPARK_API_KEY = 'test-spark-key-abc123';
  });

  it('constructs an adapter for the default model muse-spark-1.3', () => {
    expect(MUSE_SPARK_DEFAULT_MODEL).toBe('muse-spark-1.3');
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    expect(adapter.providerId).toBe('muse_spark');
    expect(adapter.supportsToolCalls).toBe(true);
  });

  it('configuredProviders() includes muse_spark only when flag + key + allow-list align', () => {
    expect(configuredProviders()).toContain('muse_spark');
  });

  it('streams text via POST /chat/completions with Bearer auth and usage reporting', async () => {
    scripts[SPARK_URL] = () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }], usage: { prompt_tokens: 12 } }),
        JSON.stringify({ choices: [{ delta: { content: ' world' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      ]);
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    let text = '';
    let inputTokens = 0;
    for await (const chunk of adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })) {
      text += chunk.delta;
      inputTokens = chunk.inputTokens ?? inputTokens;
    }
    expect(text).toBe('Hello world');
    expect(inputTokens).toBe(12);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(SPARK_URL);
    expect(fetchCalls[0]!.headers.authorization).toBe('Bearer test-spark-key-abc123');
    const body = fetchCalls[0]!.body as Record<string, unknown>;
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('maps 429 + Retry-After to rate_limited with the retry hint preserved', async () => {
    scripts[SPARK_URL] = () => new Response('{"error":{"message":"rate limit","type":"rate_limit"}}', { status: 429, headers: { 'retry-after': '7' } });
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    let err: unknown;
    try {
      for await (const _ of adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })) {
        /* drain */
      }
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ errorCode: 'rate_limited' });
    expect(classifyProviderError(err)).toBe('rate_limited');
    expect(deriveStatusFromFailure(err)).toBe('RATE_LIMITED');
    expect((err as AppError).details).toMatchObject({ retryAfterSec: 7 });
  });

  it('maps 401 to invalid_credentials (no retry, no fabrication)', async () => {
    scripts[SPARK_URL] = () => new Response('{"error":{"message":"invalid key"}}', { status: 401 });
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    let err: unknown;
    try {
      for await (const _ of adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })) {
        /* drain */
      }
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ errorCode: 'invalid_credentials' });
    expect(classifyProviderError(err)).toBe('invalid_credentials');
    expect(deriveStatusFromFailure(err)).toBe('REQUIRES_REAUTH');
  });

  it('never swallows an HTTP-200 non-SSE error body as a success', async () => {
    scripts[SPARK_URL] = () => new Response('{"error":{"message":"billing exceeded"}}', { status: 200 });
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    let err: unknown;
    try {
      for await (const _ of adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })) {
        /* drain */
      }
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ errorCode: 'provider_error' });
  });

  it('propagates caller abort (long-request cancellation) without fabrication', async () => {
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    const controller = new AbortController();
    controller.abort('cancelled');
    let err: unknown;
    try {
      for await (const _ of adapter.complete({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal)) {
        /* drain */
      }
    } catch (e) {
      err = e;
    }
    expect(err instanceof Error && err.name).toBe('AbortError');
    expect(classifyProviderError(err, true)).toBe('timeout');
  });

  it('key state with credentials but no real call is UNVERIFIED (honest, not CONNECTED)', async () => {
    // providerKeySpec snapshots keys at module load, so re-import with the
    // test key present to exercise the with-credentials branch honestly.
    envState.current.MUSE_SPARK_API_KEY = 'test-spark-key-abc123';
    vi.resetModules();
    const fresh = await import('./providerKeySpec.js');
    expect(fresh.providerKeyState('muse_spark')).toBe('UNVERIFIED');
  });

  it('never leaks the API key into thrown error messages', async () => {
    scripts[SPARK_URL] = () => new Response('boom', { status: 500 });
    const adapter = getAdapter('muse_spark', 'muse-spark-1.3');
    let err: unknown;
    try {
      for await (const _ of adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })) {
        /* drain */
      }
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).not.toContain('test-spark-key-abc123');
    expect(JSON.stringify((err as AppError).details ?? {})).not.toContain('test-spark-key-abc123');
  });
});
