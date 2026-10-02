/**
 * CodeConClave Local Agent — scoped file operations (Section 6.2/6.3).
 * Every write: policy check → backup with before-hash → atomic write →
 * after-hash → diff. Nothing is silently overwritten.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { resolveWorkspacePath, type Decision } from './policy.js';
import { sha256, unifiedDiff } from './diff.js';

export const MAX_READ_BYTES = 5 * 1024 * 1024;

export interface ListEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  sizeBytes: number;
  modifiedAt: string;
}

export interface EditProposal {
  allowed: boolean;
  risk: Decision['risk'];
  reason: string;
  path: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  backupPath?: string;
}

export function listDirectory(root: string, requested: string, limit = 200): { entries: ListEntry[]; error?: string } {
  const resolved = resolveWorkspacePath(root, requested);
  if (!resolved.ok) return { entries: [], error: resolved.reason };
  try {
    const items = readdirSync(resolved.abs, { withFileTypes: true });
    const entries: ListEntry[] = items.slice(0, limit).map((item) => {
      const full = join(resolved.abs, item.name);
      let type: ListEntry['type'] = item.isDirectory() ? 'dir' : item.isFile() ? 'file' : 'other';
      let sizeBytes = 0;
      let modifiedAt = '';
      try {
        const st = statSync(full);
        if (st.isDirectory()) type = 'dir';
        sizeBytes = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        /* entry vanished */
      }
      return { name: item.name, path: full, type, sizeBytes, modifiedAt };
    });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { entries };
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : 'list failed' };
  }
}

export function readFile(root: string, requested: string): { ok: true; content: string; sizeBytes: number; sha256: string } | { ok: false; error: string } {
  const resolved = resolveWorkspacePath(root, requested);
  if (!resolved.ok) return { ok: false, error: resolved.reason };
  try {
    const st = statSync(resolved.abs);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    if (st.size > MAX_READ_BYTES) return { ok: false, error: `file too large to read (${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB)` };
    const content = readFileSync(resolved.abs, 'utf8');
    return { ok: true, content, sizeBytes: st.size, sha256: sha256(content) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'read failed' };
  }
}

/** Preview an edit WITHOUT touching the file. Returns diff + hashes. */
export function proposeEdit(root: string, requested: string, content: string): EditProposal {
  const resolved = resolveWorkspacePath(root, requested);
  if (!resolved.ok) return { allowed: false, risk: 'CRITICAL', reason: resolved.reason, path: requested, beforeHash: '', afterHash: '', diff: '' };
  const existing = existsSync(resolved.abs) ? readFileSync(resolved.abs, 'utf8') : '';
  const beforeHash = sha256(existing);
  const afterHash = sha256(content);
  const diff = unifiedDiff(existing, content, basename(resolved.abs));
  return { allowed: true, risk: existing === content ? 'LOW' : 'MEDIUM', reason: 'edit previewed', path: resolved.abs, beforeHash, afterHash, diff };
}

/** Apply a previously previewed edit: backup + atomic write + hashes. */
export function applyEdit(root: string, requested: string, content: string): EditProposal {
  const preview = proposeEdit(root, requested, content);
  if (!preview.allowed) return preview;
  if (preview.diff === '') return preview;
  try {
    const backupDir = join(root, '.codeconclave-backups');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `${basename(preview.path)}.${preview.beforeHash.slice(0, 12)}.bak`);
    if (existsSync(preview.path)) {
      copyFileSync(preview.path, backupPath);
      preview.backupPath = backupPath;
    }
    const tmp = `${preview.path}.cc-tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, preview.path);
    return { ...preview, allowed: true };
  } catch (err) {
    return { ...preview, allowed: false, reason: err instanceof Error ? err.message : 'write failed' };
  }
}

/** Rollback a file to its pre-edit backup (returns previous hash). */
export function rollbackEdit(root: string, backupPath: string, targetPath: string): { ok: boolean; error?: string } {
  if (!existsSync(backupPath)) return { ok: false, error: 'backup missing' };
  try {
    const resolved = resolveWorkspacePath(root, targetPath);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    copyFileSync(backupPath, resolved.abs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'rollback failed' };
  }
}

export function fileMetadata(root: string, requested: string): Record<string, unknown> | { error: string } {
  const resolved = resolveWorkspacePath(root, requested);
  if (!resolved.ok) return { error: resolved.reason };
  try {
    const st = statSync(resolved.abs);
    return { path: resolved.abs, sizeBytes: st.size, modifiedAt: st.mtime.toISOString(), isDirectory: st.isDirectory(), dir: dirname(resolved.abs), name: basename(resolved.abs) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'stat failed' };
  }
}
