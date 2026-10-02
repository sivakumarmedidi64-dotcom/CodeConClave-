/**
 * CodeConClave — Phase 13 data centre tests: real persisted metrics (counts,
 * storage, allocations), retention policy, honest provider/backup state and
 * persisted cleanup recommendations. DB mocked; storage adapter mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
vi.mock('../modules/workspace/service.js', () => ({ getStorageUsage: vi.fn() }));
vi.mock('../integrations/storage.js', () => ({
  storageMode: vi.fn(() => 'LOCAL_STORAGE'),
  storageEncryptionEnabled: vi.fn(() => true),
  storageHealth: vi.fn(async () => ({ ok: true, checkedAt: '2026-01-01T00:00:00Z' })),
}));

import { getStorageUsage } from '../modules/workspace/service.js';
import { getDataCentre } from '../modules/datacentre/service.js';

function countsRow(over: Record<string, unknown> = {}) {
  return {
    file_count: 5,
    trashed_count: 1,
    version_count: 9,
    memory_count: 4,
    task_count: 2,
    artifact_count: 3,
    version_bytes: 1000,
    artifact_bytes: 2000,
    conversation_count: 7,
    message_count: 42,
    dna_count: 3,
    dna_version_count: 6,
    project_count: 2,
    team_count: 1,
    notification_count: 10,
    audit_count: 300,
    idea_count: 8,
    brainstorm_count: 2,
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  vi.mocked(getStorageUsage).mockResolvedValue(1024 * 1024 * 500);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getDataCentre — real metrics', () => {
  it('reports quota, storage, counts, retention, provider and honest backup state', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT plan_id FROM users WHERE id = $1")) return [{ plan_id: 'free' }];
      if (text.includes('AS file_count')) return [countsRow()];
      if (text.includes('count(DISTINCT btrim(split_part')) return [{ n: 2 }];
      if (text.includes('FROM coworker_artifacts ca')) return [{ n: 1, bytes: 500 }];
      if (text.includes('FROM projects p\n   LEFT JOIN files f')) return [{ id: 'prj_1', name: 'App', files: 3, bytes: 100 }];
      if (text.includes('FROM file_activity fa')) return [{ id: 'fa_1', action: 'file.uploaded', file_id: 'fil_1', path: '/a.txt', actor_user_id: 'u1', created_at: new Date() }];
      if (text.includes('FROM files f\n     WHERE')) return [{ id: 'fil_9', path: '/old.txt', size_bytes: 10, deleted_at: new Date(), project_id: 'prj_1' }];
      if (text.includes('SELECT * FROM cleanup_recommendations WHERE owner_id = $1 AND status')) {
        const status = paramsOf(text);
        return status === 'ACTIVE' ? [{ id: 'cln_1', owner_id: 'u1', candidate_type: 'duplicate_files', reason: 'dup', storage_impact_bytes: 500, affected: [{ id: 'fil_2', name: '/b.txt' }], reversible: false, authorization_level: 'owner', status, created_at: new Date(), resolved_at: null }] : [];
      }
      return null;
    };
    const report = await getDataCentre('u1');
    expect(report.quota.plan).toBe('free');
    expect(report.quota.limitBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(report.storage.fileCount).toBe(5);
    expect(report.storage.trashedCount).toBe(1);
    expect(report.counts.conversations).toBe(7);
    expect(report.counts.messages).toBe(42);
    expect(report.counts.dna).toBe(3);
    expect(report.counts.dnaVersions).toBe(6);
    expect(report.counts.notifications).toBe(10);
    expect(report.counts.auditEvents).toBe(300);
    expect(report.counts.ideas).toBe(8);
    expect(report.counts.brainstormSessions).toBe(2);
    expect(report.artifacts.count).toBe(4);
    expect(report.retention.trashDays).toBe(30);
    expect(report.retention.notificationDays).toBe(90);
    expect(report.provider.mode).toBe('LOCAL_STORAGE');
    expect(report.backup.available).toBe(false);
    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0]).toMatchObject({ candidateType: 'duplicate_files', reversible: false });
  });

  it('computes plan quota for pro', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT plan_id FROM users WHERE id = $1")) return [{ plan_id: 'pro' }];
      if (text.includes('AS file_count')) return [countsRow()];
      if (text.includes('count(DISTINCT btrim(split_part')) return [{ n: 0 }];
      if (text.includes('FROM coworker_artifacts ca')) return [{ n: 0, bytes: 0 }];
      if (text.includes('FROM projects p\n   LEFT JOIN files f')) return [];
      if (text.includes('FROM file_activity fa')) return [];
      if (text.includes('FROM files f\n     WHERE')) return [];
      if (text.includes('SELECT * FROM cleanup_recommendations WHERE owner_id = $1 AND status')) return [];
      return null;
    };
    const report = await getDataCentre('u1');
    expect(report.quota.limitBytes).toBe(100 * 1024 * 1024 * 1024);
  });

  it('audits the data centre view', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT plan_id FROM users WHERE id = $1")) return [{ plan_id: 'free' }];
      if (text.includes('AS file_count')) return [countsRow()];
      if (text.includes('count(DISTINCT btrim(split_part')) return [{ n: 0 }];
      if (text.includes('FROM coworker_artifacts ca')) return [{ n: 0, bytes: 0 }];
      if (text.includes('FROM projects p\n   LEFT JOIN files f')) return [];
      if (text.includes('FROM file_activity fa')) return [];
      if (text.includes('FROM files f\n     WHERE')) return [];
      if (text.includes('SELECT * FROM cleanup_recommendations WHERE owner_id = $1 AND status')) return [];
      return null;
    };
    await getDataCentre('u1');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO audit_logs') && c.params.includes('datacentre.viewed'))).toBe(true);
  });
});

function paramsOf(_text: string): string {
  const call = db.state.calls.find((c) => c.text.includes('cleanup_recommendations WHERE owner_id = $1 AND status'));
  return String(call?.params[1] ?? '');
}