/**
 * CodeConClave — projects foundation tests (PHASE 3).
 * Covers: create (limits, deadline/tags), update (status lifecycle, favorite),
 * archive/complete/on-hold, restore, soft delete, permissions (OWNER/EDITOR/
 * VIEWER), tenant isolation, project activity. DB interaction is mocked;
 * role resolution is exercised through the real requireProjectRole path.
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
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { AppError } from '../shared/errors.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  archiveProject,
  completeProject,
  onHoldProject,
  toggleFavoriteProject,
  restoreProject,
  softDeleteProject,
  listProjectActivity,
  userHasAccess,
} from '../modules/projects/service.js';

function projectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    owner_id: 'u1',
    team_id: null,
    name: 'Project One',
    description: null,
    repo_url: null,
    workspace_root: null,
    status: 'ACTIVE',
    deadline: null,
    is_favorite: false,
    tags: [],
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

/** Resolve project rows + role lookups so service queries behave like a DB. */
function setupProject(role: string | null, isOwner = false, overrides: Record<string, unknown> = {}) {
  db.state.resolve = (text, params) => {
    if (text.includes('EXISTS (SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2)')) {
      return [{ is_owner: isOwner, member_role: role }];
    }
    if (text.includes('SELECT * FROM projects') || text.includes('FROM projects')) {
      if (text.includes('count(')) return [{ n: 0 }];
      return [projectRow(overrides)];
    }
    if (text.includes('SELECT 1 FROM project_members')) return isOwner ? [] : role ? [{ id: 'pm1' }] : [];
    if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'pro' }];
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProject', () => {
  it('creates with deadline and tags, audits and records activity', async () => {
    setupProject(null, true);
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'pro' }];
      if (text.includes('count(*)::int AS n FROM projects')) return [{ n: 0 }];
      if (text.includes('SELECT * FROM projects')) return [projectRow({ deadline: '2026-12-31T00:00:00.000Z', tags: ['launch', 'v2'] })];
      return null;
    };
    const project = await createProject('u1', { name: 'P', deadline: '2026-12-31T00:00:00.000Z', tags: ['launch', 'v2'] });
    expect(project.tags).toEqual(['launch', 'v2']);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO projects'))!;
    expect(insert.params[6]).toEqual(['launch', 'v2']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.created' }));
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO project_activity'))).toBe(true);
  });

  it('blocks free users at the project limit', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('count(*)::int AS n FROM projects')) return [{ n: 1 }];
      return null;
    };
    await expect(createProject('u1', { name: 'P' })).rejects.toMatchObject({ errorCode: 'project_limit_reached', status: 400 });
  });
});

describe('updateProject — lifecycle + metadata', () => {
  it('owner/editor may change status, deadline, favorite and tags', async () => {
    setupProject('owner', true, { status: 'ON_HOLD', deadline: '2026-06-01T00:00:00.000Z', is_favorite: true, tags: ['frontend'] });
    const updated = await updateProject('u1', 'p1', {
      status: 'ON_HOLD',
      deadline: '2026-06-01T00:00:00.000Z',
      favorite: true,
      tags: ['frontend'],
    });
    expect(updated.status).toBe('ON_HOLD');
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE projects SET'))!;
    expect(upd.text).toContain('status = $');
    expect(upd.text).toContain('is_favorite = $');
    expect(upd.text).toContain('deadline = $');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.status_changed' }));
    expect(db.state.calls.some((c) => c.text.includes('project_activity'))).toBe(true);
  });

  it('editor role is treated as a writer', async () => {
    setupProject('editor');
    await expect(updateProject('u_editor', 'p1', { name: 'X' })).resolves.toBeDefined();
  });

  it('member and viewer are denied writes (read-only)', async () => {
    setupProject('member');
    await expect(updateProject('u_member', 'p1', { name: 'X' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
      status: 403,
    });
    setupProject('viewer');
    await expect(updateProject('u_viewer', 'p1', { name: 'X' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('rejects an invalid status', async () => {
    setupProject('owner', true);
    await expect(updateProject('u1', 'p1', { status: 'WIP' as never })).rejects.toMatchObject({
      errorCode: 'invalid_status',
    });
  });

  it('completeProject and onHoldProject drive the status lifecycle', async () => {
    setupProject('owner', true);
    await completeProject('u1', 'p1');
    const call = db.state.calls.find((c) => c.text.includes('UPDATE projects SET') && c.params.includes('COMPLETED'))!;
    expect(call).toBeDefined();
    setupProject('owner', true);
    await onHoldProject('u1', 'p1');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE projects SET') && c.params.includes('ON_HOLD'))).toBe(true);
  });

  it('toggleFavoriteProject flips is_favorite and records activity', async () => {
    setupProject('owner', true);
    db.state.resolve = (text) => {
      if (text.includes('EXISTS')) return [{ is_owner: true, member_role: 'owner' }];
      if (text.includes('UPDATE projects SET is_favorite = NOT is_favorite')) return [{ is_favorite: true }];
      if (text.includes('SELECT * FROM projects')) return [projectRow({ is_favorite: true })];
      return null;
    };
    const project = await toggleFavoriteProject('u1', 'p1');
    expect(project.is_favorite).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('project_activity'))).toBe(true);
  });
});

describe('archive / restore / soft delete', () => {
  it('archives (owner/admin/editor) and unarchives via status', async () => {
    setupProject('admin');
    await archiveProject('u_admin', 'p1', true);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE projects SET status = $1') && c.params[0] === 'ARCHIVED')).toBe(true);
  });

  it('viewer cannot archive', async () => {
    setupProject('viewer');
    await expect(archiveProject('u_viewer', 'p1', true)).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });

  it('only the owner may soft delete; admin is denied', async () => {
    setupProject('owner', true);
    await softDeleteProject('u1', 'p1');
    const del = db.state.calls.find((c) => c.text.includes('deleted_at = now()'))!;
    expect(del).toBeDefined();
    setupProject('admin');
    await expect(softDeleteProject('u_admin', 'p1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });

  it('restore clears deleted_at and is owner-scoped', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE projects SET deleted_at = NULL')) return [projectRow({ deleted_at: null })];
      if (text.includes('SELECT * FROM projects')) return [projectRow()];
      return null;
    };
    const project = await restoreProject('u1', 'p1');
    expect(project.deleted_at).toBeNull();
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE projects SET deleted_at = NULL'))!;
    expect(upd.params).toEqual(['p1', 'u1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.restored' }));
  });
});

describe('tenant isolation + read authorization', () => {
  it('strangers cannot read a project they neither own nor belong to', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM projects')) return [projectRow()];
      if (text.includes('SELECT 1 FROM project_members')) return [];
      return null;
    };
    await expect(getProject('u_stranger', 'p1')).rejects.toMatchObject({ errorCode: 'forbidden', status: 403 });
  });

  it('members can read; userHasAccess reflects it', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM projects')) return [projectRow()];
      if (text.includes('SELECT 1 FROM project_members')) return [{ id: 'pm1' }];
      return null;
    };
    await expect(getProject('u_member', 'p1')).resolves.toMatchObject({ id: 'p1' });
    expect(await userHasAccess('u_member', 'p1')).toBe(true);
    db.state.resolve = null;
    expect(await userHasAccess('u_stranger', 'p1')).toBe(false);
  });

  it('listProjects is scoped to ownership or membership and honors filters', async () => {
    setupProject(null, true);
    await listProjects('u1', false, { favorite: true, status: 'ACTIVE', tag: 'x' });
    const call = db.state.calls.find((c) => c.text.includes('LEFT JOIN project_members'))!;
    expect(call.text).toContain('p.owner_id = $1 OR pm.user_id IS NOT NULL');
    expect(call.text).toContain('p.is_favorite = $');
    expect(call.text).toContain('p.status = $');
    expect(call.text).toContain('ANY(p.tags)');
  });
});

describe('project activity feed', () => {
  it('lists activity only for users with project access', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM projects')) return [projectRow()];
      if (text.includes('SELECT 1 FROM project_members')) return [{ id: 'pm1' }];
      if (text.includes('FROM project_activity')) return [{ id: 'a1', action: 'project.updated' }];
      return null;
    };
    const activity = await listProjectActivity('u_member', 'p1');
    expect(activity[0]).toMatchObject({ action: 'project.updated' });
    const call = db.state.calls.find((c) => c.text.includes('FROM project_activity'))!;
    expect(call.text).toContain('pa.project_id = $1');
    db.state.resolve = null;
    await expect(listProjectActivity('u_stranger', 'p1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('AppError is exported for callers', () => {
    expect(AppError).toBeDefined();
  });
});