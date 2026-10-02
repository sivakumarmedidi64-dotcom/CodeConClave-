/**
 * CodeConClave Desktop — workspace file watcher (local).
 * Uses node:fs.watch (recursive where supported) scoped to the ACTIVE
 * workspace root. Events are debounced and filtered to the workspace subtree;
 * protected areas (.git, backups, secrets) never surface.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { FileChange } from '../types.js';
import type { WorkspaceManager } from './workspace.js';

export interface WatcherEvents {
  onChange: (change: FileChange) => void;
}

export type WatchFn = (
  root: string,
  opts: { recursive: boolean },
  cb: (kind: string, file: string | null) => void,
) => { close(): void };

export const realWatch: WatchFn = (root, opts, cb) => {
  const w: FSWatcher = watch(root, { recursive: opts.recursive }, (event, filename) => cb(event, filename));
  return { close: () => w.close() };
};

const IGNORED = /(^|[\\/])\.git([\\/]|$)|(^|[\\/])\.codeconclave-backups([\\/]|$)/;

export class WorkspaceWatcher {
  private watcher: { close(): void } | null = null;
  private activeRoot: string | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private pending: FileChange[] = [];

  constructor(
    private readonly ws: WorkspaceManager,
    private readonly events: WatcherEvents,
    private readonly watchFn: WatchFn = realWatch,
    private readonly debounceMs = 120,
  ) {}

  start(): void {
    const grant = this.ws.requireActive('files.read');
    if (this.activeRoot === grant.root && this.watcher) return;
    this.stop();
    this.activeRoot = grant.root;
    try {
      this.watcher = this.watchFn(grant.root, { recursive: true }, (rawKind, file) => this.onEvent(grant.root, file, rawKind));
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.pending = [];
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.activeRoot = null;
  }

  /** Injectable event handler; also directly testable. */
  onEvent(root: string, file: string | null, rawKind: string): void {
    if (!file) return;
    const rel = file.replace(/\\/g, '/');
    if (IGNORED.test(rel)) return;
    const seg = rel.split('/');
    if (seg.some((s) => s.length > 0 && s.startsWith('.'))) return; // hidden entries stay local-only
    const kind: FileChange['kind'] =
      rawKind === 'rename' || rawKind === 'renameDir' || rawKind === 'renameFile'
        ? 'renamed'
        : rawKind === 'change'
          ? 'changed'
          : 'unknown';
    this.pending.push({ wsRoot: root, path: rel, kind, at: new Date().toISOString() });
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      if (this.pending.length === 0) return;
      const batch = this.pending;
      this.pending = [];
      for (const c of batch) this.events.onChange(c);
    }, this.debounceMs);
  }

  flushNow(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    const batch = this.pending;
    this.pending = [];
    for (const c of batch) this.events.onChange(c);
  }
}