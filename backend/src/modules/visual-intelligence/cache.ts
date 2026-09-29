/**
 * CodeConClave — Visual Intelligence Cache (PKG-13).
 * TTL-aware, bounded cache for visual analysis results. Keys are scoped by
 * user + workspace so cached results never leak across tenants. Follows the
 * KnowledgeCache pattern (PKG-12) but with a smaller bound (visual results are
 * larger) and stronger isolation.
 */
import { cache } from '../../shared/cache.js';

const VISUAL_CACHE_PREFIX = 'visual:';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;
const MAX_ENTRY_SIZE_BYTES = 1024 * 1024;

export interface VisualCacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
  userId: string;
  workspaceId: string | null;
  accessCount: number;
}

export interface VisualCacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  hitRate: number;
  missRate: number;
  evictions: number;
}

export class VisualIntelligenceCache {
  private stats = { hits: 0, misses: 0, evictions: 0, totalSize: 0 };
  private keyIndex = new Map<string, number>();

  private prefixedKey(key: string): string {
    return `${VISUAL_CACHE_PREFIX}${key}`;
  }

  /** Physical key scoped by user + workspace so tenants never share an entry. */
  private scopedKey(key: string, userId: string, workspaceId: string | null): string {
    return `${VISUAL_CACHE_PREFIX}${userId}:${workspaceId ?? 'null'}:${key}`;
  }

  private async getRaw(key: string): Promise<VisualCacheEntry<unknown> | null> {
    const raw = await cache.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VisualCacheEntry<unknown>;
    } catch {
      await cache.del(key);
      return null;
    }
  }

  /**
   * Scoped get: the caller's user/workspace must match the cached entry.
   * This is the cross-user/cross-workspace isolation guarantee. A mismatch is
   * treated as a miss and never deletes another tenant's entry.
   */
  async get<T>(key: string, userId: string, workspaceId: string | null): Promise<{ value: T } | null> {
    const physical = this.scopedKey(key, userId, workspaceId);
    const entry = await this.getRaw(physical);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (entry.userId !== userId || entry.workspaceId !== workspaceId) {
      this.stats.misses++;
      return null;
    }
    const now = Date.now();
    if (now > entry.expiresAt) {
      await cache.del(physical);
      this.keyIndex.delete(physical);
      this.stats.misses++;
      return null;
    }
    entry.accessCount++;
    await this.setRaw(physical, entry);
    this.keyIndex.set(physical, now);
    this.stats.hits++;
    return { value: entry.value as T };
  }

  async set<T>(
    key: string,
    value: T,
    userId: string,
    workspaceId: string | null,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<void> {
    const now = Date.now();
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_ENTRY_SIZE_BYTES) return;
    const physical = this.scopedKey(key, userId, workspaceId);
    const entry: VisualCacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt: now + ttlMs,
      userId,
      workspaceId,
      accessCount: 0,
    };
    await this.setRaw(physical, entry);
    this.stats.totalSize += serialized.length;
    this.keyIndex.set(physical, now);
    await this.enforceBounds();
  }

  private async setRaw(physical: string, entry: VisualCacheEntry<unknown>): Promise<void> {
    const ttlMs = Math.max(1, entry.expiresAt - Date.now());
    await cache.set(physical, JSON.stringify(entry), ttlMs);
  }

  async delete(key: string): Promise<void> {
    await cache.del(key);
    this.keyIndex.delete(key);
  }

  /** Invalidate all keys matching a caller-supplied pattern (caller-scoped). */
  async invalidatePattern(pattern: string): Promise<number> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error(`Invalid cache pattern: ${pattern}`);
    }
    let count = 0;
    for (const k of this.keyIndex.keys()) {
      if (regex.test(k)) {
        await cache.del(k);
        this.keyIndex.delete(k);
        count++;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    for (const k of this.keyIndex.keys()) {
      await cache.del(k);
    }
    this.keyIndex.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, totalSize: 0 };
  }

  private async enforceBounds(): Promise<void> {
    if (this.keyIndex.size <= MAX_CACHE_ENTRIES) return;
    const entries = [...this.keyIndex.entries()].sort((a, b) => a[1] - b[1]);
    const toEvict = entries.slice(0, entries.length - MAX_CACHE_ENTRIES + 100);
    for (const [k] of toEvict) {
      await cache.del(k);
      this.keyIndex.delete(k);
      this.stats.evictions++;
    }
  }

  getStats(): VisualCacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      totalEntries: this.keyIndex.size,
      totalSizeBytes: this.stats.totalSize,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      missRate: total > 0 ? this.stats.misses / total : 0,
      evictions: this.stats.evictions,
    };
  }
}

export const visualIntelligenceCache = new VisualIntelligenceCache();
