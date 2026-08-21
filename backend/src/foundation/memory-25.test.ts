/**
 * CodeConClave — STAGE 25 memory timeout hardening tests.
 * embeddingFor() must never hang: the OpenAI embeddings fetch carries a hard
 * AbortSignal deadline (AI_REQUEST_TIMEOUT_MS). A hung provider resolves null
 * (honest — search falls back to keyword) instead of blocking the request.
 * DB + env are mocked; only the fetch deadline behavior is under test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { embeddingFor, semanticSearch } from '../modules/memory/service.js';

vi.mock('../shared/db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  queryMany: vi.fn(async () => []),
  withTenant: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: { OPENAI_API_KEY: 'test-key', AI_REQUEST_TIMEOUT_MS: 150 },
}));

/** A fetch stub that never resolves unless its init signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        init?.signal?.addEventListener('abort', () =>
          resolve({ ok: false } as unknown as Response),
        );
      }),
  ) as unknown as typeof fetch;
}

describe('STAGE 25 — embeddingFor timeout hardening', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not hang when the provider never replies (AbortSignal deadline)', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await Promise.race([
      embeddingFor('search query'),
      new Promise<number[] | null>((resolve) => setTimeout(() => resolve('TIMED_OUT' as never), 5_000)),
    ]);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('applies the AI_REQUEST_TIMEOUT_MS deadline to the embeddings endpoint', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const startedAt = Date.now();
    const result = await embeddingFor('another query');
    const elapsed = Date.now() - startedAt;

    expect(result).toBeNull();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Waited for the deadline to elapse rather than resolving instantly.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('falls back to keyword search when the embedding deadline elapses', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const db = await import('../shared/db.js');
    vi.mocked(db.pool.query).mockResolvedValueOnce({ rows: [] } as never);

    const rows = await Promise.race([
      semanticSearch('user-1', 'query terms'),
      new Promise<unknown[]>(() => undefined),
    ]);

    expect(rows).toEqual([]);
  });

  it('returns null (not a fake vector) when the provider request fails fast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false } as unknown as Response)) as unknown as typeof fetch,
    );

    const result = await embeddingFor('anything');
    expect(result).toBeNull();
  });
});
