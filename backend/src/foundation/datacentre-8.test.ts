/**
 * CodeConClave — Data Centre Phase 8 tests.
 * Real persisted metrics only: quota vs plan (free 2GB / pro 100GB), file/
 * version/memory/task/artifact counts, project allocation, activity timeline,
 * cleanup candidates, the storage_meta snapshot and the honest provider
 * status (LOCAL_STORAGE / R2_NOT_CONFIGURED). Every figure comes from the
 * database or live adapters — nothing invented.
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

const storageMock = vi.hoisted(() => ({
  storageMode: vi.fn(() => 'LOCAL_STORAGE'),
  storageEncryptionEnabled: vi.fn(() => false),
  storageHealth: vi.fn(async () => ({ ok: true, checkedAt: '2026-01-01T00:00:00.000Z' })),
}));
vi.mock('../integrations/storage.js', () => ({
  storage: { kind: 'memory' },
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
    PREFIX: { STORAGE_META: 'stm' },
  };
});
vi.mock('../shared/ids.js', () => idsMock);

import { getDataCentre } from '../modules/datacentre/service.js';

function callsMatching(fragment: string) {
  return db.state.calls.filter((c) => c.text.includes(fragment));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  idsMock.reset();
  recordAudit.mockClear();
  getStorageUsage.mockClear();
  getStorageUsage.mockResolvedValue(0);
  storageMock.storageMode.mockReturnValue('LOCAL_STORAGE');
  storageMock.storageEncryptionEnabled.mockReturnValue(false);
});

function fullResolve(plan: string) {
  return (text: string) => {
    if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: plan }];
    if (text.includes('count(*)::int FROM files f WHERE f.owner_id')) {
      return [
        {
          file_count: 3,
          trashed_count: 1,
          version_count: 7,
          memory_count: 4,
          task_count: 5,
          artifact_count: 2,
          version_bytes: 1000,
          artifact_bytes: 500,
        },
      ];
    }
    if (text.includes('FROM coworker_artifacts ca')) return [{ n: 1, bytes: 250 }];
    if (text.includes('count(DISTINCT btrim')) return [{ n: 2 }];
    if (text.includes('FROM projects p')) {
      return [{ id: 'p1', name: 'Alpha', files: 2, bytes: 600 }];
    }
    if (text.includes('FROM file_activity fa')) {
      return [{ id: 'fa_1', action: 'file.uploaded', file_id: 'fil_1', path: 'docs/a.md', actor_user_id: 'u1', created_at: new Date() }];
    }
    if (text.includes('deleted_at < now() - interval')) {
      return [{ id: 'fil_9', path: 'old.txt', size_bytes: 99, deleted_at: new Date(), project_id: 'p1' }];
    }
    return null;
  };
}

describe('getDataCentre', () => {
  it('computes free-plan quota from persisted usage', async () => {
    getStorageUsage.mockResolvedValue(2 * 1024 * 1024);
    db.state.resolve = fullResolve('free');
    const report = await getDataCentre('u1');
    expect(report.quota.plan).toBe('free');
    expect(report.quota.limitBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(report.quota.usedBytes).toBe(2 * 1024 * 1024);
    expect(report.quota.overLimit).toBe(false);
    expect(report.storage.fileCount).toBe(3);
    expect(report.storage.trashedCount).toBe(1);
    expect(report.storage.versionCount).toBe(7);
    expect(report.storage.folderCount).toBe(2);
    expect(report.memories.count).toBe(4);
    expect(report.tasks.count).toBe(5);
    expect(report.artifacts.count).toBe(3); // 2 task + 1 coworker
    expect(report.artifacts.bytes).toBe(750);
  });

  it('uses the pro storage limit for pro plans', async () => {
    getStorageUsage.mockResolvedValue(50 * 1024 * 1024 * 1024);
    db.state.resolve = fullResolve('pro');
    const report = await getDataCentre('u1');
    expect(report.quota.limitBytes).toBe(100 * 1024 * 1024 * 1024);
    expect(report.quota.plan).toBe('pro');
  });

  it('flags over-limit usage', async () => {
    getStorageUsage.mockResolvedValue(3 * 1024 * 1024 * 1024);
    db.state.resolve = fullResolve('free');
    const report = await getDataCentre('u1');
    expect(report.quota.overLimit).toBe(true);
  });

  it('reports project allocation, activity timeline and cleanup candidates', async () => {
    db.state.resolve = fullResolve('free');
    const report = await getDataCentre('u1');
    expect(report.projectAllocation).toEqual([{ id: 'p1', name: 'Alpha', files: 2, bytes: 600 }]);
    expect(report.activity).toHaveLength(1);
    expect(report.activity[0]!.fileName).toBe('a.md');
    expect(report.activity[0]!.action).toBe('file.uploaded');
    expect(report.cleanupCandidates).toEqual([
      { id: 'fil_9', path: 'old.txt', sizeBytes: 99, deletedAt: expect.any(Date), projectId: 'p1' },
    ]);
    expect(report.retentionDays).toBe(30);
  });

  it('persists the provider snapshot to storage_meta', async () => {
    db.state.resolve = fullResolve('free');
    await getDataCentre('u1');
    const upsert = callsMatching('INSERT INTO storage_meta')[0];
    expect(upsert).toBeDefined();
    expect(upsert.params[0]).toBe('stm_1');
    const value = JSON.parse(upsert.params[2] as string);
    expect(value).toEqual({
      mode: 'LOCAL_STORAGE',
      encryptionAtRest: false,
      healthy: true,
      checkedAt: expect.any(String),
    });
  });

  it('reports R2_NOT_CONFIGURED honestly without claiming R2 is active', async () => {
    storageMock.storageMode.mockReturnValue('R2_NOT_CONFIGURED');
    db.state.resolve = fullResolve('free');
    const report = await getDataCentre('u1');
    expect(report.provider.mode).toBe('R2_NOT_CONFIGURED');
    expect(report.provider.encryptionAtRest).toBe(false);
    expect(report.provider.healthy).toBe(true);
  });

  it('audits DATA_CENTRE_VIEWED with real usage numbers', async () => {
    getStorageUsage.mockResolvedValue(1234);
    db.state.resolve = fullResolve('free');
    await getDataCentre('u1');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'datacentre.viewed', actorUserId: 'u1', tenantId: 'u1' }),
    );
    const audit = recordAudit.mock.calls[0]![0];
    expect(audit.detail).toMatchObject({ usedBytes: 1234, fileCount: 3, trashedCount: 1 });
  });
});