/**
 * CodeConClave — continuity sync engine (pull-biased reconciliation).
 * The server is authoritative. This engine:
 *   1. pushes client-composed USER messages (outbox) exactly once via
 *      clientId idempotency (POST /conversations/:id/sync),
 *   2. pulls every server message with seq > lastSeq (including tombstones)
 *      and merges them into the encrypted local cache,
 *   3. records the new anchor so the next call resumes where it left off.
 * A pending indicator is derived from the outbox so the UI never lies: rows
 * stay until the server confirms them.
 */
import { api } from '../api';
import type { CachedMessage, ConversationSyncView, OutboxEntry } from './types';
import type { ContinuityCache } from './cache';

export function newClientId(): string {
  return `cc_v1_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

/** One sync pass for a conversation. Returns the reconciled view + counts. */
export async function syncConversationCache(
  cache: ContinuityCache,
  conversationId: string,
  opts: { fetchImpl?: typeof api } = {},
): Promise<{ view: ConversationSyncView; cacheBackend: string }> {
  const fetchImpl = opts.fetchImpl ?? api;
  const afterSeq = await cache.getAnchor(conversationId);
  const pending = (await cache.listOutbox(conversationId))
    .filter((o) => o.status === 'PENDING')
    .map((o) => ({ clientId: o.clientId, content: o.content }));

  let view: ConversationSyncView;
  try {
    const res = await fetchImpl<{ sync: ConversationSyncView }>(`/api/v1/conversations/${conversationId}/sync`, {
      method: 'POST',
      body: { afterSeq, pending },
    });
    view = res.sync;
  } catch {
    throw new Error('sync failed');
  }

  // Merge pulled messages + tombstones into the local snapshot.
  const incoming: CachedMessage[] = view.messages.map((m) => ({
    ...m,
    role: m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'system',
  }));
  if (incoming.length) await cache.upsertMessages(conversationId, incoming);
  if (view.deletedIds.length) await cache.removeMessages(conversationId, view.deletedIds);
  if (view.lastSeq > afterSeq) await cache.setAnchor(conversationId, view.lastSeq);

  const confirmed = [...view.applied, ...view.duplicates];
  if (confirmed.length) await cache.removeOutbox(confirmed);

  return { view, cacheBackend: cache.backend };
}

/** Reconcile every conversation that has a local outbox entry. */
export async function syncAllPending(
  cache: ContinuityCache,
  opts: { fetchImpl?: typeof api } = {},
): Promise<{ conversationId: string; applied: number; duplicates: number }[]> {
  const outbox = await cache.listOutbox();
  const conversationIds = [...new Set(outbox.filter((o) => o.status === 'PENDING').map((o) => o.conversationId))];
  const results: { conversationId: string; applied: number; duplicates: number }[] = [];
  for (const conversationId of conversationIds) {
    try {
      const { view } = await syncConversationCache(cache, conversationId, opts);
      results.push({ conversationId, applied: view.applied.length, duplicates: view.duplicates.length });
    } catch {
      /* keep the outbox entry; a later pass retries */
    }
  }
  return results;
}

/** Queue a client-composed USER message for exactly-once delivery. */
export async function enqueuePendingMessage(
  cache: ContinuityCache,
  conversationId: string,
  clientId: string,
  content: string,
): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    clientId,
    conversationId,
    content,
    createdAt: Date.now(),
    status: 'PENDING',
  };
  await cache.enqueueOutbox(entry);
  return entry;
}

export async function pendingOutboxCount(cache: ContinuityCache): Promise<number> {
  return (await cache.listOutbox()).filter((o) => o.status === 'PENDING').length;
}

/** Total rows cached for a conversation (for the cache-badge). */
export async function cachedMessagesCount(cache: ContinuityCache, conversationId: string): Promise<number> {
  return (await cache.listMessages(conversationId)).length;
}