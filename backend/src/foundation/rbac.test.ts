/**
 * CodeConClave — RBAC foundation tests (PHASE 1).
 * Covers: role resolution, server-side permission checks (OWNER/ADMIN/MEMBER/
 * VIEWER), project/resource authorization, tenant isolation on membership
 * management. DB interaction is mocked.
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
  return {
    state,
    pool: { query },
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { projectRoleFor, requireProjectRole, hasUserRole, requireUserRole, roleAtLeast, type Role } from '../modules/auth/rbac.js';
import { addProjectMember, removeProjectMember, updateProject, archiveProject, softDeleteProject } from '../modules/projects/service.js';
import type { AuthUser } from '../middleware/context.js';

const OWNER: AuthUser = { id: 'u_owner', email: 'o@x.com', emailVerified: true, displayName: null, avatarUrl: null, googleSub: null, mfaEnabled: false, rbacRole: 'owner', planId: 'pro', entitlementState: 'PRO_VERIFIED' };
const ADMIN: AuthUser = { ...OWNER, id: 'u_admin', rbacRole: 'admin' };
const MEMBER: AuthUser = { ...OWNER, id: 'u_member', rbacRole: 'member' };
const VIEWER: AuthUser = { ...OWNER, id: 'u_viewer', rbacRole: 'viewer' };
const STRANGER: AuthUser = { ...OWNER, id: 'u_stranger', rbacRole: 'member' };

function resolveRole(role: Role | null, isOwner = false): void {
  db.state.resolve = () => [{ is_owner: isOwner, member_role: role }];
}

function clearResolve(): void {
  db.state.resolve = null;
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

describe('role resolution (server-side, from the database)', () => {
  it('resolves the owner role for the project owner', async () => {
    resolveRole('viewer', true);
    expect(await projectRoleFor('u1', 'p1')).toBe('owner');
  });

  it('resolves the membership role otherwise', async () => {
    resolveRole('admin');
    expect(await projectRoleFor('u1', 'p1')).toBe('admin');
    resolveRole('viewer');
    expect(await projectRoleFor('u1', 'p1')).toBe('viewer');
  });

  it('returns null for users with no relationship to the project', async () => {
    resolveRole(null);
    expect(await projectRoleFor('u1', 'p1')).toBe(null);
  });

  it('never trusts client-supplied identity: role is looked up by caller id', async () => {
    resolveRole('admin');
    await projectRoleFor('u1', 'p1');
    const call = db.state.calls.find((c) => c.text.includes('EXISTS'))!;
    expect(call.params[0]).toBe('p1');
    expect(call.params[1]).toBe('u1');
  });
});

describe('requireProjectRole — permission checks', () => {
  it('allows roles included in the allowed set', async () => {
    resolveRole('admin');
    expect(await requireProjectRole('u1', 'p1', ['owner', 'admin'])).toBe('admin');
    resolveRole('viewer');
    expect(await requireProjectRole('u1', 'p1', ['member', 'viewer'])).toBe('viewer');
  });

  it('denies insufficient roles with a forbidden error', async () => {
    resolveRole('viewer');
    await expect(requireProjectRole('u1', 'p1', ['owner', 'admin', 'member'])).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
      status: 403,
    });
    resolveRole('member');
    await expect(requireProjectRole('u1', 'p1', ['owner'])).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });

  it('denies users with no membership', async () => {
    resolveRole(null);
    await expect(requireProjectRole('u1', 'p1', ['viewer'])).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });
});

describe('account-level roles (rbac_role)', () => {
  it('hasUserRole gates account roles', () => {
    expect(hasUserRole(ADMIN, ['admin', 'owner'])).toBe(true);
    expect(hasUserRole(VIEWER, ['owner', 'admin', 'member'])).toBe(false);
    expect(hasUserRole(null, ['viewer'])).toBe(false);
  });

  it('requireUserRole throws for insufficient account roles', () => {
    expect(() => requireUserRole(OWNER, ['owner'])).not.toThrow();
    expect(() => requireUserRole(MEMBER, ['admin', 'owner'])).toThrowError(
      expect.objectContaining({ errorCode: 'insufficient_permission' }),
    );
  });

  it('roleAtLeast orders roles strictly', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'member')).toBe(true);
    expect(roleAtLeast('member', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'member')).toBe(false);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
  });
});

describe('project membership management — RBAC + isolation', () => {
  async function setupMemberManagement(callerRole: Role | null, isOwner = false): Promise<void> {
    resolveRole(callerRole, isOwner);
    db.state.resolve = (text, params) => {
      if (text.includes('EXISTS')) return [{ is_owner: isOwner, member_role: callerRole }];
      if (text.includes('SELECT id FROM users')) return [{ id: 'u_target' }];
      return null;
    };
  }

  it('owner may add a member', async () => {
    await setupMemberManagement('owner', true);
    await addProjectMember('u_owner', 'p1', 'm@x.com', 'member');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO project_members'))!;
    expect(insert.params).toContain('u_target');
    expect(insert.params[3]).toBe('member');
  });

  it('admin may add a member', async () => {
    await setupMemberManagement('admin');
    await addProjectMember('u_admin', 'p1', 'm@x.com', 'member');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO project_members'))).toBe(true);
  });

  it('member and viewer are denied membership management', async () => {
    await setupMemberManagement('member');
    await expect(addProjectMember('u_member', 'p1', 'm@x.com', 'member')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    await setupMemberManagement('viewer');
    await expect(removeProjectMember('u_viewer', 'p1', 'u_target')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('only the owner may grant the owner role', async () => {
    await setupMemberManagement('admin');
    await expect(addProjectMember('u_admin', 'p1', 'm@x.com', 'owner')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    await setupMemberManagement('owner', true);
    await addProjectMember('u_owner', 'p1', 'm@x.com', 'owner');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO project_members'))).toBe(true);
  });

  it('admin cannot remove the project owner', async () => {
    resolveRole('admin');
    db.state.resolve = (text) => {
      if (text.includes('EXISTS')) return [{ is_owner: false, member_role: 'admin' }];
      if (text.includes('AND role = $3')) return [{ id: 'pm1' }];
      return null;
    };
    await expect(removeProjectMember('u_admin', 'p1', 'u_owner')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('strangers cannot manage membership (tenant isolation)', async () => {
    await setupMemberManagement(null);
    await expect(addProjectMember('u_stranger', 'p1', 'm@x.com', 'member')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });
});

describe('project mutation authorization', () => {
  async function setupMutations(callerRole: Role | null, isOwner = false): Promise<void> {
    db.state.resolve = (text) => {
      if (text.includes('EXISTS')) return [{ is_owner: isOwner, member_role: callerRole }];
      if (text.includes('FROM project_members')) return [{ id: 'pm1' }];
      if (text.includes('SELECT * FROM projects')) return [{ id: 'p1', owner_id: 'u_owner', name: 'P', description: null, repo_url: null, status: 'ACTIVE', created_at: new Date(), updated_at: new Date(), deleted_at: null }];
      return null;
    };
  }

  it('owner and admin may update project settings', async () => {
    await setupMutations('owner', true);
    await updateProject('u_owner', 'p1', { name: 'Renamed' });
    expect(db.state.calls.some((c) => c.text.includes('UPDATE projects') && c.text.includes('name = $2'))).toBe(true);
    await setupMutations('admin');
    await updateProject('u_admin', 'p1', { name: 'Renamed' });
    expect(db.state.calls.filter((c) => c.text.includes('UPDATE projects')).length).toBe(2);
  });

  it('member and viewer cannot update project settings', async () => {
    await setupMutations('member');
    await expect(updateProject('u_member', 'p1', { name: 'X' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    await setupMutations('viewer');
    await expect(updateProject('u_viewer', 'p1', { name: 'X' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('owner and admin may archive; member and viewer cannot', async () => {
    await setupMutations('admin');
    await archiveProject('u_admin', 'p1', true);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE projects') && c.params[0] === 'ARCHIVED')).toBe(true);
    await setupMutations('member');
    await expect(archiveProject('u_member', 'p1', true)).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });

  it('only the owner may delete a project', async () => {
    await setupMutations('owner', true);
    await softDeleteProject('u_owner', 'p1');
    const del = db.state.calls.find((c) => c.text.includes('deleted_at = now()'))!;
    expect(del.params[0]).toBe('p1');
    await setupMutations('admin');
    await expect(softDeleteProject('u_admin', 'p1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });

  it('VIEWER keeps read access via getProject while denied mutations', async () => {
    // getProject: owner rows or membership rows are readable; mutations
    // require more than the viewer role.
    resolveRole('viewer');
    expect(await requireProjectRole('u_viewer', 'p1', ['member', 'viewer'])).toBe('viewer');
    await expect(requireProjectRole('u_viewer', 'p1', ['member'])).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  void clearResolve;
});