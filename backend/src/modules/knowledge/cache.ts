/**
 * CodeConClave — Knowledge Cache (PKG-12).
 * Bounded, TTL-aware cache with source provenance tracking, real invalidation,
 * LRU eviction, and accurate statistics.
 */
import { logger } from '../../shared/logger.js';
import { cache } from '../../shared/cache.js';
import type {
  CacheEntry,
  KnowledgeCacheStats,
  KnowledgeSource,
  KnowledgeFreshness,
} from './types.js';

const KNOWLEDGE_CACHE_PREFIX = 'knowledge:';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 10000;
const MAX_ENTRY_SIZE_BYTES = 1024 * 1024;

export class KnowledgeCache {
  private stats = { hits: 0, misses: 0, evictions: 0, totalSize: 0 };

  /** In-memory index of active keys for invalidation + eviction. Maps key → lastAccessAt. */
  private keyIndex = new Map<string, number>();

  private prefixedKey(key: string): string {
    return `${KNOWLEDGE_CACHE_PREFIX}${key}`;
  }

  private async getRaw(key: string): Promise<CacheEntry<unknown> | null> {
    const raw = await cache.get(this.prefixedKey(key));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CacheEntry<unknown>;
      if (typeof parsed.createdAt === 'string') parsed.createdAt = new Date(parsed.createdAt);
      if (typeof parsed.expiresAt === 'string') parsed.expiresAt = new Date(parsed.expiresAt);
      return parsed;
    } catch {
      await cache.del(this.prefixedKey(key));
      this.keyIndex.delete(key);
      return null;
    }
  }

  async get<T>(key: string): Promise<{ value: T; freshness: KnowledgeFreshness } | null> {
    const entry = await this.getRaw(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt.getTime()) {
      await this.delete(key);
      this.stats.misses++;
      return null;
    }

    entry.accessCount++;
    await this.setRaw(key, entry);
    this.keyIndex.set(key, now);

    this.stats.hits++;
    const freshness = this.calculateFreshness(entry.createdAt, entry.expiresAt);
    return { value: entry.value as T, freshness };
  }

  async set<T>(key: string, value: T, source: KnowledgeSource, ttlMs = DEFAULT_TTL_MS): Promise<void> {
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs);

    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_ENTRY_SIZE_BYTES) return;

    const entry: CacheEntry<T> = { key, value, createdAt: new Date(now), expiresAt, source, accessCount: 0 };

    await this.setRaw(key, entry);
    this.stats.totalSize += serialized.length;
    this.keyIndex.set(key, now);
    await this.enforceBounds();
  }

  private async setRaw(key: string, entry: CacheEntry<unknown>): Promise<void> {
    const ttlMs = Math.max(1, entry.expiresAt.getTime() - Date.now());
    await cache.set(this.prefixedKey(key), JSON.stringify(entry), ttlMs);
  }

  async delete(key: string): Promise<void> {
    await cache.del(this.prefixedKey(key));
    this.keyIndex.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<number> {
    const regex = new RegExp(pattern);
    let count = 0;
    for (const k of this.keyIndex.keys()) {
      if (regex.test(k)) {
        await cache.del(this.prefixedKey(k));
        this.keyIndex.delete(k);
        count++;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    for (const k of this.keyIndex.keys()) {
      await cache.del(this.prefixedKey(k));
    }
    this.keyIndex.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, totalSize: 0 };
  }

  private async enforceBounds(): Promise<void> {
    if (this.keyIndex.size <= MAX_CACHE_ENTRIES) return;

    const entries = [...this.keyIndex.entries()].sort((a, b) => a[1] - b[1]);
    const toEvict = entries.slice(0, entries.length - MAX_CACHE_ENTRIES + 100);
    for (const [k] of toEvict) {
      await cache.del(this.prefixedKey(k));
      this.keyIndex.delete(k);
      this.stats.evictions++;
    }
  }

  getStats(): KnowledgeCacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      totalEntries: this.keyIndex.size,
      totalSizeBytes: this.stats.totalSize,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      missRate: total > 0 ? this.stats.misses / total : 0,
      evictions: this.stats.evictions,
    };
  }

  calculateFreshness(createdAt: Date, expiresAt: Date): KnowledgeFreshness {
    const now = Date.now();
    const age = now - createdAt.getTime();
    const ttl = expiresAt.getTime() - createdAt.getTime();
    if (age > ttl) return 'EXPIRED';
    if (age > ttl * 0.8) return 'STALE';
    return 'FRESH';
  }
}

export const knowledgeCache = new KnowledgeCache();
