/**
 * CodeConClave — continuity local cache (encrypted at rest).
 * A small key/value store (IndexedDB in the browser, an in-memory map in tests
 * or where IndexedDB is unavailable) holding encrypted conversation snapshots:
 *   msg:{conversationId}:{messageId}   → CachedMessage (sealed)
 *   anchor:{conversationId}            → { lastSeq }
 *   outbox:{clientId}                  → OutboxEntry (sealed)
 * Two codecs back encryption: WebCrypto AES-GCM when `crypto.subtle` exists,
 * and an explicit plaintext passthrough elsewhere — the caller opts in via
 * `createContinuityCache({ codec })`. The browser default seals every row so a
 * copied profile directory never contains plaintext conversation content.
 */
import type { CachedMessage, OutboxEntry } from './types';

// ---------------------------------------------------------------- store backends

export interface RawEntry {
  key: string;
  value: string;
}

export interface StringStore {
  readonly kind: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<RawEntry[]>;
  clear(): Promise<void>;
}

/** In-memory store — used in tests and as the IndexedDB-unavailable fallback. */
export function memoryStore(): StringStore {
  const map = new Map<string, string>();
  return {
    kind: 'memory',
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async del(key) {
      map.delete(key);
    },
    async list(prefix) {
      const out: RawEntry[] = [];
      for (const [key, value] of map) {
        if (key.startsWith(prefix)) out.push({ key, value });
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async clear() {
      map.clear();
    },
  };
}

const DB_NAME = 'codeconclave_continuity';
const DB_VERSION = 1;
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('continuity cache open failed'));
  });
}

function txOnce<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE, mode);
    const req = work(txn.objectStore(STORE));
    txn.oncomplete = () => resolve(req.result);
    txn.onerror = () => reject(txn.error ?? new Error('continuity cache txn failed'));
  });
}

/** IndexedDB-backed store (browser). Throws if IndexedDB is unavailable. */
export async function indexedDbStore(): Promise<StringStore> {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());
  return {
    kind: 'indexeddb',
    async get(key) {
      const d = await db();
      const row = await txOnce(d, 'readonly', (s) => s.get(key) as IDBRequest<RawEntry | null>);
      return row?.value ?? null;
    },
    async set(key, value) {
      const d = await db();
      await txOnce(d, 'readwrite', (s) => s.put({ key, value } as RawEntry));
    },
    async del(key) {
      const d = await db();
      await txOnce(d, 'readwrite', (s) => s.delete(key));
    },
    async list(prefix) {
      const d = await db();
      const all = await txOnce(d, 'readonly', (s) => s.getAll() as IDBRequest<RawEntry[]>);
      return all
        .filter((e) => e.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async clear() {
      const d = await db();
      await txOnce(d, 'readwrite', (s) => s.clear());
    },
  };
}

// ---------------------------------------------------------------- codec

export interface Codec {
  encrypt(value: string): Promise<string | null> | string | null;
  decrypt(value: string): Promise<string | null> | string | null;
}

// ---------------------------------------------------------------- cache surface

export interface ContinuityCache {
  readonly backend: string;
  upsertMessages(conversationId: string, messages: CachedMessage[]): Promise<void>;
  /** Messages active in the local snapshot, ordered by seq ascending. */
  listMessages(conversationId: string, limit?: number): Promise<CachedMessage[]>;
  removeMessages(conversationId: string, ids: string[]): Promise<void>;
  getAnchor(conversationId: string): Promise<number>;
  setAnchor(conversationId: string, lastSeq: number): Promise<void>;
  enqueueOutbox(entry: OutboxEntry): Promise<void>;
  listOutbox(conversationId?: string): Promise<OutboxEntry[]>;
  removeOutbox(clientIds: string[]): Promise<void>;
  clear(): Promise<void>;
}

const msgKey = (conversationId: string, messageId: string) => `msg:${conversationId}:${messageId}`;
const anchorKey = (conversationId: string) => `anchor:${conversationId}`;
const outboxKey = (clientId: string) => `outbox:${clientId}`;

export function createContinuityCache(store: StringStore, codec: Codec): ContinuityCache {
  const seal = async (plain: string): Promise<string> => {
    const out = await codec.encrypt(plain);
    return out ?? plain;
  };
  const open = async (value: string): Promise<string | null> => {
    const out = await codec.decrypt(value);
    return out ?? null;
  };
  const prefixFor = (conversationId: string) => `msg:${conversationId}:`;

  return {
    backend: store.kind,

    async upsertMessages(conversationId, messages) {
      for (const m of messages) {
        const sealed = await seal(JSON.stringify(m));
        await store.set(msgKey(conversationId, m.id), sealed);
      }
    },

    async listMessages(conversationId, limit) {
      const rows = await store.list(prefixFor(conversationId));
      const msgs: CachedMessage[] = [];
      for (const row of rows) {
        const plain = await open(row.value);
        if (!plain) continue;
        try {
          const parsed = JSON.parse(plain) as CachedMessage;
          if (parsed && typeof parsed.id === 'string') msgs.push(parsed);
        } catch {
          /* corrupt sealed row — skip */
        }
      }
      msgs.sort((a, b) => a.seq - b.seq);
      return limit ? msgs.slice(0, limit) : msgs;
    },

    async removeMessages(conversationId, ids) {
      for (const id of ids) await store.del(msgKey(conversationId, id));
    },

    async getAnchor(conversationId) {
      const raw = await store.get(anchorKey(conversationId));
      if (!raw) return 0;
      const plain = await open(raw);
      if (!plain) return 0;
      try {
        const parsed = JSON.parse(plain) as { lastSeq?: number };
        return typeof parsed.lastSeq === 'number' ? parsed.lastSeq : 0;
      } catch {
        return 0;
      }
    },

    async setAnchor(conversationId, lastSeq) {
      await store.set(anchorKey(conversationId), await seal(JSON.stringify({ lastSeq })));
    },

    async enqueueOutbox(entry) {
      await store.set(outboxKey(entry.clientId), await seal(JSON.stringify(entry)));
    },

    async listOutbox(conversationId) {
      const rows = await store.list('outbox:');
      const out: OutboxEntry[] = [];
      for (const row of rows) {
        const plain = await open(row.value);
        if (!plain) continue;
        try {
          const parsed = JSON.parse(plain) as OutboxEntry;
          if (parsed && typeof parsed.clientId === 'string') {
            if (!conversationId || parsed.conversationId === conversationId) out.push(parsed);
          }
        } catch {
          /* skip corrupt row */
        }
      }
      return out.sort((a, b) => a.createdAt - b.createdAt);
    },

    async removeOutbox(clientIds) {
      for (const id of clientIds) await store.del(outboxKey(id));
    },

    async clear() {
      await store.clear();
    },
  };
}

export const plainCodec: Codec = {
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
};

/** WebCrypto AES-GCM codec backed by crypto.ts — seals rows when possible. */
export function cryptoCodec(host: Storage, cryptoModule: {
  encryptCacheText: (plain: string, host: Storage) => Promise<string | null>;
  decryptCacheText: (payload: string, host: Storage) => Promise<string | null>;
}): Codec {
  return {
    encrypt: (v: string) => cryptoModule.encryptCacheText(v, host),
    decrypt: (v: string) => cryptoModule.decryptCacheText(v, host),
  };
}

/** Opens the default browser store, falling back to memory when unavailable. */
export async function openContinuityStore(): Promise<StringStore> {
  try {
    if (typeof indexedDB !== 'undefined') return await indexedDbStore();
  } catch {
    /* fall through to memory */
  }
  return memoryStore();
}

/** The app-wide cache: IndexedDB store + AES-GCM codec when the browser
 *  supports it (always in modern browsers), memory+plaintext elsewhere. */
export async function openContinuityCache(host: Storage | null): Promise<ContinuityCache> {
  const store = await openContinuityStore();
  if (host) {
    const cryptoModule = await import('./crypto');
    const codec = cryptoCodec(host, cryptoModule);
    return createContinuityCache(store, codec);
  }
  return createContinuityCache(store, plainCodec);
}

let defaultCachePromise: Promise<ContinuityCache> | null = null;

/** Module-level singleton so ChatPage and HomeChat share one cache+key. */
export function getContinuityCache(host: Storage | null = globalThis.localStorage): Promise<ContinuityCache> {
  defaultCachePromise ??= openContinuityCache(host);
  return defaultCachePromise;
}

/** Reset the singleton (test isolation): drops the cached instance so the next
 *  getContinuityCache() opens a fresh store. Existing rows are wiped because a
 *  brand-new memory/IDB store is created. */
export function resetDefaultContinuityCache(): void {
  defaultCachePromise = null;
}