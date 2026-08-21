/**
 * CodeConClave — global search Phase 8 tests.
 * PostgreSQL is the source of truth: entity queries are tenant-scoped
 * (owner or project member), keyword ILIKE with filters (type, project,
 * date range, owner, tag), limit capping, and SEARCH_PERFORMED auditing.
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

import { globalSearch } from '../modules/search/service.js';

function callsMatching(fragment: string) {
  return db.state.calls.filter((c) => c.text.includes(fragment));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
});

describe('globalSearch — file entity', () => {
  it('is tenant-scoped and keyword-matches path/category/mime', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM files f') ? [{ id: 'fil_1', path: 'docs/plan.md', category: null, created_at: new Date(), project_id: 'p1' }] : null;
    const { results, total } = await globalSearch('u1', { q: 'plan' });
    expect(total).toBe(1);
    expect(results[0]!.entity).toBe('file');
    expect(results[0]!.label).toBe('docs/plan.md');

    const sql = callsMatching('FROM files f')[0];
    expect(sql.text).toContain('(p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))');
    expect(sql.text).toContain('f.deleted_at IS NULL');
    expect(sql.text).toContain('f.path ILIKE $2');
    expect(sql.params[1]).toBe('%plan%');
    expect(sql.text).toContain('LIMIT 20');
  });

  it('applies projectId, date and tag filters with ordered params', async () => {
    db.state.resolve = (text) => (text.includes('FROM files f') ? [] : null);
    await globalSearch('u1', { q: 'plan', projectId: 'p9', dateFrom: '2026-01-01', dateTo: '2026-12-31', tag: 'docs' });
    const sql = callsMatching('FROM files f')[0];
    const p = sql.params;
    expect(p[0]).toBe('u1');
    expect(p[1]).toBe('%plan%');
    expect(p[2]).toBe('p9');
    expect(sql.text).toContain('f.project_id = $3');
    expect(p[3]).toBe('2026-01-01');
    expect(sql.text).toContain('f.created_at >= $4');
    expect(p[4]).toBe('2026-12-31');
    expect(sql.text).toContain('f.created_at <= $5');
    expect(p[5]).toBe('docs');
    expect(sql.text).toContain('$6 = ANY(f.tags)');
  });

  it('caps the limit at 50', async () => {
    db.state.resolve = (text) => (text.includes('FROM files f') ? [] : null);
    await globalSearch('u1', { q: 'x', limit: 1000 });
    expect(callsMatching('FROM files f')[0].text).toContain('LIMIT 50');
  });

  it('returns empty when there is no query, tag or project filter', async () => {
    const before = db.state.calls.length;
    const { results, total } = await globalSearch('u1', { q: '' });
    expect(total).toBe(0);
    expect(results).toEqual([]);
    expect(db.state.calls.length).toBe(before);
  });

  it('rejects an invalid entity type', async () => {
    await expect(globalSearch('u1', { q: 'x', type: 'garbage' as never })).rejects.toMatchObject({
      errorCode: 'invalid_type',
    });
  });

  it('rejects ownerId filter outside project search', async () => {
    await expect(globalSearch('u1', { q: 'x', ownerId: 'u9' })).rejects.toMatchObject({
      errorCode: 'owner_scope',
    });
  });
});

describe('globalSearch — other entities', () => {
  it('searches projects with ownerId support', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM projects p')
        ? [{ id: 'prj_1', name: 'Alpha', description: 'beta', created_at: new Date(), owner_id: 'u1' }]
        : null;
    const { results } = await globalSearch('u1', { q: 'alpha', type: 'project', ownerId: 'u1' });
    expect(results[0]!.entity).toBe('project');
    const sql = callsMatching('FROM projects p')[0];
    expect(sql.text).toContain('p.name ILIKE $2');
    expect(sql.text).toContain('p.owner_id = $3');
    expect(sql.params[2]).toBe('u1');
  });

  it('searches conversations owner-scoped', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM conversations c')
        ? [{ id: 'con_1', title: 'Planning', mode: 'agent', created_at: new Date(), project_id: 'p1' }]
        : null;
    const { results } = await globalSearch('u1', { q: 'planning', type: 'conversation' });
    expect(results[0]!.entity).toBe('conversation');
    const sql = callsMatching('FROM conversations c')[0];
    expect(sql.text).toContain('c.owner_id = $1');
    expect(sql.text).toContain('c.title ILIKE $2');
  });

  it('searches memories with content keyword', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM memories m')
        ? [{ id: 'mem_1', content: 'remember this', type: 'note', created_at: new Date(), project_id: null }]
        : null;
    const { results } = await globalSearch('u1', { q: 'remember', type: 'memory' });
    expect(results[0]!.entity).toBe('memory');
    expect(results[0]!.label).toContain('remember');
    const sql = callsMatching('FROM memories m')[0];
    expect(sql.text).toContain('m.content ILIKE $2');
  });

  it('searches tasks tenant-scoped via the project join', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM tasks t')
        ? [{ id: 'tsk_1', title: 'Deploy', status: 'CREATED', created_at: new Date(), project_id: 'p1' }]
        : null;
    const { results } = await globalSearch('u1', { q: 'deploy', type: 'task' });
    expect(results[0]!.entity).toBe('task');
    const sql = callsMatching('FROM tasks t')[0];
    expect(sql.text).toContain('t.title ILIKE $2');
    expect(sql.text).toContain('project_members');
  });

  it('searches artifacts via task→project scope', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM artifacts a')
        ? [{ id: 'art_1', name: 'report.pdf', kind: 'test_report', created_at: new Date(), task_id: 'tsk_1', project_id: 'p1' }]
        : null;
    const { results } = await globalSearch('u1', { q: 'report', type: 'artifact' });
    expect(results[0]!.entity).toBe('artifact');
    const sql = callsMatching('FROM artifacts a')[0];
    expect(sql.text).toContain('a.name ILIKE $2');
    expect(sql.text).toContain('JOIN projects p');
  });
});

describe('globalSearch — audit', () => {
  it('records SEARCH_PERFORMED with entity, query and filters', async () => {
    db.state.resolve = (text) => (text.includes('FROM files f') ? [] : null);
    await globalSearch('u1', { q: 'notes', type: 'file', projectId: 'p1', tag: 'docs' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'search.performed',
        actorUserId: 'u1',
        scope: 'USER',
        tenantId: 'u1',
        resourceType: 'search',
      }),
    );
    const audit = recordAudit.mock.calls[0]![0];
    expect(audit.detail.entity).toBe('file');
    expect(audit.detail.q).toBe('notes');
    expect(audit.detail.filters).toEqual({ projectId: 'p1', tag: 'docs' });
  });
});