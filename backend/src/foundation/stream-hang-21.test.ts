/**
 * CodeConClave — Stage 21 stream-hang regression tests.
 * Verifies the deterministic termination guarantees for AI generation:
 * - a hanging provider attempt is aborted by a REAL timeout and the chain
 *   fails honestly with the timeout reason (never an open stream);
 * - the chain deadline bounds the TOTAL generation time over all attempts;
 * - rate-limited providers exhaust a finite chain and surface retry guidance;
 * - billing failures are classified billing with no infinite retry;
 * - the SSE stream closes on error, on client disconnect, on deadline, and
 *   after deep-work completion — it is never left open indefinitely.
 * Registry + DB + provider adapters are mocked; no provider is hit.
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

const registry = vi.hoisted(() => ({
  getRegistry: vi.fn(async () => [] as unknown[]),
  configuredProviders: vi.fn(() => ['openai']),
  getModel: vi.fn(async () => {
    throw new Error('not used in these tests');
  }),
}));
vi.mock('../modules/ai/registry.js', () => registry);

const providers = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  updateProviderHealth: vi.fn(async () => {}),
}));
vi.mock('../modules/ai/providers.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/ai/providers.js')>();
  return { ...mod, getAdapter: providers.getAdapter, updateProviderHealth: providers.updateProviderHealth };
});

import { completeWithFallback, type CompleteOptions } from '../modules/ai/gateway.js';
import { classifyProviderError, type ProviderAdapter } from '../modules/ai/providers.js';
import { handleChatStream } from '../modules/conversations/routes.js';
import { AppError } from '../shared/errors.js';
import type { AiModelDescriptor } from '@codeconclave/shared';

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

/** Adapter that only settles when its signal aborts — simulates a provider hang. */
function hangAdapter(modelId: string): ProviderAdapter {
  return {
    providerId: 'openai',
    supportsToolCalls: true,
    async *complete(_req, signal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
}

function mockPlan(plan: 'free' | 'pro') {
  db.state.resolve = (text) => (text.includes('SELECT plan_id FROM users') ? [{ plan_id: plan }] : null);
}

const baseOptions = (): CompleteOptions => ({
  ctx: { userId: 'u1', sessionId: 's1', planId: 'pro' },
  messages: [{ role: 'user', content: 'hello' }],
});

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  vi.mocked(registry.getRegistry).mockClear();
  vi.mocked(registry.configuredProviders).mockClear();
  vi.mocked(registry.configuredProviders).mockReturnValue(['openai']);
  vi.mocked(providers.getAdapter).mockClear();
  vi.mocked(providers.updateProviderHealth).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyProviderError — billing taxonomy', () => {
  it('maps provider_billing to the billing reason', () => {
    expect(classifyProviderError(AppError.unavailable('provider_billing', 'billing quota exhausted'))).toBe('billing');
  });

  it('keeps rate_limited, timeout and credentials stable', () => {
    expect(classifyProviderError(AppError.unavailable('rate_limited', 'rl'))).toBe('rate_limited');
    const timedOut = new Error('aborted');
    timedOut.name = 'AbortError';
    expect(classifyProviderError(timedOut, true)).toBe('timeout');
    expect(classifyProviderError(timedOut, false)).toBe('stream_interrupted');
    expect(classifyProviderError(AppError.unavailable('invalid_credentials', 'ic'))).toBe('invalid_credentials');
  });
});

describe('completeWithFallback — deterministic termination', () => {
  it('a hanging provider is aborted by the attempt timeout and the chain fails honestly', async () => {
    vi.useFakeTimers();
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([model('hang-1')]);
    vi.mocked(providers.getAdapter).mockImplementation((_providerId, modelId) => hangAdapter(modelId));
    const promise = completeWithFallback(baseOptions());
    const outcome = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(181_000);
    const err = await outcome;
    expect(err).toMatchObject({ errorCode: 'model_unavailable' });
    expect((err as Error).message).toMatch(/All configured models failed \(timeout\)/);
    expect(vi.mocked(providers.getAdapter)).toHaveBeenCalledTimes(3);
  });

  it('the chain deadline bounds the TOTAL generation time, not just one attempt', async () => {
    vi.useFakeTimers();
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([model('hang-1'), model('hang-2', { priority: 2 })]);
    vi.mocked(providers.getAdapter).mockImplementation((_providerId, modelId) => hangAdapter(modelId));
    const promise = completeWithFallback(baseOptions());
    await vi.advanceTimersByTimeAsync(119_000);
    let settled = false;
    promise.then(() => (settled = true)).catch(() => (settled = true));
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000); // attempt 1 timed out at 120s; attempt 2 in flight
    await vi.advanceTimersByTimeAsync(58_000); // t=179s: attempt 2 still in flight
    settled = false;
    promise.then(() => (settled = true)).catch(() => (settled = true));
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000); // t=181s: chain deadline (180s) aborted attempt 2
    const err = await promise.catch((e: unknown) => e);
    expect(err).toMatchObject({ errorCode: 'model_unavailable' });
    expect(vi.mocked(providers.getAdapter).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('rate-limited providers exhaust a finite chain and surface retry guidance', async () => {
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([model('rl-1'), model('rl-2', { priority: 2 })]);
    vi.mocked(providers.getAdapter).mockImplementation(() => ({
      providerId: 'openai',
      supportsToolCalls: true,
      async *complete() {
        throw AppError.unavailable('rate_limited', 'OpenAI rate limit reached', { retryAfterSec: 30 });
      },
    }));
    const err = await completeWithFallback(baseOptions()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as Error).message).toMatch(/Retry after ~30s/);
    expect(vi.mocked(providers.getAdapter)).toHaveBeenCalledTimes(3);
  });

  it('billing failures are classified billing with no infinite retry', async () => {
    mockPlan('pro');
    vi.mocked(registry.getRegistry).mockResolvedValue([model('bill-1'), model('bill-2', { priority: 2 })]);
    vi.mocked(providers.getAdapter).mockImplementation(() => ({
      providerId: 'openai',
      supportsToolCalls: true,
      async *complete() {
        throw AppError.unavailable('provider_billing', 'OpenAI billing quota exhausted (429)');
      },
    }));
    const err = await completeWithFallback(baseOptions()).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/All configured models failed \(billing\)/);
    expect(vi.mocked(providers.getAdapter)).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------- SSE ROUTE

interface FakeRes {
  setHeader: ReturnType<typeof vi.fn>;
  flushHeaders: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  chunks: string[];
}

function fakeRes(): FakeRes {
  const chunks: string[] = [];
  return {
    chunks,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((s: string) => {
      chunks.push(String(s));
      return true;
    }),
    end: vi.fn(),
    destroyed: false,
  };
}

interface FakeReq {
  header: () => string;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  fireClose: () => void;
}

function fakeReq(): FakeReq {
  const listeners: Record<string, () => void> = {};
  return {
    header: () => '',
    on: vi.fn((ev: string, fn: () => void) => {
      listeners[ev] = fn;
    }),
    removeListener: vi.fn(),
    fireClose: () => listeners['close']?.(),
  };
}

describe('handleChatStream — SSE close guarantees', () => {
  it('closes with an error frame when generation fails', async () => {
    const res = fakeRes();
    const req = fakeReq();
    await handleChatStream(
      req as never,
      res as never,
      async () => {
        throw AppError.unavailable('model_unavailable', 'All configured models failed (timeout)');
      },
      { deadlineMs: 60_000 },
    );
    const all = res.chunks.join('\n');
    expect(all).toContain('event: error');
    expect(all).toContain('model_unavailable');
    expect(res.end).toHaveBeenCalled();
    expect(req.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('aborts the in-flight generation on client disconnect and closes without writes', async () => {
    const res = fakeRes();
    const req = fakeReq();
    let sawAbort: AbortSignal | undefined;
    const streamDone = handleChatStream(
      req as never,
      res as never,
      async (events) => {
        sawAbort = events.signal;
        await new Promise<void>((resolve) => {
          if (events.signal?.aborted) return resolve();
          events.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('client gone');
      },
      { deadlineMs: 60_000 },
    );
    expect(sawAbort?.aborted).toBe(false);
    req.fireClose();
    expect(sawAbort?.aborted).toBe(true);
    await streamDone;
    expect(res.chunks.filter((c) => c.includes('event: error')).length).toBe(0);
    expect(res.end).toHaveBeenCalled();
  });

  it('a stalled generation is closed by the deadline with an honest timeout error', async () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const req = fakeReq();
    const streamDone = handleChatStream(
      req as never,
      res as never,
      async (events) => {
        await new Promise<void>((resolve) => {
          if (events.signal?.aborted) return resolve();
          events.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('stalled');
      },
      { deadlineMs: 60_000 },
    );
    await vi.advanceTimersByTimeAsync(61_000);
    await streamDone;
    const all = res.chunks.join('\n');
    expect(all).toContain('event: error');
    expect(all).toContain('stream_timeout');
    expect(res.end).toHaveBeenCalled();
  });

  it('deep-work completion delivers its confirmation text and closes the stream', async () => {
    const res = fakeRes();
    const req = fakeReq();
    await handleChatStream(
      req as never,
      res as never,
      async () => ({ assistant: 'Deep work task created — awaiting your approval. Track it in the 24/7 engine or the Approval Center.' }),
      { deadlineMs: 60_000 },
    );
    const all = res.chunks.join('\n');
    expect(all).toContain('event: delta');
    expect(all).toContain('awaiting your approval');
    expect(all).toContain('event: done');
    expect(res.end).toHaveBeenCalled();
  });
});