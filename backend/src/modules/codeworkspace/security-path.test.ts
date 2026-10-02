/**
 * CodeConClave — codeworkspace path-security regression tests.
 * Covers: ../ traversal, absolute paths, Windows drive letters, UNC paths
 * (\\server\share, \\?\C:\, \\.\), home expansion, symlink/junction escape
 * (existing target + new-file parent chain), protected paths (.env, private
 * keys), and that legitimate nested paths still resolve inside the root.
 * Real temp dirs + real symlinks on disk; no database (shared/db mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../shared/db.js', () => ({
  pool: { query: vi.fn() },
  queryMany: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTenant: vi.fn(async (_u: unknown, fn: (q: unknown) => unknown) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
  withSystem: vi.fn(async (fn: (q: unknown) => unknown) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
}));

const envMock = vi.hoisted(() => {
  const e: Record<string, string> = {
    PREVIEW_PROJECTS_ROOT: '',
    AIOS_P2_WORKSPACE: 'true',
  };
  return e;
});
vi.mock('../../config/env.js', () => ({ env: envMock }));

import {
  normalizeRelPath,
  resolveUnderRoot,
  isProtectedRelPath,
  assertNotProtected,
} from './security.js';

const tmpBase = path.join(tmpdir(), `codeconclave-secpath-${process.pid}`);
let base = '';
let pid = '';

beforeEach(async () => {
  await mkdir(tmpBase, { recursive: true });
  base = await mkdtemp(path.join(tmpBase, 'base-'));
  pid = 'p1';
  // projectWorkspaceRoot = PREVIEW_PROJECTS_ROOT + '/' + projectId
  envMock.PREVIEW_PROJECTS_ROOT = base.replace(/[\\/]+$/, '');
  await mkdir(path.join(base, pid), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
});

describe('normalizeRelPath — traversal / absolute / drive / UNC', () => {
  it('rejects ../ traversal (posix + windows separators)', () => {
    expect(normalizeRelPath('../outside.txt')).toBe('');
    expect(normalizeRelPath('..\\..\\evil.txt')).toBe('');
    expect(normalizeRelPath('src/../../evil.txt')).toBe('');
  });

  it('rejects absolute POSIX paths outright or keeps them confined', () => {
    // A leading slash is stripped by design (root-relative semantics); the
    // resolved path must still land inside the project root.
    const rel = normalizeRelPath('/etc/passwd');
    if (rel !== '') {
      expect(resolveUnderRoot(pid, '/etc/passwd').startsWith(base)).toBe(true);
    } else {
      expect(rel).toBe('');
    }
  });

  it('rejects Windows drive-letter paths on any platform', () => {
    expect(normalizeRelPath('C:/Windows/System32/x')).toBe('');
    expect(normalizeRelPath('C:\\Windows\\x')).toBe('');
    expect(normalizeRelPath('D:relative\\x')).toBe('');
    expect(normalizeRelPath('c:/x')).toBe('');
  });

  it('rejects UNC paths (server share, \\?\\ and \\.\\)', () => {
    expect(normalizeRelPath('\\\\server\\share\\x')).toBe('');
    expect(normalizeRelPath('//server/share/x')).toBe('');
    expect(normalizeRelPath('\\\\?\\C:\\Windows\\x')).toBe('');
    expect(normalizeRelPath('//?/C:/Windows/x')).toBe('');
    expect(normalizeRelPath('\\\\.\\PhysicalDrive0')).toBe('');
  });

  it('rejects home-directory expansion', () => {
    expect(normalizeRelPath('~/.ssh/id_rsa')).toBe('');
    expect(normalizeRelPath('~/x')).toBe('');
    expect(normalizeRelPath('~')).toBe('');
  });

  it('accepts legitimate nested relative paths', () => {
    expect(normalizeRelPath('src/app/hello.ts')).toBe('src/app/hello.ts');
    expect(normalizeRelPath('a/./b')).toBe('a/b');
    expect(normalizeRelPath('notes.md')).toBe('notes.md');
  });
});

describe('resolveUnderRoot — symlink / junction escape', () => {
  it('resolves a normal nested path inside the root', async () => {
    await mkdir(path.join(base, pid, 'src'), { recursive: true });
    await writeFile(path.join(base, pid, 'src', 'a.ts'), 'x', 'utf8');
    const abs = resolveUnderRoot(pid, 'src/a.ts');
    expect(abs.startsWith(base)).toBe(true);
  });

  it('rejects traversal at resolve time', () => {
    expect(() => resolveUnderRoot(pid, '../outside.txt')).toThrow();
  });

  it('rejects symlink escape to an outside file', async () => {
    const outside = path.join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'topsecret', 'utf8');
    await symlink(outside, path.join(base, pid, 'link-out'), 'dir');
    expect(() => resolveUnderRoot(pid, 'link-out/secret.txt')).toThrow(/escapes the project workspace/);
  });

  it('rejects symlink escape in the parent chain for new files', async () => {
    const outside = path.join(base, 'outside2');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(base, pid, 'link-new'), 'dir');
    expect(() => resolveUnderRoot(pid, 'link-new/newfile.txt')).toThrow(/escapes the project workspace/);
  });

  it('rejects symlink file escape', async () => {
    const outsideFile = path.join(base, 'evil.txt');
    await writeFile(outsideFile, 'evil', 'utf8');
    try {
      await symlink(outsideFile, path.join(base, pid, 'evil-link.txt'), 'file');
    } catch {
      return; // symlink privilege unavailable — skip
    }
    expect(() => resolveUnderRoot(pid, 'evil-link.txt')).toThrow(/escapes the project workspace/);
  });

  it('allows symlinks that stay inside the root', async () => {
    const sub = path.join(base, pid, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'ok.txt'), 'ok', 'utf8');
    try {
      await symlink(sub, path.join(base, pid, 'link-in'), 'dir');
    } catch {
      return; // symlink privilege unavailable — skip
    }
    const abs = resolveUnderRoot(pid, 'link-in/ok.txt');
    expect(abs.startsWith(base)).toBe(true);
  });

  it('rejects junctions escaping the root (windows) — skipped where unsupported', async () => {
    if (process.platform !== 'win32') return;
    const outside = path.join(base, 'j-outside');
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, path.join(base, pid, 'j-link'), 'junction');
    } catch {
      return; // needs privilege — skip
    }
    expect(() => resolveUnderRoot(pid, 'j-link/x.txt')).toThrow(/escapes the project workspace/);
  });
});

describe('protected paths', () => {
  it('flags .env, private keys and credential files', () => {
    expect(isProtectedRelPath('.env')).toBe(true);
    expect(isProtectedRelPath('config/.env')).toBe(true);
    expect(isProtectedRelPath('id_rsa')).toBe(true);
    expect(isProtectedRelPath('.ssh/id_ed25519')).toBe(true);
    expect(isProtectedRelPath('certs/key.pem')).toBe(true);
    expect(isProtectedRelPath('deploy.key')).toBe(true);
    expect(isProtectedRelPath('src/app.ts')).toBe(false);
  });

  it('assertNotProtected throws for secrets, passes for code', () => {
    expect(() => assertNotProtected('.env')).toThrow(/protected/);
    expect(() => assertNotProtected('keys/id_rsa')).toThrow(/protected/);
    expect(() => assertNotProtected('src/app.ts')).not.toThrow();
  });
});
