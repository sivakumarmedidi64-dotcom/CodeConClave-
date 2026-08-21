/**
 * CodeConClave — files Phase 8 foundation tests.
 * Covers: path normalization/traversal rejection, protected-path and blocked
 * MIME/extension policy, upload (new + overwrite versioning), at-rest
 * encryption round-trip with hash verification, metadata (tags/category/
 * favorite), preview metadata honesty (OCR always UNAVAILABLE), access
 * control (owner/role/grants), references, and folder tree.
 * DB, audit, workspace usage and storage are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sha256Hex } from '../shared/crypto.js';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const incrementUsage = vi.hoisted(() => vi.fn(async () => 0));
const getStorageUsage = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../modules/workspace/service.js', () => ({ incrementUsage, getStorageUsage }));

const getProject = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'p1', owner_id: 'u1', name: 'Project', deleted_at: null })),
);
vi.mock('../modules/projects/service.js', () => ({ getProject }));

const idsMock = vi.hoisted(() => {
  let n = 0;
  return {
    reset: () => {
      n = 0;
    },
    newId: (prefix: string) => `${prefix}_${++n}`,
    PREFIX: { FILE: 'fil', ARTIFACT: 'art' },
  };
});
vi.mock('../shared/ids.js', () => idsMock);

const envMock = vi.hoisted(() => ({
  SESSION_SECRET: 'test-secret',
  APP_NAME: 'codeconclave',
  MAX_UPLOAD_MB: 25,
  STORAGE_AT_REST_ENCRYPTION: 'false',
}));
vi.mock('../config/env.js', () => ({ env: envMock }));

const storageMock = vi.hoisted(() => {
  const map = new Map<string, Buffer>();
  const put = vi.fn(async (key: string, data: Buffer) => {
    map.set(key, data);
  });
  const get = vi.fn(async (key: string) => {
    if (!map.has(key)) throw new Error(`missing ${key}`);
    return map.get(key)!;
  });
  const storageEncryptionEnabled = vi.fn(() => false);
  return {
    map,
    put,
    get,
    exists: vi.fn(async (key: string) => map.has(key)),
    delete: vi.fn(async (key: string) => {
      map.delete(key);
    }),
    size: vi.fn(async (key: string) => map.get(key)?.length ?? 0),
    health: vi.fn(async () => true),
    kind: 'memory',
    storageEncryptionEnabled,
    storageMode: vi.fn(() => 'LOCAL_STORAGE'),
    storageHealth: vi.fn(async () => ({ ok: true, checkedAt: '2026-01-01T00:00:00.000Z' })),
  };
});
vi.mock('../integrations/storage.js', () => ({
  storage: storageMock,
  storageEncryptionEnabled: storageMock.storageEncryptionEnabled,
  storageMode: storageMock.storageMode,
  storageHealth: storageMock.storageHealth,
}));

import {
  normalizePath,
  uploadFile,
  getFile,
  getFileContent,
  fileTree,
  fileVersions,
  restoreFileVersion,
  setFileTags,
  setFileCategory,
  toggleFavorite,
  addFileReference,
  setFilePermission,
  favoriteFiles,
  recentFiles,
  listFiles,
} from '../modules/files/service.js';
import { AppError } from '../shared/errors.js';

function fileRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    owner_id: 'u1',
    path: 'docs/readme.md',
    size_bytes: 12,
    sha256: 'a'.repeat(64),
    storage_key: null,
    storage_provider: 'memory',
    mime_type: 'text/markdown',
    is_directory: false,
    tags: [],
    category: null,
    description: null,
    is_favorite: false,
    preview_kind: 'markdown',
    preview_status: 'AVAILABLE',
    ocr_status: 'UNAVAILABLE',
    encrypted: false,
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function callsMatching(fragment: string) {
  return db.state.calls.filter((c) => c.text.includes(fragment));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  idsMock.reset();
  storageMock.map.clear();
  recordAudit.mockClear();
  incrementUsage.mockClear();
  getProject.mockClear();
  storageMock.storageEncryptionEnabled.mockReturnValue(false);
});

afterEach(() => {
  db.state.resolve = null;
});

describe('normalizePath (security)', () => {
  it('cleans backslashes, leading slashes and dot segments', () => {
    expect(normalizePath('\\docs\\a.md')).toBe('docs/a.md');
    expect(normalizePath('/docs//a.md')).toBe('docs/a.md');
    expect(normalizePath('./docs/a.md')).toBe('docs/a.md');
    expect(normalizePath('   ')).toBe('');
  });

  it('rejects traversal — ".." makes the whole path invalid', () => {
    expect(normalizePath('../secret.txt')).toBe('');
    expect(normalizePath('docs/../../etc/passwd')).toBe('');
  });
});

describe('uploadFile (security + metadata + versioning)', () => {
  it('rejects protected resources (.env, keys, credentials)', async () => {
    for (const p of ['.env', 'cfg/.env.prod', 'keys/id_rsa', 'secrets.json', 'credentials.json']) {
      await expect(uploadFile('u1', 'p1', p, Buffer.from('x'))).rejects.toMatchObject({ errorCode: 'protected_path' });
    }
  });

  it('rejects blocked executables (.exe) and MIME types', async () => {
    await expect(uploadFile('u1', 'p1', 'tool.exe', Buffer.from('MZ'))).rejects.toMatchObject({ errorCode: 'blocked_type' });
    await expect(
      uploadFile('u1', 'p1', 'tool.bin', Buffer.from('MZ'), 'application/x-msdownload'),
    ).rejects.toMatchObject({ errorCode: 'blocked_type' });
  });

  it('rejects files over the upload limit', async () => {
    envMock.MAX_UPLOAD_MB = 1;
    try {
      await expect(uploadFile('u1', 'p1', 'big.bin', Buffer.alloc(2 * 1024 * 1024))).rejects.toMatchObject({
        errorCode: 'file_too_large',
      });
    } finally {
      envMock.MAX_UPLOAD_MB = 25;
    }
  });

  it('rejects invalid paths (empty / control characters)', async () => {
    await expect(uploadFile('u1', 'p1', 'a\u0000b', Buffer.from('x'))).rejects.toMatchObject({ errorCode: 'path_invalid' });
  });

  it('inserts a new file with metadata, preview and OCR honesty, stores content, versions it', async () => {
    const buffer = Buffer.from('# hello');
    const sha = sha256Hex(buffer);
    db.state.resolve = (text, _p) => {
      if (text.includes('FROM files WHERE project_id') && text.includes('AND path')) return [];
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_1', { sha256: sha, storage_key: storageMock.map.keys().next().value ?? 'k', path: 'docs/readme.md' })];
      return null;
    };
    const file = await uploadFile('u1', 'p1', 'docs\\readme.md', buffer, 'text/markdown', {
      tags: ['notes', 'notes', 'very-long-tag-name-that-should-be-truncated-please'],
      category: 'Reference',
      description: 'Read me',
    });

    expect(file.path).toBe('docs/readme.md');
    const insert = callsMatching('INSERT INTO files')[0];
    expect(insert).toBeDefined();
    const p = insert.params;
    expect(p[1]).toBe('p1');
    expect(p[2]).toBe('u1');
    expect(p[3]).toBe('docs/readme.md');
    expect(p[4]).toBe(buffer.length);
    expect(p[5]).toBe(sha);
    expect(p[7]).toBe('memory');
    expect(p[9]).toEqual(['notes', 'very-long-tag-name-that-should-be-trunca']);
    expect(p[12]).toBe('MARKDOWN');
    expect(p[13]).toBe('AVAILABLE');
    expect(p[14]).toBe('UNAVAILABLE'); // OCR is never faked
    expect(p[15]).toBe(false);

    const versionInsert = callsMatching('INSERT INTO file_versions')[0];
    expect(versionInsert.text).toContain("'upload',$6,0");
    expect(versionInsert.params[1]).toBe('fil_1');

    expect(storageMock.put).toHaveBeenCalledTimes(1);
    const storedKey = storageMock.put.mock.calls[0][0];
    expect(storedKey).toContain('projects/p1/');
    expect(sha256Hex(storageMock.map.get(storedKey)!)).toBe(sha);
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'storage_bytes_used', buffer.length);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.uploaded' }));
  });

  it('overwrite upload creates a new version referencing the parent version', async () => {
    const v1 = Buffer.from('v1');
    const v2 = Buffer.from('v2 longer content');
    const sha1 = sha256Hex(v1);
    db.state.resolve = (text) => {
      if (text.includes('FROM files WHERE project_id') && text.includes('AND path')) return [{ id: 'fil_9' }];
      if (text.includes('SELECT size_bytes, encrypted FROM files')) return [{ size_bytes: v1.length, encrypted: false }];
      if (text.includes('COALESCE(MAX(version)')) return [{ v: 1 }];
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_9', { sha256: sha1 })];
      return null;
    };
    await uploadFile('u1', 'p1', 'docs/readme.md', v2, 'text/markdown');

    const update = callsMatching('UPDATE files SET')[0];
    expect(update).toBeDefined();
    const versionInsert = callsMatching('INSERT INTO file_versions').find((c) => c.text.includes('parent_version'));
    expect(versionInsert).toBeDefined();
    const vp = versionInsert!.params;
    expect(vp[2]).toBe(2); // version
    expect(vp[7]).toBe(1); // parent_version
  });
});

describe('at-rest encryption (honest, never faked)', () => {
  it('encrypts on upload and decrypts on read with hash verification', async () => {
    storageMock.storageEncryptionEnabled.mockReturnValue(true);
    const buffer = Buffer.from('top secret payload');
    const sha = sha256Hex(buffer);
    db.state.resolve = (text) => {
      if (text.includes('FROM files WHERE project_id') && text.includes('AND path')) return [];
      if (text.includes('SELECT * FROM files WHERE id')) {
        const key = storageMock.map.keys().next().value ?? 'codeconclave/projects/p1/fil_1';
        return [fileRow('fil_2', { sha256: sha, storage_key: key, encrypted: true })];
      }
      return null;
    };
    await uploadFile('u1', 'p1', 'a.txt', buffer, 'text/plain');
    const storedKey = storageMock.map.keys().next().value;
    expect(storedKey).toBeDefined();
    const stored = storageMock.map.get(storedKey as string);
    expect(stored!.toString('utf8')).toMatch(/^v1:/);

    const { buffer: raw } = await getFileContent('u1', 'p1', 'fil_2');
    expect(raw.toString()).toBe('top secret payload');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.read', resourceId: 'fil_2' }));
  });

  it('rejects reads when the stored hash does not match the record', async () => {
    const buffer = Buffer.from('payload');
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM files WHERE id')) {
        return [fileRow('fil_3', { sha256: 'f'.repeat(64), storage_key: 'k3' })];
      }
      return null;
    };
    storageMock.map.set('k3', buffer);
    await expect(getFileContent('u1', 'p1', 'fil_3')).rejects.toMatchObject({ errorCode: 'hash_mismatch' });
  });
});

describe('versions and rollback', () => {
  it('restores a historical version, writing a rollback reference', async () => {
    const v1 = Buffer.from('version one');
    const v2 = Buffer.from('version two, much longer than the first one');
    const sha1 = sha256Hex(v1);
    const sha2 = sha256Hex(v2);
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_4', { sha256: sha2, storage_key: 'k4' })];
      if (text.includes('SELECT * FROM file_versions')) {
        return [{ version: params[1], content_sha256: sha1, size_bytes: v1.length, storage_key: 'k4v1' }];
      }
      if (text.includes('COALESCE(MAX(version)')) return [{ v: 2 }];
      return null;
    };
    storageMock.map.set('k4', v2);
    storageMock.map.set('k4v1', v1);

    await restoreFileVersion('u1', 'p1', 'fil_4', 1);

    expect(sha256Hex(storageMock.map.get('k4')!)).toBe(sha1);
    const rollback = callsMatching('INSERT INTO file_versions').find((c) => c.text.includes('rollback_reference'));
    expect(rollback).toBeDefined();
    const rp = rollback!.params;
    expect(rp[2]).toBe(3); // version 3 (was 2)
    expect(rp[6]).toBe('restore-v1');
    expect(rp[9]).toBe('version:1');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.version_restored', resourceId: 'fil_4' }),
    );
  });

  it('refuses to restore when the current hash does not match', async () => {
    db.state.resolve = (text, _p) => {
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_5', { storage_key: 'k5' })];
      if (text.includes('SELECT * FROM file_versions')) {
        return [{ version: 1, content_sha256: 'b'.repeat(64), size_bytes: 3, storage_key: 'k5' }];
      }
      return null;
    };
    storageMock.map.set('k5', Buffer.from('corrupted'));
    await expect(restoreFileVersion('u1', 'p1', 'fil_5', 1)).rejects.toMatchObject({ errorCode: 'hash_mismatch' });
  });

  it('fileVersions includes parent_version and rollback_reference', async () => {
    db.state.resolve = (text) => (text.includes('FROM files WHERE id') ? [fileRow('fil_6')] : null);
    await fileVersions('u1', 'p1', 'fil_6');
    const sel = callsMatching('FROM file_versions')[0];
    expect(sel.text).toContain('parent_version');
    expect(sel.text).toContain('rollback_reference');
  });
});

describe('metadata: tags, category, favorite', () => {
  beforeEach(() => {
    db.state.resolve = (text) => (text.includes('FROM files WHERE id') ? [fileRow('fil_7')] : null);
  });

  it('dedupes, trims and caps tags', async () => {
    await setFileTags('u1', 'p1', 'fil_7', ['a', 'a', ' b ', '', 'c'.repeat(200)]);
    const update = callsMatching('UPDATE files SET tags')[0];
    expect(update!.params[1]).toEqual(['a', 'b', 'c'.repeat(40)]);
  });

  it('updates category and favorite with audit', async () => {
    await setFileCategory('u1', 'p1', 'fil_7', '  Design  ');
    expect(callsMatching('UPDATE files SET category')[0]!.params[1]).toBe('Design');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.category_updated' }));

    await toggleFavorite('u1', 'p1', 'fil_7', true);
    expect(callsMatching('UPDATE files SET is_favorite')[0]!.params[1]).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.favorited' }));
  });
});

describe('access control', () => {
  it('denies non-owner without role or grant', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_8', { owner_id: 'other' })];
      return null;
    };
    await expect(setFilePermission('u1', 'p1', 'fil_8', 'read', 'u3', true)).rejects.toMatchObject({ status: 403 });
  });

  it('allows the owner to grant and records permission audit', async () => {
    db.state.resolve = (text) => (text.includes('FROM files WHERE id') ? [fileRow('fil_8')] : null);
    await setFilePermission('u1', 'p1', 'fil_8', 'write', 'u3', true);
    const insert = callsMatching('INSERT INTO file_permissions')[0];
    expect(insert!.params[3]).toBe('write');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.permission_granted' }));
  });

  it('honors an explicit grant for a non-owner', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_8', { owner_id: 'other' })];
      if (text.includes('FROM file_permissions')) return [{ ok: 1 }];
      return null;
    };
    await addFileReference('u1', 'p1', 'fil_8', 'artifact', 'art_1');
    expect(callsMatching('INSERT INTO file_references')[0]).toBeDefined();
  });
});

describe('references', () => {
  it('supports artifact and conversation reference types', async () => {
    db.state.resolve = (text) => (text.includes('FROM files WHERE id') ? [fileRow('fil_9')] : null);
    await addFileReference('u1', 'p1', 'fil_9', 'artifact', 'art_1');
    await addFileReference('u1', 'p1', 'fil_9', 'conversation', 'con_1');
    const inserts = callsMatching('INSERT INTO file_references');
    expect(inserts).toHaveLength(2);
    expect(recordAudit).toHaveBeenCalledTimes(2);
  });
});

describe('folder tree, favorites, recent', () => {
  it('builds a nested tree from the flat file list', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM files WHERE project_id') && !text.includes('deleted_at IS NULL')) return null;
      if (text.includes('FROM files')) {
        return [
          fileRow('a', { path: 'root.txt' }),
          fileRow('b', { path: 'docs/guide/readme.md' }),
          fileRow('c', { path: 'docs/api.md' }),
        ];
      }
      return null;
    };
    const tree = await fileTree('u1', 'p1');
    expect(tree.find((n) => n.name === 'root.txt')).toBeDefined();
    const docs = tree.find((n) => n.name === 'docs');
    expect(docs?.type).toBe('folder');
    expect(docs?.children?.find((n) => n.name === 'api.md')).toBeDefined();
    const guide = docs?.children?.find((n) => n.name === 'guide');
    expect(guide?.children?.find((n) => n.name === 'readme.md')).toBeDefined();
  });

  it('favorites and recent are tenant-scoped to owner or member projects', async () => {
    db.state.resolve = null;
    await favoriteFiles('u1');
    await recentFiles('u1');
    const fav = callsMatching('AND f.deleted_at IS NULL AND f.is_favorite')[0];
    const rec = callsMatching('ORDER BY f.updated_at DESC LIMIT 20')[0];
    expect(fav.text).toContain('owner_id = $1');
    expect(rec.text).toContain('project_members');
  });

  it('listFiles requires project access and excludes trashed', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM files WHERE project_id')) return [fileRow('x')];
      return null;
    };
    const files = await listFiles('u1', 'p1');
    expect(files).toHaveLength(1);
    expect(callsMatching('FROM files WHERE project_id')[0].text).toContain('deleted_at IS NULL');
  });
});

describe('getFile / not found', () => {
  it('throws not found when the row is missing', async () => {
    db.state.resolve = null;
    await expect(getFile('u1', 'p1', 'fil_zz')).rejects.toMatchObject({ status: 404 });
  });
});