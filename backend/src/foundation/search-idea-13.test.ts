/**
 * CodeConClave — Phase 13 global search tests: the 'idea' entity joins the
 * Phase 8 search with tenant/team/project permission filtering. DB mocked.
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

import { globalSearch } from '../modules/search/service.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('search — idea entity', () => {
  it('searches ideas with owner/project-member/team-member scope', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM ideas i')) {
        return [{ id: 'ide_1', title: 'Dark mode everywhere', status: 'PROPOSED', priority: 'HIGH', created_at: new Date(), project_id: null }];
      }
      return null;
    };
    const result = await globalSearch('u1', { q: 'dark' });
    const idea = result.results.find((r) => r.entity === 'idea');
    expect(idea).toBeTruthy();
    expect(idea!.label).toBe('Dark mode everywhere');
    expect(idea!.status).toBe('PROPOSED');
    const call = db.state.calls.find((c) => c.text.includes('FROM ideas i'));
    expect(call!.text).toContain('i.owner_id = $1');
    expect(call!.text).toContain('project_members');
    expect(call!.text).toContain("team_members WHERE user_id = $1 AND status = 'ACTIVE'");
    expect(call!.text).toContain('i.deleted_at IS NULL');
    // search audit recorded
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO audit_logs') && c.params.includes('search.performed'))).toBe(true);
  });

  it('filters by project and tag for ideas', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM ideas i')) return [];
      return null;
    };
    await globalSearch('u1', { q: 'x', type: 'idea', projectId: 'prj_1', tag: 'ux' });
    const call = db.state.calls.find((c) => c.text.includes('FROM ideas i'));
    expect(call!.text).toContain('i.project_id = $');
    expect(call!.text).toContain('= ANY(i.tags)');
  });

  it('filters ideas by team scope when the caller is a member', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'")) {
        return [{ role: 'admin' }];
      }
      if (text.includes('FROM ideas i')) return [];
      return null;
    };
    await globalSearch('u1', { q: 'x', type: 'idea', teamId: 'tm_1' });
    const call = db.state.calls.find((c) => c.text.includes('FROM ideas i'));
    expect(call!.text).toContain('i.team_id = $');
  });

  it('hides team-scoped idea results from non-members (no authorization leak)', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'")) {
        return [];
      }
      if (text.includes('FROM ideas i')) return [{ id: 'ide_1', title: 'Secret idea', status: 'PROPOSED', priority: 'LOW', created_at: new Date(), project_id: null }];
      return null;
    };
    const result = await globalSearch('u9', { q: 'secret', teamId: 'tm_1' });
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns ideas for an ACTIVE team member', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'")) {
        return [{ role: 'editor' }];
      }
      if (text.includes('FROM ideas i')) return [{ id: 'ide_2', title: 'Team idea', status: 'ACCEPTED', priority: 'MEDIUM', created_at: new Date(), project_id: null }];
      return null;
    };
    const result = await globalSearch('u2', { q: 'team', teamId: 'tm_1' });
    expect(result.results.some((r) => r.entity === 'idea' && r.label === 'Team idea')).toBe(true);
  });
});