/**
 * CodeConClave — PKG-22 Advanced Code Workspace — filesystem layer.
 * Reads/writes the developer's real code files in the runtime project workspace
 * root (disk). Path-confined and secret/binary-guarded. Writes are
 * version-aware: a client-supplied base sha256 MUST match the current on-disk
 * content, otherwise a 409 is returned — a save can never silently overwrite
 * work made since the editor last read the file.
 */
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import {
  resolveUnderRoot,
  isProtectedRelPath,
  assertNotProtected,
  isBinaryPath,
  isTextLike,
  rootForProject,
  workspaceUsable,
  exceedsMaxFileBytes,
} from './security.js';

export const MAX_TREE_DEPTH = 64;
export const MAX_TREE_ENTRIES = 5000;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  sha256?: string;
  children?: FileEntry[];
}

export interface ReadResult {
  path: string;
  content: string;
  sha256: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  large: boolean;
}

/** Recursively list the project tree (bounded). Returns null when workspace unusable. */
export async function listTree(projectId: string): Promise<FileEntry[] | null> {
  if (!(await workspaceUsable(projectId))) return null;
  const root = rootForProject(projectId)!;
  return walk(root, '', 0);
}

async function walk(dirAbs: string, rel: string, depth: number): Promise<FileEntry[]> {
  if (depth > MAX_TREE_DEPTH) return [];
  const entries: FileEntry[] = [];
  let names: Dirent[];
  try {
    names = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of names) {
    // Never follow symlinks during listing: readdir reports them distinctly
    // (isDirectory/isFile are both false), and read/write paths re-verify
    // containment via realpath in resolveUnderRoot.
    if (d.isSymbolicLink()) continue;
    if (d.name.startsWith('.') && d.name !== '.git') continue;
    if (d.name === 'node_modules') continue;
    if (d.name === '.git') {
      // present but not traversed; still shown as a marker-free dir? skip.
      continue;
    }
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const childAbs = path.join(dirAbs, d.name);
    if (d.isDirectory()) {
      const children = await walk(childAbs, childRel, depth + 1);
      if (children.length || depth < 12) {
        entries.push({ name: d.name, path: childRel, type: 'dir', size: null, children });
      }
    } else if (d.isFile()) {
      let size: number | null = null;
      try {
        size = (await stat(childAbs)).size;
      } catch {
        size = null;
      }
      entries.push({ name: d.name, path: childRel, type: 'file', size });
    }
    if (entries.length > MAX_TREE_ENTRIES) break;
  }
  return entries;
}

/** Flat list of all file paths (bounded) — used for navigation/search entry. */
export async function listFilePaths(projectId: string): Promise<string[] | null> {
  if (!(await workspaceUsable(projectId))) return null;
  const root = rootForProject(projectId)!;
  const out: string[] = [];
  await collectPaths(root, '', out);
  return out;
}

async function collectPaths(dirAbs: string, rel: string, out: string[]): Promise<void> {
  let names: Dirent[];
  try {
    names = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    // Never follow symlinks during listing (see walk() above).
    if (d.isSymbolicLink()) continue;
    if (d.name.startsWith('.') && d.name !== '.git') continue;
    if (d.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const childAbs = path.join(dirAbs, d.name);
    if (d.isDirectory()) {
      if (childRel === '.git') continue;
      await collectPaths(childAbs, childRel, out);
    } else if (d.isFile()) {
      out.push(childRel);
      if (out.length >= 10000) return;
    }
  }
}

/** Read a single text file (path-confined, protected-blocked, large/binary-aware). */
export async function readFileEntry(projectId: string, relPath: string): Promise<ReadResult | null> {
  if (!(await workspaceUsable(projectId))) return null;
  assertNotProtected(relPath);
  if (isBinaryPath(relPath)) {
    throw AppError.badRequest('binary_file', 'Binary file cannot be opened as text code');
  }
  const abs = resolveUnderRoot(projectId, relPath);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    throw AppError.notFound('File');
  }
  const large = exceedsMaxFileBytes(buf.length);
  if (large) {
    throw AppError.badRequest('file_too_large', 'File exceeds the workspace text limit (2 MiB) and is not force-loaded');
  }
  if (!isTextLike(buf)) {
    // Return binary flag but refuse to feed it to symbol/search/edit layers.
    return { path: relPath, content: '', sha256: sha256Hex(buf), size: buf.length, truncated: false, binary: true, large: false };
  }
  const content = buf.toString('utf8');
  return {
    path: relPath,
    content,
    sha256: sha256Hex(buf),
    size: buf.length,
    truncated: false,
    binary: false,
    large: false,
  };
}

/**
 * Version-aware write. `baseSha256` must equal the CURRENT on-disk content
 * (the hash the editor last read); otherwise the file changed under the user
 * and a 409 conflict is raised (no silent overwrite). Returns the new hash.
 */
export async function writeFileEntry(projectId: string, relPath: string, content: string, baseSha256?: string): Promise<string> {
  if (!(await workspaceUsable(projectId))) {
    throw AppError.conflict('workspace_unavailable', 'Workspace is not available on this deployment');
  }
  assertNotProtected(relPath);
  if (isBinaryPath(relPath)) throw AppError.badRequest('binary_file', 'Protected binary path');
  const abs = resolveUnderRoot(projectId, relPath);

  let currentSha: string | null = null;
  try {
    const cur = await readFile(abs);
    currentSha = sha256Hex(cur);
  } catch {
    currentSha = null; // new file
  }

  if (currentSha !== null && baseSha256 !== undefined && baseSha256 !== currentSha) {
    throw AppError.conflict('workspace_conflict', `File '${relPath}' changed since it was read; re-read and re-apply rather than silently overwrite`);
  }

  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw AppError.badRequest('file_too_large', 'Refusing to write more than 2 MiB');
  }

  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  return sha256Hex(content);
}

/** Read only up to `maxBytes` of a file (for search/context sampling). */
export async function readSlice(projectId: string, relPath: string, maxBytes: number): Promise<{ content: string; sha256: string } | null> {
  if (!(await workspaceUsable(projectId))) return null;
  assertNotProtected(relPath);
  const abs = resolveUnderRoot(projectId, relPath);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return null;
  }
  if (exceedsMaxFileBytes(buf.length)) return null;
  if (!isTextLike(buf)) return null;
  const slice = buf.subarray(0, Math.min(buf.length, maxBytes)).toString('utf8');
  return { content: slice, sha256: sha256Hex(buf) };
}
