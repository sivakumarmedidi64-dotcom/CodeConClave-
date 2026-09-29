/**
 * CodeConClave Desktop — scoped files controller (local).
 * Wraps the local-agent file engine with capability + workspace scoping.
 * Attach/drop are VALIDATION-only in the foundation: they confirm a dropped
 * path is a plain, non-protected file eligible for attachment; they never
 * invent a filesystem layout or copy files implicitly.
 */
import { listDirectory, readFile, proposeEdit, applyEdit, fileMetadata } from '@codeconclave/local-agent/files';
import { isProtectedPath } from '@codeconclave/local-agent/policy';
import { realpathSync, statSync } from 'node:fs';
import type { AttachResult, DropResult, EditResult, FileDiffResult, FileListEntry, FileMetadataResult, FileReadResult } from '../types.js';
import { WorkspaceManager } from './workspace.js';

export const MAX_ATTACH_BYTES = 100 * 1024 * 1024;

export interface FilesAdapter {
  list(root: string, rel: string): { entries: FileListEntry[]; error?: string };
  read(root: string, rel: string): FileReadResult & { sha256?: string; sizeBytes?: number };
  write(root: string, rel: string, content: string): { ok: boolean; path?: string; beforeHash?: string; afterHash?: string; diff?: string; backupPath?: string; error?: string };
  metadata(root: string, rel: string): FileMetadataResult;
  diff(root: string, rel: string, content: string): FileDiffResult;
}

export const realFilesAdapter: FilesAdapter = {
  list: (root, rel) => listDirectory(root, rel),
  read: (root, rel) => {
    const res = readFile(root, rel);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, content: res.content, sizeBytes: res.sizeBytes, sha256: res.sha256 };
  },
  write: (root, rel, content) => {
    const res = applyEdit(root, rel, content);
    if (!res.allowed) return { ok: false, error: res.reason };
    return { ok: true, path: res.path, beforeHash: res.beforeHash, afterHash: res.afterHash, diff: res.diff, backupPath: res.backupPath };
  },
  metadata: (root, rel) => {
    const meta = fileMetadata(root, rel);
    if ('error' in meta) return { ok: false, error: meta.error as string };
    return {
      ok: true,
      path: meta.path as string,
      sizeBytes: meta.sizeBytes as number | undefined,
      modifiedAt: meta.modifiedAt as string | undefined,
      isDirectory: meta.isDirectory as boolean | undefined,
      name: meta.name as string | undefined,
    };
  },
  diff: (root, rel, content) => {
    const proposal = proposeEdit(root, rel, content);
    if (!proposal.allowed) return { ok: false, error: proposal.reason };
    return { ok: true, path: proposal.path, allowed: proposal.allowed, risk: proposal.risk, beforeHash: proposal.beforeHash, afterHash: proposal.afterHash, diff: proposal.diff };
  },
};

export class FilesController {
  constructor(
    private readonly ws: WorkspaceManager,
    private readonly adapter: FilesAdapter = realFilesAdapter,
    private readonly exists = (p: string): boolean => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    },
  ) {}

  list(relPath: string | undefined): { entries: FileListEntry[]; error?: string } {
    const grant = this.ws.requireActive('files.read');
    return this.adapter.list(grant.root, relPath ?? '.');
  }

  read(relPath: string): FileReadResult {
    const resolved = this.ws.resolveActive(relPath);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    return this.adapter.read(resolved.grant.root, relPath);
  }

  write(relPath: string, content: string): EditResult {
    const resolved = this.ws.resolveActive(relPath);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    this.ws.requireActive('files.write');
    const res = this.adapter.write(resolved.grant.root, relPath, content);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, path: res.path, beforeHash: res.beforeHash, afterHash: res.afterHash, diff: res.diff, backupPath: res.backupPath };
  }

  /** Preview an edit (diff + hashes) WITHOUT touching the file. */
  diff(relPath: string, content: string): FileDiffResult {
    const resolved = this.ws.resolveActive(relPath);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    this.ws.requireActive('files.write');
    return this.adapter.diff(resolved.grant.root, relPath, content);
  }

  metadata(relPath: string): FileMetadataResult {
    const resolved = this.ws.resolveActive(relPath);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    return this.adapter.metadata(resolved.grant.root, relPath);
  }

  /** Validate a set of absolute paths as attachable files. */
  private validatePaths(paths: string[]): { accepted: string[]; rejected: Array<{ path: string; reason: string }> } {
    const rejected: Array<{ path: string; reason: string }> = [];
    const accepted: string[] = [];
    for (const p of paths) {
      if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
        rejected.push({ path: p, reason: 'must be an absolute path' });
        continue;
      }
      if (!this.exists(p)) {
        rejected.push({ path: p, reason: 'does not exist' });
        continue;
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        rejected.push({ path: p, reason: 'cannot stat' });
        continue;
      }
      if (!st.isFile()) {
        rejected.push({ path: p, reason: 'not a regular file' });
        continue;
      }
      if (st.size > MAX_ATTACH_BYTES) {
        rejected.push({ path: p, reason: 'file exceeds 100MB limit' });
        continue;
      }
      // Canonicalize symlinks BEFORE the protected-path check: a symlink such
      // as /tmp/x -> ~/.ssh/id_rsa must be judged by its target, otherwise the
      // pattern gate is trivially bypassed.
      let canonical = p;
      try {
        canonical = realpathSync(p);
      } catch {
        rejected.push({ path: p, reason: 'cannot resolve' });
        continue;
      }
      if (isProtectedPath(canonical)) {
        rejected.push({ path: p, reason: 'path is protected by policy' });
        continue;
      }
      accepted.push(p);
    }
    return { accepted, rejected };
  }

  attach(paths: string[]): AttachResult {
    const resolved = this.ws.resolveActive('.');
    if (!resolved.ok) return { accepted: 0, rejected: paths.map((p) => ({ path: p, reason: resolved.reason })) };
    this.ws.requireActive('files.attach');
    const { accepted, rejected } = this.validatePaths(paths);
    return { accepted: accepted.length, rejected };
  }

  drop(paths: string[]): DropResult {
    return this.attach(paths);
  }
}