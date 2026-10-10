/**
 * CodeConClave — Artifact Center Phase 8 tests.
 * Task-scoped artifact creation with authorization (owner/editor/member),
 * storage-backed buffers with SHA-256 verification, merged listing of task
 * + coworker artifacts (tenant-scoped), downloads (inline or base64 from
 * storage) and artifact references. Audits ARTIFACT_CREATED / DOWNLOADED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const getProject = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'p1', owner_id: 'u1', name: 'Project', deleted_at: null })),
);
vi.mock('../modules/projects/service.js', () => ({ getProject }));

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
    PREFIX: { ARTIFACT: 'art' },
  };
});
vi.mock('../shared/ids.js', () => idsMock);

import { createTaskArtifact, listArtifacts, downloadArtifact, artifactReferences } from '../modules/artifacts/service.js';

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { project_id: 'p1', owner_id: 'u1', ...overrides };
}

function artifactRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: 'report.md',
    kind: 'test_report',
    sha256: 'a'.repeat(64),
    size_bytes: 12,
    content: null,
    storage_key: null,
    verification: null,
    attempt_id: null,
    created_at: new Date(),
    task_id: 'tsk_1',
    task_title: 'Run tests',
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
  getProject.mockClear();
});

describe('createTaskArtifact', () => {
  it('creates a content artifact as the task owner with audit', async () => {
    const content = '# report';
    const sha = sha256Hex(Buffer.from(content));
    db.state.resolve = (text, params) => {
      if (text.includes('FROM tasks')) return [taskRow()];
      if (text.includes('FROM artifacts a')) return [artifactRow('art_1', { sha256: sha, content })];
      return null;
    };
    const artifact = await createTaskArtifact({ userId: 'u1', taskId: 'tsk_1', name: 'report.md', kind: 'test_report', content });
    expect(artifact.id).toBe('art_1');

    const insert = callsMatching('INSERT INTO artifacts')[0];
    expect(insert).toBeDefined();
    expect(insert.params[1]).toBe('tsk_1');
    expect(insert.params[7]).toBe(content);
    expect(insert.params[8]).toBeNull(); // no attempt
    expect(insert.params[9]).toBeNull(); // no verification
    expect(insert.params[10]).toBe('u1'); // created_by
    expect(storageMock.put).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'artifact.created' }));
  });

  it('stores buffers in storage with SHA-256 and leaves content null', async () => {
    const payload = Buffer.from('binary payload');
    const sha = sha256Hex(payload);
    db.state.resolve = (text) => {
      if (text.includes('SELECT project_id, owner_id FROM tasks')) return [taskRow()];
      if (text.includes('FROM artifacts a')) return [artifactRow('art_1', { sha256: sha, content: null })];
      return null;
    };
    await createTaskArtifact({
      userId: 'u1',
      taskId: 'tsk_1',
      name: 'build.bin',
      kind: 'deployment_output',
      buffer: payload,
      verification: 'PASS',
    });
    const insert = callsMatching('INSERT INTO artifacts')[0];
    expect(insert!.params[4]).toContain('artifacts/p1/tsk_1/');
    expect(insert!.params[7]).toBeNull();
    expect(insert!.params[9]).toBe('PASS');
    expect(storageMock.put).toHaveBeenCalledTimes(1);
    expect(storageMock.map.get(insert!.params[4] as string)).toEqual(payload);
  });

  it('denies members without a role and non-owners', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM tasks')) return [taskRow({ owner_id: 'other' })];
      return null;
    };
    await expect(
      createTaskArtifact({ userId: 'u2', taskId: 'tsk_1', name: 'x', kind: 'log', content: 'y' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows editors via project membership', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM tasks')) return [taskRow({ owner_id: 'other' })];
      if (text.includes('FROM artifacts a')) return [artifactRow('art_1')];
      return null;
    };
    db.state.rows = [{ role: 'editor' }];
    const artifact = await createTaskArtifact({ userId: 'u2', taskId: 'tsk_1', name: 'x', kind: 'log', content: 'y' });
    expect(artifact.id).toBe('art_1');
  });

  it('rejects when the task is missing', async () => {
    db.state.resolve = null;
    await expect(
      createTaskArtifact({ userId: 'u1', taskId: 'tsk_zz', name: 'x', kind: 'log', content: 'y' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('listArtifacts', () => {
  it('merges task and coworker artifacts, sorted newest first, tenant-scoped', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM artifacts a')) {
        return [artifactRow('art_1', { created_at: new Date('2026-01-02') })];
      }
      if (text.includes('FROM coworker_artifacts ca')) {
        return [
          artifactRow('art_2', {
            created_at: new Date('2026-01-03'),
            run_id: 'crw_1',
            coworker_type: 'researcher',
            verification: 'PASS',
            attempt_id: 'atp_1',
          }),
        ];
      }
      return null;
    };
    const all = await listArtifacts('u1');
    expect(all).toHaveLength(2);
    expect(all[0]!.source).toBe('coworker');
    expect(all[1]!.source).toBe('task');
    expect(all[0]!.runId).toBe('crw_1');
    expect(all[0]!.attemptId).toBe('atp_1');

    for (const q of callsMatching('WHERE')) {
      expect(q.text).toContain('project_members');
    }
  });

  it('applies taskId, projectId and kind filters', async () => {
    db.state.resolve = (text) => (text.includes('FROM artifacts a') ? [] : null);
    await listArtifacts('u1', { taskId: 'tsk_9', projectId: 'p9', kind: 'log' });
    const sql = callsMatching('FROM artifacts a')[0];
    const p = sql.params;
    expect(p[0]).toBe('u1');
    expect(p[1]).toBe('p9');
    expect(sql.text).toContain('t.project_id = $2');
    expect(p[2]).toBe('tsk_9');
    expect(sql.text).toContain('a.task_id = $3');
    expect(p[3]).toBe('log');
    expect(sql.text).toContain('a.kind = $4');
  });
});

describe('downloadArtifact + references', () => {
  it('returns inline content for text artifacts', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM artifacts a')) return [artifactRow('art_1', { content: 'hello' })];
      if (text.includes('SELECT content, storage_key FROM artifacts')) {
        return [{ content: 'hello', storage_key: null }];
      }
      return null;
    };
    const download = await downloadArtifact('u1', 'art_1');
    expect(download.content).toBe('hello');
    expect(download.encoding).toBe('utf8');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'artifact.downloaded' }));
  });

  it('returns base64 content for storage-backed artifacts', async () => {
    const payload = Buffer.from('raw bytes');
    storageMock.map.set('k-storage', payload);
    db.state.resolve = (text) => {
      if (text.includes('FROM artifacts a')) {
        return [artifactRow('art_1', { content: null, sha256: sha256Hex(payload) })];
      }
      if (text.includes('SELECT content, storage_key FROM artifacts')) {
        return [{ content: null, storage_key: 'k-storage' }];
      }
      return null;
    };
    const download = await downloadArtifact('u1', 'art_1');
    expect(download.encoding).toBe('base64');
    expect(download.content).toBe(payload.toString('base64'));
  });

  it('lists only artifact references and requires access', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM artifacts a')) return [artifactRow('art_1')];
      if (text.includes('FROM file_references')) {
        return [{ id: 'ref_1', file_id: 'fil_1', ref_type: 'artifact', ref_id: 'art_1' }];
      }
      return null;
    };
    const refs = await artifactReferences('u1', 'art_1');
    expect(refs).toHaveLength(1);
    const sql = callsMatching('FROM file_references')[0];
    expect(sql.text).toContain("ref_type = 'artifact'");
    expect(sql.params[0]).toBe('art_1');
  });

  it('rejects download of an artifact outside the tenant scope', async () => {
    db.state.resolve = null;
    await expect(downloadArtifact('u2', 'art_zz')).rejects.toMatchObject({ status: 404 });
  });

  it('binds the tenant user id before the artifact id on the access check', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM artifacts a')) return [artifactRow('art_1', { content: 'x' })];
      if (text.includes('SELECT content, storage_key FROM artifacts')) return [{ content: 'x', storage_key: null }];
      return null;
    };
    await downloadArtifact('u1', 'art_1');
    const access = callsMatching('FROM artifacts a').find((c) => c.text.includes('p.owner_id'));
    expect(access).toBeTruthy();
    // ARTIFACT_TENANT references $1: it must be the user, not the artifact.
    expect(access!.params[0]).toBe('u1');
    expect(access!.params[1]).toBe('art_1');
  });
});