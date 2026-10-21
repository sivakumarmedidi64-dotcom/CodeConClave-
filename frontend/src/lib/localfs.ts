/**
 * Local folder access from the web app (File System Access API — Chrome,
 * Edge and other Chromium browsers). The browser asks the user to pick a
 * folder and grant read/write; CodeConClave can only touch what's inside it.
 * Same baseline as the local agent: secret files are never read or written,
 * heavy folders (node_modules, .git…) are skipped.
 */

export type DirHandle = FileSystemDirectoryHandle;
export type FileHandle = FileSystemFileHandle;

export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  handle: FileHandle | DirHandle;
}

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
export const MAX_EDIT_BYTES = 512 * 1024;

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.[\w.-]*env(\.[\w.-]+)?$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)($|[._-])/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)(credentials|secrets?)(\.[\w]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.aws(\/|$)/i,
];

/** Secret / credential files are blocked in every mode. */
export function isSecretPath(path: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(path));
}

export function folderAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickFolder(): Promise<DirHandle> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: 'readwrite' }) => Promise<DirHandle> }).showDirectoryPicker;
  return picker({ mode: 'readwrite' });
}

/** One directory level, folders first, heavy/secret entries filtered out. */
export async function listDir(dir: DirHandle, basePath: string): Promise<TreeNode[]> {
  const out: TreeNode[] = [];
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileHandle | DirHandle]> }).entries()) {
    const path = basePath ? `${basePath}/${name}` : name;
    if (handle.kind === 'directory' && SKIP_DIRS.has(name)) continue;
    if (isSecretPath(path)) continue;
    out.push({ name, path, kind: handle.kind, handle });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
}

export async function readText(node: TreeNode): Promise<{ text: string } | { error: string }> {
  if (isSecretPath(node.path)) return { error: 'Secret files are never opened.' };
  const file = await (node.handle as FileHandle).getFile();
  if (file.size > MAX_EDIT_BYTES) return { error: `This file is ${(file.size / 1024).toFixed(0)} KB — larger than the 512 KB editing limit.` };
  const text = await file.text();
  if (text.includes('\u0000')) return { error: 'Binary file — not shown.' };
  return { text };
}

export async function writeText(node: TreeNode, text: string): Promise<void> {
  if (isSecretPath(node.path)) throw new Error('Secret files are never written.');
  const writable = await (node.handle as FileHandle).createWritable();
  await writable.write(text);
  await writable.close();
}

// ------------------------------------------------------------------ diff

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Line diff (LCS). Large inputs fall back to a whole-file replace view. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! });
  while (j < m) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
  };
}

/** Pull the proposed file out of a model answer (first fenced block, else all). */
export function extractCodeBlock(answer: string): string | null {
  const m = /```[\w.+-]*\n([\s\S]*?)```/.exec(answer);
  if (m) return m[1]!.replace(/\n$/, '');
  return null;
}
