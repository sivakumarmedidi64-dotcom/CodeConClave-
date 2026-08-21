/**
 * CodeConClave — cache/rate-limit store.
 * Redis when REDIS_URL is configured; otherwise an honest in-memory store
 * (single-process dev only — documented, not hidden).
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  incr(key: string, ttlMs: number): Promise<number>;
  del(key: string): Promise<void>;
  health(): Promise<boolean>;
  readonly kind: 'redis' | 'memory';
}

class MemoryStore implements CacheStore {
  readonly kind = 'memory' as const;
  private store = new Map<string, { value: string; expiresAt: number }>();

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.sweep();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    this.sweep();
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.store.set(key, { value: '1', expiresAt: now + ttlMs });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = String(next);
    return next;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async health(): Promise<boolean> {
    return true;
  }
}

export const memoryStore = new MemoryStore();

interface RedisLike {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ping(): Promise<string>;
}

export async function createCache(): Promise<CacheStore> {
  if (!env.REDIS_URL) {
    logger.warn('REDIS_URL not configured — using in-memory cache/rate-limit store (single-process dev only)');
    return memoryStore;
  }
  let RedisCtor: new (url: string, opts: Record<string, unknown>) => RedisLike;
  try {
    const mod = (await import('ioredis')) as unknown as { default: new (url: string, opts: Record<string, unknown>) => RedisLike };
    RedisCtor = mod.default;
  } catch {
    logger.warn('ioredis not installed — falling back to in-memory store');
    return memoryStore;
  }
const client = new RedisCtor(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    // A stalled-but-open socket must not hold a command forever (Stage 25).
    commandTimeout: 10_000,
  });
  // Absorb background reconnection failures (the store is already reported
  // honestly via /health) — an unhandled 'error' event would crash the
  // process during a Redis outage.
  (client as unknown as { on(event: 'error', fn: (err: Error) => void): void }).on('error', (err) => {
    logger.warn('redis connection error', { error: (err as Error).message });
  });
  try {
    await client.connect();
    logger.info('redis connected', { url: env.REDIS_URL.replace(/:[^:@/]+@/, ':***@') });
  } catch (err) {
    logger.warn('redis connection failed �?" using in-memory store', { error: (err as Error).message });
    return memoryStore;
  }

  return {
    kind: 'redis',
    async get(key) {
      return client.get(key);
    },
    async set(key, value, ttlMs) {
      await client.set(key, value, 'PX', ttlMs);
    },
    async incr(key, ttlMs) {
      const n = await client.incr(key);
      if (n === 1) await client.pexpire(key, ttlMs);
      return n;
    },
    async del(key) {
      await client.del(key);
    },
    async health() {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
  };
}

export let cache: CacheStore = memoryStore;

export async function initCache(): Promise<void> {
  cache = await createCache();
}