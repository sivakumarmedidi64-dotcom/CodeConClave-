/**
 * CodeConClave — Phase 6 DNA foundation tests.
 * Covers: prompt-safe DNA retrieval, auto-save after task completion,
 * change_summary provenance on DNA edits, team DNA (role permissions,
 * MAIN/BRANCH/MERGE, conflict detection + resolution, membership scoping).
 * DB is mocked; team membership and DNA rows are fixtures.
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
import { teamRoleFor } from '../modules/teams/service.js';
import {
  autoSaveTaskDna,
  retrieveDnaForPrompt,
  updateDna,
} from '../modules/dna/service.js';
import {
  createTeamBranch,
  getTeamDna,
  listTeamDna,
  mergeTeamBranches,
  resolveTeamDnaConflict,
  saveTeamDna,
  teamDnaVersions,
} from '../modules/dna/team.js';

function dnaRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    owner_id: 'u1',
    kind: 'DECISION',
    scope: 'MAIN',
    title: 'Decision',
    content: 'Use Postgres',
    version: 1,
    parent_version_id: null,
    conflict_state: 'NONE',
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function teamDnaRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    team_id: 't1',
    created_by: 'u1',
    kind: 'DECISION',
    scope: 'MAIN',
    title: 'Decision',
    content: 'Use Postgres',
    version: 1,
    parent_version_id: null,
    conflict_state: 'NONE',
    status: 'ACTIVE',
    change_summary: null,
    merged_into_id: null,
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function memberResolver(role: string | null): (text: string, params: unknown[]) => unknown[] | null {
  return (text, params) => {
    if (text.includes('SELECT role FROM team_members')) return role ? [{ role }] : [];
    if (text.includes('FROM team_dna') && text.includes('EXISTS')) return [teamDnaRow(String(params[0]))];
    if (text.includes('FROM team_dna WHERE team_id')) return [teamDnaRow('td1')];
    if (text.includes('FROM team_dna_versions')) return [];
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

describe('teamRoleFor — role lookup', () => {
  it('returns owner / admin / member roles and null for non-members', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      return null;
    };
    expect(await teamRoleFor('u1', 't1')).toBe('owner');

    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'member' }];
      return null;
    };
    expect(await teamRoleFor('u1', 't1')).toBe('member');

    db.state.resolve = () => [];
    expect(await teamRoleFor('u1', 't1')).toBeNull();
  });
});

describe('team DNA — save + membership scoping', () => {
  it('lets a member save a MAIN block with version 1 + snapshot', async () => {
    db.state.resolve = memberResolver('member');
    const block = await saveTeamDna('u1', { teamId: 't1', kind: 'DECISION', title: 'Decision', content: 'Use Postgres' });
    expect(block.id).toBeTruthy();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO team_dna'))!;
    expect(insert.params[1]).toBe('t1');
    expect(insert.params[3]).toBe('DECISION');
    expect(insert.params[4]).toBe('MAIN');
    expect(insert.params[7]).toBe(1);
    expect(db.state.calls.find((c) => c.text.includes('INSERT INTO team_dna_versions'))).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.team_created' }));
  });

  it('refuses non-members', async () => {
    db.state.resolve = memberResolver(null);
    await expect(saveTeamDna('u1', { teamId: 't1', kind: 'DECISION', title: 'x', content: 'y' })).rejects.toThrow(AppError);
  });

  it('scopes reads to membership (getTeamDna uses an EXISTS membership clause)', async () => {
    db.state.resolve = memberResolver('member');
    await getTeamDna('u1', 'td1');
    const select = db.state.calls.find((c) => c.text.includes('FROM team_dna') && c.text.includes('EXISTS'))!;
    expect(select.text).toContain('tm.user_id = $2');
  });

  it('lists team DNA with optional scope filter', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM teams t JOIN team_members')) return [{ id: 't1' }];
      if (text.includes('FROM team_dna WHERE team_id')) return [teamDnaRow('td1')];
      return null;
    };
    const blocks = await listTeamDna('u1', 't1', 'MAIN');
    expect(blocks).toHaveLength(1);
    const select = db.state.calls.find((c) => c.text.includes('FROM team_dna WHERE team_id'))!;
    expect(select.text).toContain('scope = $2');
  });

  it('lists versions through membership-scoped read', async () => {
    db.state.resolve = memberResolver('member');
    await teamDnaVersions('u1', 'td1');
    expect(db.state.calls.find((c) => c.text.includes('FROM team_dna_versions'))).toBeDefined();
  });
});

describe('team DNA — branches + merge', () => {
  it('creates a BRANCH from a base block (member = editor)', async () => {
    db.state.resolve = memberResolver('member');
    const branch = await createTeamBranch('u1', 't1', 'td-base', 'Branch title', 'proposal');
    expect(branch.id).toBeTruthy();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO team_dna'))!;
    expect(insert.params[4]).toBe('BRANCH');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.team_branch_created' }));
  });

  it('refuses merge for plain members', async () => {
    db.state.resolve = memberResolver('member');
    await expect(mergeTeamBranches('u1', 't1', 'td-branch', 'td-base')).rejects.toThrow(AppError);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE team_dna SET'))).toBe(false);
  });

  it('merges cleanly as owner: MAIN wins, branch is MERGED with snapshot', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('FROM team_dna') && text.includes('EXISTS')) {
        const id = String(params[0]);
        if (id === 'td-branch') return [teamDnaRow(id, { scope: 'BRANCH' })];
        return [teamDnaRow(id)];
      }
      return null;
    };
    const merged = await mergeTeamBranches('u1', 't1', 'td-branch', 'td-base', 'Use Postgres 17');
    expect(merged.id).toBe('td-base');
    const update = db.state.calls.find((c) => c.text.includes('UPDATE team_dna SET'))!;
    expect(update.text).toContain("conflict_state = 'RESOLVED'");
    expect(update.text).toContain('version = version + 1');
    expect(update.text).toContain("scope = 'MAIN'");
    expect(update.text).toContain("status = 'MERGED'");
    expect(update.text).toContain("merged_into_id = $4");
    expect(update.params[2]).toBe('Use Postgres 17');
    expect(db.state.calls.find((c) => c.text.includes('INSERT INTO team_dna_versions') && c.text.includes('SELECT $1'))).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.team_merged' }));
  });

  it('preserves both versions and raises a conflict when the base moved on', async () => {
    const baseChanged = new Date('2026-01-01T00:00:06Z');
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('FROM team_dna') && text.includes('EXISTS')) {
        const id = String(params[0]);
        if (id === 'td-branch') return [teamDnaRow(id, { scope: 'BRANCH', created_at: new Date('2026-01-01T00:00:00Z') })];
        return [teamDnaRow(id, { updated_at: baseChanged })];
      }
      return null;
    };
    let raised = false;
    try {
      await mergeTeamBranches('u1', 't1', 'td-branch', 'td-base');
    } catch (err) {
      raised = true;
      expect((err as AppError).errorCode).toBe('team_dna_conflict');
    }
    expect(raised).toBe(true);
    expect(db.state.calls.find((c) => c.text.includes('INSERT INTO team_dna_conflicts') && c.text.includes("'CONFLICT'"))).toBeDefined();
    expect(db.state.calls.find((c) => c.text.includes("UPDATE team_dna SET conflict_state = 'CONFLICT'"))).toBeDefined();
  });

  it('resolves conflicts as admin with a recorded resolution', async () => {
    db.state.resolve = memberResolver('admin');
    const resolved = await resolveTeamDnaConflict('u1', 't1', 'td-branch', 'td-base', 'Use Postgres 17');
    expect(resolved.id).toBe('td-base');
    const conflictUpdate = db.state.calls.find((c) => c.text.includes('UPDATE team_dna_conflicts'))!;
    expect(conflictUpdate.params[0]).toBe('Use Postgres 17');
    expect(db.state.calls.find((c) => c.text.includes("UPDATE team_dna SET conflict_state = 'RESOLVED'"))).toBeDefined();
    const contentUpdate = db.state.calls.find((c) => c.text.includes('UPDATE team_dna SET') && c.text.includes('version = version + 1'))!;
    expect(contentUpdate.text).toContain('content = $2');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.team_conflict_resolved' }));
  });
});

describe('prompt-safe DNA retrieval', () => {
  it('selects MAIN non-conflicting blocks for the project and labels them', async () => {
    db.state.resolve = (text) => (text.includes('FROM dna') ? [dnaRow('d1')] : null);
    const out = await retrieveDnaForPrompt('u1', 'p1', 5);
    const select = db.state.calls.find((c) => c.text.includes('FROM dna'))!;
    expect(select.text).toContain("scope = 'MAIN'");
    expect(select.text).toContain("conflict_state <> 'CONFLICT'");
    expect(select.text).toContain('($2::text IS NULL OR project_id = $2)');
    expect(out).toEqual(['[DECISION v1]: Decision — Use Postgres']);
  });

  it('returns nothing when the user has no project DNA', async () => {
    db.state.resolve = () => [];
    expect(await retrieveDnaForPrompt('u1', 'p1')).toEqual([]);
  });
});

describe('autoSaveTaskDna — background DNA persistence', () => {
  it('persists a MAIN PROJECT_CONTEXT block with auto: true', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM dna')) return [dnaRow('d1')];
      return null;
    };
    await autoSaveTaskDna({
      userId: 'u1',
      projectId: 'p1',
      taskId: 'task_123',
      title: 'Fix auth',
      description: 'Rewrite the login flow',
      outcome: 'All tests pass',
    });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO dna'))!;
    expect(insert).toBeDefined();
    expect(insert.params[1]).toBe('p1');
    expect(insert.params[4]).toBe('MAIN');
    expect(String(insert.params[6])).toContain('Completed task:');
    expect(String(insert.params[6])).toContain('All tests pass');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dna.created', detail: { auto: true } }));
  });

  it('never throws — a failed DNA write must not break task completion', async () => {
    db.state.resolve = () => [];
    await expect(
      autoSaveTaskDna({ userId: 'u1', projectId: 'p1', taskId: 'task_1', title: 't', description: 'd', outcome: 'o' }),
    ).resolves.toBeUndefined();
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO dna'))).toBe(false);
  });
});

describe('change_summary provenance on DNA edits', () => {
  it('writes change_summary to the block and the version snapshot', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM dna')) return [dnaRow('d1', { version: 3 })];
      return null;
    };
    await updateDna('u1', 'd1', { content: 'Use Postgres 17', changeSummary: 'Upgraded for the new release' });
    const update = db.state.calls.find((c) => c.text.includes('UPDATE dna SET'))!;
    expect(update.text).toContain('version = version + 1');
    expect(update.text).toContain('change_summary = $3');
    expect(update.params[1]).toBe('Use Postgres 17');
    expect(update.params[2]).toBe('Upgraded for the new release');
    const snapshot = db.state.calls.find((c) => c.text.includes('INSERT INTO dna_versions'))!;
    expect(snapshot.params[2]).toBe(4);
    const versionSummary = db.state.calls.find((c) => c.text.includes('UPDATE dna_versions SET change_summary'))!;
    expect(versionSummary.params[1]).toBe('Upgraded for the new release');
    expect(versionSummary.params[2]).toBe(4);
  });

  it('allows a summary-only edit without a version bump', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM dna')) return [dnaRow('d1')];
      return null;
    };
    await updateDna('u1', 'd1', { changeSummary: 'Noting the rationale' });
    const update = db.state.calls.find((c) => c.text.includes('UPDATE dna SET'))!;
    expect(update.text).not.toContain('version = version + 1');
    expect(update.text).toContain('change_summary = $2');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO dna_versions'))).toBe(false);
  });
});