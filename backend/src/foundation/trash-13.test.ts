/**
 * CodeConClave — Phase 13 unified trash tests: aggregation across the six
 * soft-delete systems, restore/bulk restore, permanent delete with reference
 * checks, bulk purge and the expiry sweep. DB mocked; per-module restores/
 * purges mocked so the unified policy is what is under test.
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
vi.mock('../modules/files/service.js', () => ({
  restoreFile: vi.fn(),
  permanentDeleteFile: vi.fn(),
  purgeExpiredTrash: vi.fn(),
}));
vi.mock('../modules/projects/service.js', () => ({ restoreProject: vi.fn() }));
vi.mock('../modules/conversations/service.js', () => ({ restoreConversation: vi.fn() }));
vi.mock('../modules/memory/service.js', () => ({ restoreMemory: vi.fn() }));
vi.mock('../modules/dna/service.js', () => ({ restoreDna: vi.fn() }));
vi.mock('../modules/ideas/service.js', () => ({
  restoreIdea: vi.fn(),
  IDEA_TENANT_SQL:
    "(i.owner_id = $1 OR i.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1) OR i.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE'))",
}));

import { restoreFile, permanentDeleteFile, purgeExpiredTrash } from '../modules/files/service.js';
import { restoreProject } from '../modules/projects/service.js';
import { restoreConversation } from '../modules/conversations/service.js';
import { restoreMemory } from '../modules/memory/service.js';
import { restoreDna } from '../modules/dna/service.js';
import { restoreIdea } from '../modules/ideas/service.js';
import { AppError } from '../shared/errors.js';
import {
  listTrash,
  restoreItem,
  restoreBulk,
  purgeItem,
  purgeBulk,
  purgeExpired,
} from '../modules/trash/service.js';

const deletedAt = new Date('2026-02-01T00:00:00Z');

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('listTrash — unified aggregation', () => {
  it('collects trashed items from all six systems within the 30-day window', async () => {
    db.state.resolve = (text) => {
      if (text.includes('JOIN projects p ON p.id = f.project_id')) {
        return [{ id: 'fil_1', path: '/a.txt', size_bytes: 100, deleted_at: deletedAt, project_id: 'prj_1', project_name: 'App', team_id: null, team_name: null }];
      }
      if (text.includes('SELECT p.id, p.name, p.deleted_at')) {
        return [{ id: 'prj_9', name: 'Old project', deleted_at: deletedAt, team_id: null, team_name: null }];
      }
      if (text.includes('SELECT id, title, deleted_at FROM conversations')) {
        return [{ id: 'con_1', title: 'Old chat', deleted_at: deletedAt }];
      }
      if (text.includes('SELECT id, content, deleted_at FROM memories')) {
        return [{ id: 'mem_1', content: 'Remember this fact that is long enough to slice', deleted_at: deletedAt }];
      }
      if (text.includes('SELECT id, title, deleted_at FROM dna')) {
        return [{ id: 'dna_1', title: 'DNA block', deleted_at: deletedAt }];
      }
      if (text.includes('SELECT i.id, i.title, i.deleted_at, i.project_id, i.team_id FROM ideas i')) {
        return [{ id: 'ide_1', title: 'Idea one', deleted_at: deletedAt, project_id: 'prj_1', team_id: null }];
      }
      if (text.includes('SELECT DISTINCT ON (resource_id)')) return [{ resource_id: 'fil_1', actor_user_id: 'u1' }];
      return null;
    };
    const { items, total } = await listTrash('u1');
    expect(total).toBe(6);
    const types = new Set(items.map((i) => i.type));
    expect(types).toEqual(new Set(['file', 'project', 'conversation', 'memory', 'dna', 'idea']));
    const file = items.find((i) => i.type === 'file')!;
    expect(file.expiresAt.getTime()).toBeGreaterThan(deletedAt.getTime());
    expect(file.deletedBy).toBe('u1');
    expect(file.projectName).toBe('App');
    // every query carries the 30-day recovery window
    const windowCall = db.state.calls.find((c) => c.text.includes("now() - $2::interval"));
    expect(windowCall!.params[1]).toContain('30 days');
  });

  it('enforces tenant scope in the file/idea queries', async () => {
    db.state.resolve = () => [];
    await listTrash('u1');
    const files = db.state.calls.find((c) => c.text.includes('JOIN projects p ON p.id = f.project_id'));
    expect(files!.text).toContain('project_members');
    const ideas = db.state.calls.find((c) => c.text.includes('FROM ideas i'));
    expect(ideas!.text).toContain('team_members');
  });
});

describe('restoreItem / restoreBulk', () => {
  it('restores each type through the owning service and audits', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT project_id FROM files f WHERE id = $2 AND deleted_at IS NOT NULL')) {
        return [{ project_id: 'prj_1' }];
      }
      return null;
    };
    await restoreItem('u1', 'file', 'fil_1');
    expect(restoreFile).toHaveBeenCalledWith('u1', 'prj_1', 'fil_1');
    await restoreItem('u1', 'project', 'prj_9');
    expect(restoreProject).toHaveBeenCalledWith('u1', 'prj_9');
    await restoreItem('u1', 'conversation', 'con_1');
    expect(restoreConversation).toHaveBeenCalledWith('u1', 'con_1');
    await restoreItem('u1', 'memory', 'mem_1');
    expect(restoreMemory).toHaveBeenCalledWith('u1', 'mem_1');
    await restoreItem('u1', 'dna', 'dna_1');
    expect(restoreDna).toHaveBeenCalledWith('u1', 'dna_1');
    await restoreItem('u1', 'idea', 'ide_1');
    expect(restoreIdea).toHaveBeenCalledWith('u1', 'ide_1');
    const audits = db.state.calls.filter((c) => c.text.includes('INSERT INTO audit_logs') && c.params.includes('trash.restored'));
    expect(audits.length).toBe(6);
  });

  it('bulk restore reports per-item failures without aborting', async () => {
    const restoreSpy = vi.mocked(restoreFile);
    restoreSpy.mockRejectedValueOnce(AppError.conflict('path_conflict', 'A file with that path already exists'));
    db.state.resolve = (text) => {
      if (text.includes('SELECT project_id FROM files f WHERE id = $2 AND deleted_at IS NOT NULL')) {
        return [{ project_id: 'prj_1' }];
      }
      return null;
    };
    const results = await restoreBulk('u1', [
      { type: 'file', id: 'fil_1' },
      { type: 'file', id: 'fil_2' },
    ]);
    expect(results[0]).toMatchObject({ type: 'file', id: 'fil_1', ok: false, errorCode: 'path_conflict' });
    expect(results[1]).toMatchObject({ ok: true });
  });

  it('rejects unknown item types', async () => {
    await expect(restoreItem('u1', 'widget', 'w_1')).rejects.toMatchObject({ errorCode: 'invalid_type' });
  });
});

describe('purgeItem — permanent delete with reference checks', () => {
  it('purges a project only when it has no live dependents', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT deleted_at FROM projects WHERE id = $1 AND owner_id = $2')) {
        return [{ deleted_at: deletedAt }];
      }
      if (text.includes('FROM tasks WHERE project_id = $1')) return [{ n: 0 }];
      return null;
    };
    await purgeItem('u1', 'project', 'prj_9');
    const del = db.state.calls.find((c) => c.text.includes('DELETE FROM projects'));
    expect(del!.params).toEqual(['prj_9', 'u1']);
    expect(db.state.calls.some((c) => c.params.includes('trash.purged'))).toBe(true);
  });

  it('blocks permanent delete of a project with live files', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT deleted_at FROM projects WHERE id = $1 AND owner_id = $2')) {
        return [{ deleted_at: deletedAt }];
      }
      if (text.includes('FROM tasks WHERE project_id = $1')) return [{ n: 3 }];
      return null;
    };
    await expect(purgeItem('u1', 'project', 'prj_9')).rejects.toMatchObject({ errorCode: 'dependency_conflict' });
    expect(db.state.calls.some((c) => c.text.includes('DELETE FROM projects'))).toBe(false);
  });

  it('blocks permanent delete of a conversation that still has messages', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT deleted_at FROM conversations WHERE id = $1 AND owner_id = $2')) {
        return [{ deleted_at: deletedAt }];
      }
      if (text.includes('FROM messages WHERE conversation_id = $1')) return [{ n: 4 }];
      return null;
    };
    await expect(purgeItem('u1', 'conversation', 'con_1')).rejects.toMatchObject({ errorCode: 'dependency_conflict' });
  });

  it('purges an idea (votes/comments cascade by design)', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT deleted_at FROM ideas i WHERE i.id = $1') ? [{ deleted_at: deletedAt }] : null;
    await purgeItem('u1', 'idea', 'ide_1');
    expect(db.state.calls.some((c) => c.text.includes('DELETE FROM ideas WHERE id = $1'))).toBe(true);
  });

  it('refuses to permanently delete an item that is not trashed', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT deleted_at FROM memories WHERE id = $1 AND owner_id = $2') ? [{ deleted_at: null }] : null;
    await expect(purgeItem('u1', 'memory', 'mem_1')).rejects.toMatchObject({ errorCode: 'not_trashed' });
  });

  it('routes file purges through the existing permanent-delete path', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT project_id FROM files f WHERE id = $2 AND deleted_at IS NOT NULL') ? [{ project_id: 'prj_1' }] : null;
    await purgeItem('u1', 'file', 'fil_1');
    expect(permanentDeleteFile).toHaveBeenCalledWith('u1', 'prj_1', 'fil_1');
  });

  it('file tenant lookup aliases the files table as f (Stage 21 regression: raw 500)', async () => {
    db.state.resolve = () => [{ project_id: 'prj_1' }];
    await restoreItem('u1', 'file', 'fil_1');
    await purgeItem('u1', 'file', 'fil_2');
    const lookups = db.state.calls.filter((c) => c.text.includes('SELECT project_id FROM files'));
    expect(lookups.length).toBe(2);
    for (const call of lookups) {
      expect(call.text).toContain('FROM files f');
      expect(call.text).toContain('f.owner_id');
      expect(call.text).toContain('f.project_id');
      expect(call.text).not.toContain('FROM files WHERE');
      // TENANT_PARENS references $1 (owner/member); the trashed-file id must
      // be a separate placeholder so the bind count matches the query.
      expect(call.text).toContain('id = $2');
    }
    expect(lookups[0].params).toEqual(['u1', 'fil_1']);
    expect(lookups[1].params).toEqual(['u1', 'fil_2']);
  });

  it('bulk purge reports failures per item', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT deleted_at FROM dna WHERE id = $1 AND owner_id = $2')) return [];
      return null;
    };
    const results = await purgeBulk('u1', [{ type: 'dna', id: 'dna_missing' }]);
    expect(results[0].ok).toBe(false);
  });
});

describe('purgeExpired — expiry sweep', () => {
  it('reuses the file sweep and purges other expired items, skipping conflicts', async () => {
    vi.mocked(purgeExpiredTrash).mockResolvedValue(2);
    db.state.resolve = (text) => {
      if (text.includes("now() - $2::interval")) {
        if (text.includes('FROM projects WHERE owner_id = $1')) return [{ id: 'prj_expired' }];
        if (text.includes('FROM conversations WHERE owner_id = $1')) return [{ id: 'con_expired' }];
        if (text.includes('FROM memories WHERE owner_id = $1')) return [];
        if (text.includes('FROM dna WHERE owner_id = $1')) return [];
        if (text.includes('FROM ideas WHERE owner_id = $1')) return [];
        return null;
      }
      if (text.includes('SELECT deleted_at FROM projects WHERE id = $1 AND owner_id = $2')) {
        return [{ deleted_at: deletedAt }];
      }
      if (text.includes('SELECT deleted_at FROM conversations WHERE id = $1 AND owner_id = $2')) {
        return [{ deleted_at: deletedAt }];
      }
      if (text.includes('FROM tasks WHERE project_id = $1')) return [{ n: 0 }];
      if (text.includes('FROM messages WHERE conversation_id = $1')) return [{ n: 0 }];
      return null;
    };
    const { purged, skipped } = await purgeExpired('u1');
    const purgedTypes = purged.map((p) => p.type);
    expect(purgedTypes).toContain('file');
    expect(purgedTypes).toContain('project');
    expect(purgedTypes).toContain('conversation');
    expect(skipped).toHaveLength(0);
    expect(purgeExpiredTrash).toHaveBeenCalledWith('u1');
  });
});