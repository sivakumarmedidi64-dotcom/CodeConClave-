/**
 * CodeConClave — continuity library tests (cache + sync + crypto + markdown).
 * Pure domain logic is exercised without a browser: the cache uses the memory
 * store + plaintext codec, the sync engine uses an injected fetch, and the
 * markdown renderer is fully deterministic.
 */
import { describe, it, expect } from 'vitest';
import type { api } from '../api';
import { createContinuityCache, memoryStore, plainCodec } from './cache';
import { newClientId, syncConversationCache, enqueuePendingMessage, pendingOutboxCount, syncAllPending } from './sync';
import { buildDecisionMarkdown } from './markdown';
import { continuityCryptoAvailable, encryptCacheText, decryptCacheText } from './crypto';
import type { DecisionRow } from '../types';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

function fakeFetch(view: unknown) {
  return (async (_path: string, _opts: { method?: string; body?: unknown } = {}) => view) as unknown as typeof api;
}

describe('continuity cache', () => {
  const cache = createContinuityCache(memoryStore(), plainCodec);

  it('upserts, lists by seq, and removes messages', async () => {
    await cache.upsertMessages('c1', [
      { id: 'm2', conversationId: 'c1', role: 'assistant', content: 'b', seq: 2, clientId: null, createdAt: 't2' },
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'a', seq: 1, clientId: 'k1', createdAt: 't1' },
    ]);
    const msgs = await cache.listMessages('c1');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(msgs[0]!.clientId).toBe('k1');
    await cache.removeMessages('c1', ['m2']);
    expect((await cache.listMessages('c1')).map((m) => m.id)).toEqual(['m1']);
  });

  it('tracks the pull anchor (lastSeq)', async () => {
    await cache.setAnchor('c1', 42);
    expect(await cache.getAnchor('c1')).toBe(42);
    expect(await cache.getAnchor('c9')).toBe(0);
  });

  it('enqueues and removes outbox rows', async () => {
    await enqueuePendingMessage(cache, 'c1', 'k1', 'hello');
    await enqueuePendingMessage(cache, 'c1', 'k2', 'world');
    await enqueuePendingMessage(cache, 'c2', 'k3', 'other');
    expect(await pendingOutboxCount(cache)).toBe(3);
    const c1 = await cache.listOutbox('c1');
    expect(c1.map((o) => o.clientId)).toEqual(['k1', 'k2']);
    await cache.removeOutbox(['k1']);
    expect(await pendingOutboxCount(cache)).toBe(2);
  });
});

describe('sync engine', () => {
  it('pushes outbox exactly once and pulls new messages + tombstones', async () => {
    const cache = createContinuityCache(memoryStore(), plainCodec);
    await cache.setAnchor('c1', 5);
    await enqueuePendingMessage(cache, 'c1', 'offline1', 'draft message');
    let posted: unknown = null;
    const fetchImpl = (async (_path: string, opts: { method?: string; body?: unknown } = {}) => {
      posted = { path: _path, method: opts.method, body: opts.body };
      return {
        sync: {
          conversationId: 'c1',
          lastSeq: 8,
          messages: [
            { id: 'm6', conversationId: 'c1', role: 'assistant', content: 'server reply', seq: 6, clientId: null, createdAt: 't6' },
            { id: 'm8', conversationId: 'c1', role: 'assistant', content: 'server tail', seq: 7, clientId: null, createdAt: 't8' },
          ],
          deletedIds: ['m5'],
          applied: ['offline1'],
          duplicates: [],
        },
      };
    }) as unknown as typeof api;
    const { view, cacheBackend } = await syncConversationCache(cache, 'c1', { fetchImpl });
    expect(cacheBackend).toBe('memory');
    expect(view.applied).toEqual(['offline1']);
    expect((posted as { body: { afterSeq: number; pending: unknown[] } }).body.afterSeq).toBe(5);
    expect((posted as { body: { pending: { clientId: string }[] } }).body.pending).toEqual([
      { clientId: 'offline1', content: 'draft message' },
    ]);
    // outbox entry consumed, anchor advanced, messages merged, tombstone dropped
    expect(await pendingOutboxCount(cache)).toBe(0);
    expect(await cache.getAnchor('c1')).toBe(8);
    expect(await cache.listMessages('c1')).toHaveLength(2);
  });

  it('keeps the outbox entry when the server is unreachable (never lies)', async () => {
    const cache = createContinuityCache(memoryStore(), plainCodec);
    await enqueuePendingMessage(cache, 'c1', 'k9', 'queued offline');
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof api;
    await expect(syncConversationCache(cache, 'c1', { fetchImpl })).rejects.toThrow();
    expect(await pendingOutboxCount(cache)).toBe(1);
  });

  it('syncAllPending reconciles every conversation with a pending row', async () => {
    const cache = createContinuityCache(memoryStore(), plainCodec);
    await enqueuePendingMessage(cache, 'c1', 'k1', 'a');
    await enqueuePendingMessage(cache, 'c2', 'k2', 'b');
    const results = await syncAllPending(cache, {
      fetchImpl: (async (_p: string, o: { body?: unknown } = {}) => {
        const body = (o.body ?? {}) as { pending?: { clientId: string }[] };
        const applied = (body.pending ?? []).map((e) => e.clientId);
        return {
          sync: { conversationId: 'x', lastSeq: 0, messages: [], deletedIds: [], applied, duplicates: [] },
        };
      }) as unknown as typeof api,
    });
    expect(results).toEqual([
      { conversationId: 'c1', applied: 1, duplicates: 0 },
      { conversationId: 'c2', applied: 1, duplicates: 0 },
    ]);
    expect(await pendingOutboxCount(cache)).toBe(0);
  });
});

describe('newClientId', () => {
  it('produces unique prefixed ids', () => {
    const a = newClientId();
    const b = newClientId();
    expect(a).toMatch(/^cc_v1_/);
    expect(a).not.toBe(b);
  });
});

describe('decision markdown export', () => {
  const DECISION: DecisionRow = {
    id: 'dec1',
    owner_id: 'u1',
    project_id: null,
    title: 'Postgres for billing',
    decision: 'Use Postgres for the billing service.',
    context: 'Transactions and ACID guarantees matter here.',
    alternatives: ['MySQL', 'DynamoDB'],
    rationale: 'ACID + mature tooling.',
    consequences: ['Repmgr required for HA'],
    source_conversation_id: 'c1',
    source_task_id: null,
    evidence_ref: null,
    impact: 'HIGH',
    status: 'ACTIVE',
    source_message_ids: ['m1'],
    scope: 'PROJECT',
    superseded_by_id: null,
    deleted_at: null,
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
  };

  it('renders every real field, never inventing content', () => {
    const md = buildDecisionMarkdown([DECISION]);
    expect(md).toContain('# CodeConClave decision.md');
    expect(md).toContain('## 1. Postgres for billing');
    expect(md).toContain('Status: ACTIVE');
    expect(md).toContain('Scope: PROJECT');
    expect(md).toContain('Impact: HIGH');
    expect(md).toContain('Use Postgres for the billing service.');
    expect(md).toContain('Transactions and ACID guarantees matter here.');
    expect(md).toContain('- MySQL');
    expect(md).toContain('- DynamoDB');
    expect(md).toContain('- Repmgr required for HA');
    expect(md).toContain('Conversation: c1');
    expect(md).toContain('Source messages: m1');
  });

  it('renders an explicit empty state for no decisions', () => {
    expect(buildDecisionMarkdown([])).toContain('_No recorded decisions._');
  });

  it('is deterministic for the same rows', () => {
    expect(buildDecisionMarkdown([DECISION])).toBe(buildDecisionMarkdown([DECISION]));
  });
});

describe('continuity crypto', () => {
  it('round-trips sealed text when WebCrypto is present', async () => {
    if (!continuityCryptoAvailable()) return;
    const host = memoryStorage();
    const sealed = await encryptCacheText('hello continuity', host);
    expect(sealed).not.toBeNull();
    expect(sealed!).not.toContain('hello continuity');
    expect(await decryptCacheText(sealed!, host)).toBe('hello continuity');
    // A different storage host cannot decrypt (different secret).
    const other = memoryStorage();
    expect(await decryptCacheText(sealed!, other)).not.toBe('hello continuity');
  });

  it('returns null from encrypt/decrypt when WebCrypto is unavailable', async () => {
    if (continuityCryptoAvailable()) return;
    const host = memoryStorage();
    expect(await encryptCacheText('x', host)).toBeNull();
    expect(await decryptCacheText('y', host)).toBeNull();
  });
});

describe('sync interaction shape', () => {
  it('passes conversationId and clientId through the sync payload', async () => {
    const cache = createContinuityCache(memoryStore(), plainCodec);
    const seen: unknown[] = [];
    const fetchImpl = (async (_path: string, opts: { body?: unknown } = {}) => {
      seen.push(opts.body);
      return { sync: { conversationId: 'cv1', lastSeq: 0, messages: [], deletedIds: [], applied: ['cid1'], duplicates: [] } };
    }) as unknown as typeof api;
    await enqueuePendingMessage(cache, 'cv1', 'cid1', 'upgrade pg');
    await syncConversationCache(cache, 'cv1', { fetchImpl });
    expect(seen).toEqual([{ afterSeq: 0, pending: [{ clientId: 'cid1', content: 'upgrade pg' }] }]);
  });

  it('treats an applied clientId as consumed (duplicate guard)', async () => {
    const cache = createContinuityCache(memoryStore(), plainCodec);
    const calls: unknown[] = [];
    const fetchImpl = (async (_p: string, o: { body?: unknown } = {}) => {
      calls.push(o.body);
      return { sync: { conversationId: 'cv1', lastSeq: 0, messages: [], deletedIds: [], applied: ['cid1'], duplicates: [] } };
    }) as unknown as typeof api;
    await enqueuePendingMessage(cache, 'cv1', 'cid1', 'msg');
    await syncConversationCache(cache, 'cv1', { fetchImpl });
    await syncConversationCache(cache, 'cv1', { fetchImpl });
    // second pass: nothing left pending, so the body carries an empty pending list
    expect(calls).toHaveLength(2);
    expect((calls[1] as { pending: unknown[] }).pending).toEqual([]);
  });
});