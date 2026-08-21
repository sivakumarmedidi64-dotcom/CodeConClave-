/**
 * CodeConClave — Phase 13 cleanup recommendation tests: deterministic
 * generation from real queries, persistence, resolution flow. DB mocked.
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

import {
  generateCleanupRecommendations,
  listCleanupRecommendations,
  resolveCleanupRecommendation,
} from '../modules/recommendations/service.js';

function recRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cln_1',
    owner_id: 'u1',
    candidate_type: 'duplicate_files',
    reason: '2 file(s) share content',
    storage_impact_bytes: 500,
    affected: [{ id: 'fil_2', name: '/b.txt' }],
    reversible: false,
    authorization_level: 'owner',
    status: 'ACTIVE',
    created_at: new Date('2026-01-01T00:00:00Z'),
    resolved_at: null,
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('generateCleanupRecommendations', () => {
  it('replaces ACTIVE rows and derives candidates from real queries only', async () => {
    db.state.resolve = (text) => {
      if (text.includes('AND EXISTS (') && text.includes('FROM files f')) {
        return [{ id: 'fil_2', path: '/dup.txt', size_bytes: 20 }];
      }
      if (text.includes("SELECT f.id, f.path, f.size_bytes FROM files f\n     WHERE")) {
        return [{ id: 'fil_9', path: '/old.txt', size_bytes: 10 }];
      }
      if (text.includes('SELECT id, title FROM conversations')) return [{ id: 'con_1', title: 'Old chat' }];
      if (text.includes('SELECT id, content FROM memories')) return [];
      if (text.includes('SELECT id, title FROM dna')) return [];
      if (text.includes('SELECT id, title FROM ideas')) return [];
      if (text.includes('AND EXISTS (')) return [{ id: 'fil_2', path: '/dup.txt', size_bytes: 20 }];
      if (text.includes('FROM artifacts a\n     JOIN tasks t')) return [];
      if (text.includes('FROM file_versions fv\n     JOIN files f')) return [];
      if (text.includes('SELECT id, type FROM notifications')) return [{ id: 'ntf_1', type: 'reminder' }];
      return null;
    };
    const count = await generateCleanupRecommendations('u1');
    expect(count).toBe(4);
    const deletes = db.state.calls.filter((c) => c.text.includes("DELETE FROM cleanup_recommendations"));
    expect(deletes).toHaveLength(1);
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO cleanup_recommendations'));
    expect(inserts).toHaveLength(4);
    const dup = inserts.find((c) => c.params.includes('duplicate_files'))!;
    expect(dup.params[4]).toBe(20);
    const notif = inserts.find((c) => c.params.includes('expired_notifications'))!;
    expect(notif.params[6]).toBe(true);
    expect(db.state.calls.some((c) => c.params.includes('cleanup.recommended'))).toBe(true);
  });

  it('generates nothing when there are no candidates and does not audit', async () => {
    const count = await generateCleanupRecommendations('u1');
    expect(count).toBe(0);
    expect(db.state.calls.some((c) => c.params.includes('cleanup.recommended'))).toBe(false);
  });
});

describe('listCleanupRecommendations', () => {
  it('filters by status', async () => {
    db.state.resolve = (text) => (text.includes('FROM cleanup_recommendations') ? [recRow()] : null);
    const rows = await listCleanupRecommendations('u1', 'ACTIVE');
    expect(rows).toHaveLength(1);
    expect(rows[0].candidateType).toBe('duplicate_files');
    const call = db.state.calls.find((c) => c.text.includes('FROM cleanup_recommendations'));
    expect(call!.text).toContain('status = $2');
  });
});

describe('resolveCleanupRecommendation', () => {
  it('resolves only ACTIVE recommendations owned by the caller', async () => {
    db.state.resolve = (text) =>
      text.includes('UPDATE cleanup_recommendations SET status = $1') ? [recRow({ status: 'RESOLVED', resolved_at: new Date() })] : null;
    const result = await resolveCleanupRecommendation('u1', 'cln_1', 'RESOLVED');
    expect(result.status).toBe('RESOLVED');
    expect(db.state.calls.some((c) => c.params.includes('cleanup.resolved'))).toBe(true);
  });

  it('rejects invalid statuses', async () => {
    await expect(resolveCleanupRecommendation('u1', 'cln_1', 'MAYBE')).rejects.toMatchObject({ errorCode: 'invalid_status' });
  });

  it('is not found when the recommendation belongs to someone else', async () => {
    await expect(resolveCleanupRecommendation('u2', 'cln_1', 'DISMISSED')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});