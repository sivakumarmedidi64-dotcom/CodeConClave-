/**
 * CodeConClave — continuity caching types.
 * The local cache mirrors the server's messages for a conversation (encrypted
 * IndexedDB) so the UI can render instantly and sync pull-based. The outbox
 * holds client-composed USER messages keyed by clientId — the exact-once
 * idempotency key the server dedupes on, so a retried send never duplicates.
 */
export type OutboxStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface CachedMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Server-assigned ordering sequence (pull anchor). */
  seq: number;
  clientId: string | null;
  createdAt: string;
}

export interface OutboxEntry {
  clientId: string;
  conversationId: string;
  content: string;
  createdAt: number;
  status: OutboxStatus;
}

export interface SyncAnchor {
  conversationId: string;
  /** Last server seq we have pulled; the next sync asks for seq > this. */
  lastSeq: number;
}

export interface ConversationSyncView {
  conversationId: string;
  lastSeq: number;
  messages: CachedMessage[];
  deletedIds: string[];
  applied: string[];
  duplicates: string[];
}