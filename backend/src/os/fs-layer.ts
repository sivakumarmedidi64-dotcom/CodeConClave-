/**
 * CodeConClave AI OS — Filesystem OS layer (P0.3).
 *
 * A cloud-side filesystem abstraction for project-scoped workspace files built
 * ON the existing storage adapter (memory/s3/r2). It provides read / write /
 * watch / diff / snapshot / rollback / lock. It NEVER grants the backend
 * arbitrary access to a user's LOCAL files: local stays on the local-agent;
 * this layer addresses cloud/project workspace keys only.
 */
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { storage } from '../integrations/storage.js';
import { diffLines, DiffResult } from './diff.js';

export type FsChange = { kind: 'write' | 'delete'; key: string; at: number };

interface WatchSub {
  onEvent: (e: FsChange) => void;
}

export interface SnapshotRef {
  key: string;
  at: number;
}

export class FilesystemOsLayer {
  private watches = new Map<string, Set<WatchSub>>();
  private lockRegistry = new Map<string, { owner: string; at: number }>();

  constructor(private scopePrefix: string) {}

  private scopedKey(projectId: string, relPath: string): string {
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleaned.includes('..')) {
      throw AppError.badRequest('aios_fs_path_traversal', 'path traversal is not allowed');
    }
    return `${this.scopePrefix}/${projectId}/${cleaned}`;
  }

  private async emitChange(projectId: string, key: string, kind: 'write' | 'delete'): Promise<void> {
    const subs = this.watches.get(projectId);
    if (!subs) return;
    const event: FsChange = { kind, key, at: Date.now() };
    for (const sub of subs) {
      try {
        sub.onEvent(event);
      } catch (err) {
        logger.warn('aios.fs.watch.handler_error', { error: (err as Error).message });
      }
    }
  }

  async read(projectId: string, relPath: string): Promise<string> {
    const key = this.scopedKey(projectId, relPath);
    const buf = await storage.get(key);
    return buf.toString('utf8');
  }

  async write(projectId: string, relPath: string, content: string): Promise<DiffResult> {
    const key = this.scopedKey(projectId, relPath);
    let prev = '';
    try {
      prev = (await storage.get(key)).toString('utf8');
    } catch {
      /* new file */
    }
    const diff = diffLines(prev, content);
    await storage.put(key, Buffer.from(content, 'utf8'), 'text/plain');
    await this.emitChange(projectId, key, 'write');
    return diff;
  }

  async exists(projectId: string, relPath: string): Promise<boolean> {
    const key = this.scopedKey(projectId, relPath);
    return storage.exists(key);
  }

  async delete(projectId: string, relPath: string): Promise<void> {
    const key = this.scopedKey(projectId, relPath);
    await storage.delete(key);
    await this.emitChange(projectId, key, 'delete');
  }

  diff(projectId: string, relPath: string, before: string, after: string): DiffResult {
    void projectId;
    void relPath;
    return diffLines(before, after);
  }

  /** Snapshot: copy current content to a versioned snapshot key. */
  async snapshot(projectId: string, relPath: string, version: number): Promise<SnapshotRef> {
    const key = this.scopedKey(projectId, relPath);
    const content = await storage.get(key);
    const snapKey = `${key}@snapshot:${version}`;
    await storage.put(snapKey, content, 'text/plain');
    return { key: snapKey, at: Date.now() };
  }

  /** Rollback: restore a snapshot back to the live key. */
  async rollback(projectId: string, relPath: string, version: number): Promise<void> {
    const live = this.scopedKey(projectId, relPath);
    const snapKey = `${live}@snapshot:${version}`;
    const content = await storage.get(snapKey);
    await storage.put(live, content, 'text/plain');
    await this.emitChange(projectId, live, 'write');
  }

  /** Advisory lock (in-process registry; cloud-scale would use Redis/DB). */
  async lock(projectId: string, relPath: string, owner: string): Promise<boolean> {
    const key = this.scopedKey(projectId, relPath);
    if (this.lockRegistry.has(key)) return false;
    this.lockRegistry.set(key, { owner, at: Date.now() });
    return true;
  }

  async unlock(projectId: string, relPath: string, owner: string): Promise<boolean> {
    const key = this.scopedKey(projectId, relPath);
    const entry = this.lockRegistry.get(key);
    if (!entry) return false;
    if (entry.owner !== owner) return false;
    this.lockRegistry.delete(key);
    return true;
  }

  /** Watch for cloud-side changes to a project. Returns an unsubscribe fn. */
  watch(projectId: string, onEvent: (e: FsChange) => void): () => void {
    let set = this.watches.get(projectId);
    if (!set) {
      set = new Set();
      this.watches.set(projectId, set);
    }
    const sub: WatchSub = { onEvent };
    set.add(sub);
    return () => {
      set.delete(sub);
      if (set.size === 0) this.watches.delete(projectId);
    };
  }
}
