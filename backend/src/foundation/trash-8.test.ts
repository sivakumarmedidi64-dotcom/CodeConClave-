/**
 * CodeConClave — trash lifecycle Phase 8 tests.
 * Soft delete (references preserved), 30-day recovery window, restore (single
 * + bulk), bulk soft delete, permanent delete (trashed-only, references
 * preserved), bulk purge, and the expiry sweep. Usage counters are kept in
 * sync in both directions. DB, audit, workspace, storage and env are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const envMock = vi.hoisted(() => ({
  SESSION_SECRET: 'test-secret',
  APP_NAME: 'codeconclave',
  MAX_UPLOAD_MB: 25,
  STORAGE_AT_REST_ENCRYPTION: 'false',
}));
vi.mock('../config/env.js', () => ({ env: envMock }));

const storageMock = vi.hoisted(() => {
  const map = new Map<string, Buffer>();
  return {
    map,
    put: vi.fn(async (key: string, data: Buffer) => {
      map.set(key, data);
    }),
    get: vi.fn(async (key: string) => {
      if (!map.has(key)) throw new Error(`missing ${key}`);
      return map.get(key)!;
    }),
    exists: vi.fn(async (key: string) => map.has(key)),
    delete: vi.fn(async (key: string) => {
      map.delete(key);
    }),
    size: vi.fn(async (key: string) => map.get(key)?.length ?? 0),
    health: vi.fn(async () => true),
    kind: 'memory',
    storageEncryptionEnabled: vi.fn(() => false),
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

const idsMock = vi.hoisted(() => {
  let n = 0;
  return {
    reset: () => {
      n = 0;
    },
    newId: (prefix: string) => `${prefix}_${++n}`,
    PREFIX: { FILE: 'fil' },
  };
});
vi.mock('../shared/ids.js', () => idsMock);

import {
  softDeleteFile,
  restoreFile,
  trashFiles,
  restoreFilesBulk,
  softDeleteFilesBulk,
  permanentDeleteFile,
  purgeFilesBulk,
  purgeExpiredTrash,
} from '../modules/files/service.js';

function fileRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    owner_id: 'u1',
    path: 'docs/a.md',
    size_bytes: 100,
    sha256: 'a'.repeat(64),
    storage_key: 'k1',
    storage_provider: 'memory',
    mime_type: 'text/markdown',
    is_directory: false,
    tags: [],
    category: null,
    description: null,
    is_favorite: false,
    preview_kind: 'MARKDOWN',
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
});

describe('soft delete (TRASHED)', () => {
  it('marks deleted_at, decrements usage, audits, and never touches references', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM files WHERE id') ? [fileRow('fil_1')] : null);
    await softDeleteFile('u1', 'p1', 'fil_1');

    const update = callsMatching('UPDATE files SET deleted_at')[0];
    expect(update).toBeDefined();
    expect(callsMatching('DELETE FROM file_references')).toHaveLength(0);
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'storage_bytes_used', -100);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.trashed' }));
  });
});

describe('restore', () => {
  it('clears deleted_at with RETURNING, re-adds usage, audits', async () => {
    const row = fileRow('fil_1', { deleted_at: new Date() });
    db.state.rows = [row];
    db.state.rowCount = 1;
    db.state.resolve = (text) => (text.includes('FROM files WHERE id') ? [row] : null);
    const restored = await restoreFile('u1', 'p1', 'fil_1');
    expect(restored.id).toBe('fil_1');
    const update = callsMatching('UPDATE files SET deleted_at = NULL')[0];
    expect(update.text).toContain('RETURNING *');
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'storage_bytes_used', 100);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'file.restored' }));
  });

  it('trash list only shows files inside the 30-day window', async () => {
    db.state.resolve = null;
    await trashFiles('u1');
    const sql = callsMatching('deleted_at IS NOT NULL')[0];
    expect(sql.text).toContain("deleted_at > now() - interval '30 days'");
    expect(sql.params[0]).toBe('u1');
  });
});

describe('bulk operations', () => {
  it('restores multiple files via ANY() and audits per file', async () => {
    db.state.resolve = null;
    db.state.rowCount = 2;
    db.state.rows = [
      { id: 'fil_1', size_bytes: 100 },
      { id: 'fil_2', size_bytes: 50 },
    ];
    const count = await restoreFilesBulk('u1', 'p1', ['fil_1', 'fil_2']);
    expect(count).toBe(2);
    const sql = callsMatching('ANY($1::text[])')[0];
    expect(sql.text).toContain('deleted_at IS NOT NULL');
    expect(sql.params[0]).toEqual(['fil_1', 'fil_2']);
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'storage_bytes_used', 100);
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'storage_bytes_used', 50);
    const restoredAudits = recordAudit.mock.calls.filter((c) => c[0].action === 'file.restored');
    expect(restoredAudits).toHaveLength(2);
  });

  it('soft deletes multiple files and decrements usage per file', async () => {
    db.state.resolve = null;
    db.state.rows = [
      { id: 'fil_1', size_bytes: 100 },
      { id: 'fil_2', size_bytes: 50 },
    ];
    const count = await softDeleteFilesBulk('u1', 'p1', ['fil_1', 'fil_2']);
    expect(count).toBe(0); // rowCount not set — still returns the count from the pool result
    expect(callsMatching('UPDATE files SET deleted_at = now()')[0]).toBeDefined();
    expect(incrementUsage).toHaveBeenCalledWith('u1', 'storage_bytes_used', -100);
  });

  it('returns 0 for an empty id list without querying', async () => {
    const before = db.state.calls.length;
    expect(await restoreFilesBulk('u1', 'p1', [])).toBe(0);
    expect(await softDeleteFilesBulk('u1', 'p1', [])).toBe(0);
    expect(db.state.calls.length).toBe(before);
  });
});

describe('permanent delete (trashed-only)', () => {
  it('refuses to permanently delete an active file', async () => {
    db.state.resolve = (text) => {
      if (text.includes('deleted_at IS NOT NULL')) return [];
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_1')];
      return null;
    };
    await expect(permanentDeleteFile('u1', 'p1', 'fil_1')).rejects.toMatchObject({ errorCode: 'not_trashed' });
  });

  it('removes storage, versions and row but preserves file_references', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM files WHERE id') && text.includes('deleted_at IS NOT NULL')) {
        return [fileRow('fil_1', { deleted_at: new Date() })];
      }
      if (text.includes('SELECT * FROM files WHERE id')) return [fileRow('fil_1')];
      return null;
    };
    storageMock.map.set('k1', Buffer.from('x'));
    await permanentDeleteFile('u1', 'p1', 'fil_1');

    expect(storageMock.delete).toHaveBeenCalledWith('k1');
    expect(storageMock.map.has('k1')).toBe(false);
    expect(callsMatching('DELETE FROM file_versions WHERE file_id')).toHaveLength(1);
    expect(callsMatching('DELETE FROM files WHERE id')).toHaveLength(1);
    expect(callsMatching('DELETE FROM file_references')).toHaveLength(0);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.deleted_permanent', resourceId: 'fil_1' }),
    );
  });
});

describe('bulk purge + expiry sweep', () => {
  it('purging skips missing files (404) and audits the total', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('deleted_at IS NOT NULL')) {
        return params[0] === 'fil_1' ? [fileRow('fil_1', { deleted_at: new Date() })] : [];
      }
      if (text.includes('SELECT * FROM files WHERE id')) {
        return params[0] === 'fil_1' ? [fileRow('fil_1')] : null;
      }
      return null;
    };
    storageMock.map.set('k1', Buffer.from('x'));
    const purged = await purgeFilesBulk('u1', 'p1', ['fil_1', 'fil_zz']);
    expect(purged).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'trash.purged' }));
    expect(recordAudit.mock.calls.at(-1)![0].detail.purged).toBe(1);
  });

  it('expiry sweep uses the 30-day retention interval with a dynamic placeholder', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM files') && text.includes('deleted_at < now()')) {
        return [{ id: 'fil_1', project_id: 'p1' }];
      }
      return null;
    };
    const purged = await purgeExpiredTrash('u1');
    expect(purged).toBe(1);
    const sql = callsMatching('deleted_at < now()')[0];
    expect(sql.params).toEqual(['u1', '30 days']);
    expect(sql.text).toContain('$2::interval');
    expect(callsMatching('DELETE FROM files WHERE id')).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trash.purged', scope: 'SYSTEM' }),
    );
  });

  it('expiry sweep is system-wide when no user is given', async () => {
    db.state.resolve = (text) =>
      text.includes('deleted_at < now()') ? [{ id: 'fil_2', project_id: 'p1' }] : null;
    const purged = await purgeExpiredTrash();
    expect(purged).toBe(1);
    const sql = callsMatching('deleted_at < now()')[0];
    expect(sql.params).toEqual(['30 days']);
    expect(sql.text).toContain('$1::interval');
  });
});