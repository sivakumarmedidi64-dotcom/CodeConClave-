/**
 * CodeConClave — Phase 9 teams foundation tests.
 * Covers: team lifecycle + role gates, invitations (lifecycle + expiry),
 * member management (role change / remove / suspend / revoke), shared
 * projects/conversations with inheritance + access, team memory (membership
 * gated), team DNA role restriction, notifications fan-out, audit, team
 * scoped search, team task notifications, and the watchdog invitation sweep.
 * DB is mocked; PostgreSQL is the source of truth (SQL fragments asserted).
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
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { AppError } from '../shared/errors.js';
import {
  acceptInvitation,
  archiveTeam,
  attachProjectToTeam,
  cancelInvitation,
  changeMemberRole,
  createTeam,
  detachProjectFromTeam,
  expireInvitations,
  getTeam,
  inviteMember,
  listInvitations,
  listTeamActivity,
  listTeamConversations,
  listTeamProjects,
  listTeams,
  rejectInvitation,
  removeTeamMember,
  renameTeam,
  requireTeamRole,
  restoreTeam,
  revokeMembership,
  shareConversationWithTeam,
  suspendMember,
  teamMembers,
  teamRoleFor,
  teamStats,
  unshareConversationFromTeam,
  updateTeamDescription,
  updateTeamSettings,
} from '../modules/teams/service.js';
import { getProject } from '../modules/projects/service.js';
import {
  getConversation,
  listConversations,
  softDeleteConversation,
  updateConversation,
} from '../modules/conversations/service.js';
import { listTeamMemories, retrieveTeamMemoriesForPrompt } from '../modules/memory/service.js';
import { globalSearch } from '../modules/search/service.js';
import { createTask, setTaskStatus } from '../modules/execution/tasks.js';
import { mergeTeamBranches } from '../modules/dna/team.js';
import { sweepOnce } from '../workers/watchdog.js';

function teamRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    owner_id: 'u1',
    name: 'Alpha',
    description: null,
    archived_at: null,
    settings: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function memberRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    team_id: 't1',
    user_id: 'u2',
    role: 'editor',
    status: 'ACTIVE',
    invited_by: 'u1',
    joined_at: new Date('2026-01-02T00:00:00Z'),
    created_at: new Date('2026-01-02T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function invitationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv1',
    team_id: 't1',
    invited_by: 'u1',
    invitee_user_id: 'u2',
    invitee_email: 'b@example.com',
    role: 'editor',
    state: 'PENDING',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    accepted_at: null,
    rejected_at: null,
    cancelled_at: null,
    created_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function projectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    owner_id: 'u_owner',
    team_id: 't1',
    name: 'Team project',
    description: null,
    repo_url: null,
    status: 'ACTIVE',
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function convRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    project_id: 'p1',
    team_id: 't1',
    owner_id: 'u1',
    title: 'Shared planning',
    mode: 'CHAT',
    archived: false,
    is_favorite: false,
    tags: [],
    sharing: {},
    search_metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task1',
    project_id: 'p1',
    conversation_id: null,
    owner_id: 'u1',
    title: 'Deploy release',
    description: null,
    plan: null,
    status: 'RUNNING',
    risk_level: 'MEDIUM',
    required_approval: false,
    approval_id: null,
    coworker_pipeline: null,
    execution_mode: 'CLOUD',
    timeout_ms: 900000,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error_code: null,
    error_detail: null,
    attempt_count: 0,
    max_attempts: 3,
    last_heartbeat_at: null,
    watchdog_checked_at: null,
    priority: 0,
    failure_reason: null,
    recovery_status: 'NONE',
    retry_count: 0,
    next_attempt_at: null,
    dead_letter_at: null,
    requires_review_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function roleResolver(role: string | null) {
  return (text: string) => (text.includes('SELECT role FROM team_members') ? (role ? [{ role }] : []) : null);
}

function callsMatching(fragment: string) {
  return db.state.calls.filter((c) => c.text.includes(fragment));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
});

describe('team lifecycle', () => {
  it('creates a team with an owner membership and audits + activity', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM teams WHERE id = $1') ? [teamRow()] : null);
    const team = await createTeam('u1', 'Alpha', 'First team');
    expect(team.id).toBe('t1');
    const owner = db.state.calls.find((c) => c.text.includes('INSERT INTO team_members'))!;
    expect(owner.params[0]).toMatch(/^tm_/);
    expect(owner.params[1]).toMatch(/^tm_/);
    expect(owner.params[2]).toBe('u1');
    expect(owner.params[3]).toBe('u1');
    expect(owner.text).toContain("'owner','ACTIVE'");
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.created', resourceId: expect.any(String) }));
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO team_activity'))).toBe(true);
  });

  it('lists teams the user is an active member of', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT t.* FROM teams t JOIN team_members') ? [teamRow(), teamRow({ id: 't2' })] : null;
    const teams = await listTeams('u1');
    expect(teams).toHaveLength(2);
    const sql = callsMatching('SELECT t.* FROM teams t JOIN team_members')[0];
    expect(sql.text).toContain("tm.status = 'ACTIVE'");
  });

  it('getTeam hides teams the user does not belong to', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT t.* FROM teams t JOIN team_members') ? [] : null;
    await expect(getTeam('u_stranger', 't1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('renames a team (manage role) with audit + activity', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      return null;
    };
    const team = await renameTeam('u1', 't1', 'Beta');
    expect(team.name).toBe('Beta');
    expect(callsMatching('UPDATE teams SET name')[0].params).toEqual(['Beta', 't1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.renamed' }));
  });

  it('editor cannot rename (manage gate)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      return null;
    };
    await expect(renameTeam('u2', 't1', 'Beta')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });
  });

  it('updates settings as jsonb, merging with existing', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow({ settings: { a: 1 } })];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'admin' }];
      return null;
    };
    const team = await updateTeamSettings('u2', 't1', { inviteExpiryDays: 14 });
    expect(team.settings).toEqual({ a: 1, inviteExpiryDays: 14 });
    const sql = callsMatching('UPDATE teams SET settings')[0];
    expect(sql.text).toContain('$1::jsonb');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.settings_updated' }));
  });

  it('archive/restore are owner-only', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'admin' }];
      return null;
    };
    await expect(archiveTeam('u2', 't1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });

    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      return null;
    };
    await expect(archiveTeam('u1', 't1')).resolves.toMatchObject({ id: 't1' });
    expect(callsMatching('UPDATE teams SET archived_at = now()')).toHaveLength(1);
    await expect(restoreTeam('u1', 't1')).resolves.toMatchObject({ archived_at: null });
  });
});

describe('roles + isolation', () => {
  it('teamRoleFor returns the raw ACTIVE role and null for non-members', async () => {
    db.state.resolve = (text) => (text.includes('SELECT role FROM team_members') ? [{ role: 'owner' }] : null);
    expect(await teamRoleFor('u1', 't1')).toBe('owner');
    db.state.resolve = (text) => (text.includes('SELECT role FROM team_members') ? [{ role: 'member' }] : null);
    expect(await teamRoleFor('u1', 't1')).toBe('member');
    db.state.resolve = () => [];
    expect(await teamRoleFor('u1', 't1')).toBeNull();
  });

  it('requireTeamRole enforces manage/owner lists server-side', async () => {
    db.state.resolve = roleResolver('editor');
    await expect(requireTeamRole('u2', 't1', ['owner', 'admin'])).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    db.state.resolve = roleResolver('admin');
    await expect(requireTeamRole('u2', 't1', ['owner', 'admin'])).resolves.toBe('admin');
  });

  it('listTeamMembers requires membership', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('FROM team_members tm JOIN users u')) return [memberRow()];
      return null;
    };
    const members = await teamMembers('u2', 't1');
    expect(members[0]).toMatchObject({ user_id: 'u2', role: 'editor' });
    expect(callsMatching('FROM team_members tm JOIN users u')[0].text).toContain('tm.team_id = $1');
  });
});

describe('invitations', () => {
  it('invites an existing user by email with role, TTL, audit + notify', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [{ id: 'u2' }];
      if (text.includes('SELECT status FROM team_members')) return [];
      if (text.includes('SELECT id FROM team_invitations')) return [];
      if (text.includes('SELECT * FROM team_invitations WHERE id = $1')) return [invitationRow()];
      return null;
    };
    const invitation = await inviteMember('u1', 't1', 'b@example.com', 'editor');
    expect(invitation.role).toBe('editor');
    const insert = callsMatching('INSERT INTO team_invitations')[0];
    expect(insert.params[3]).toBe('u2');
    expect(insert.params[4]).toBe('b@example.com');
    expect(insert.params[5]).toBe('editor');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'team.member_invited',
        detail: { invitee: 'u2', role: 'editor', invitation: expect.any(String) },
      }),
    );
    expect(notify).toHaveBeenCalledWith('u2', 'team.invitation', expect.stringContaining('Alpha'), expect.anything());
  });

  it('rejects duplicate active membership and pending invitations', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [{ id: 'u2' }];
      if (text.includes('SELECT status FROM team_members')) return [{ status: 'ACTIVE' }];
      if (text.includes('SELECT id FROM team_invitations')) return [];
      return null;
    };
    await expect(inviteMember('u1', 't1', 'b@example.com', 'editor')).rejects.toMatchObject({ errorCode: 'already_member' });

    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [{ id: 'u2' }];
      if (text.includes('SELECT status FROM team_members')) return [];
      if (text.includes('SELECT id FROM team_invitations')) return [{ id: 'inv0' }];
      return null;
    };
    await expect(inviteMember('u1', 't1', 'b@example.com', 'editor')).rejects.toMatchObject({ errorCode: 'invitation_pending' });
  });

  it('rejects invalid roles and owner-invites by non-owners', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [{ id: 'u2' }];
      return null;
    };
    await expect(inviteMember('u1', 't1', 'b@example.com', 'bogus')).rejects.toMatchObject({ errorCode: 'invalid_role' });
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'admin' }];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [{ id: 'u2' }];
      return null;
    };
    await expect(inviteMember('u2', 't1', 'b@example.com', 'owner')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('accepts a pending invitation, adds membership and notifies the team', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM team_invitations WHERE id = $1')) return [invitationRow()];
      if (text.includes('SELECT user_id FROM team_members')) return [{ user_id: 'u1' }];
      return null;
    };
    const invitation = await acceptInvitation('u2', 'inv1');
    expect(invitation.state).toBe('ACCEPTED');
    const insert = callsMatching('INSERT INTO team_members')[0];
    expect(insert.params[1]).toBe('t1');
    expect(insert.params[2]).toBe('u2');
    expect(insert.text).toContain("'ACTIVE'");
    expect(callsMatching("UPDATE team_invitations SET state = 'ACCEPTED'")).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.invitation_accepted' }));
    expect(notify).toHaveBeenCalledWith('u1', 'team.member_joined', expect.anything(), expect.anything());
  });

  it('refuses wrong invitee, non-pending and expired invitations', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT * FROM team_invitations WHERE id = $1') ? [invitationRow()] : null;
    await expect(acceptInvitation('u9', 'inv1')).rejects.toMatchObject({ errorCode: 'forbidden' });
    db.state.resolve = (text) =>
      text.includes('SELECT * FROM team_invitations WHERE id = $1') ? [invitationRow({ state: 'ACCEPTED' })] : null;
    await expect(acceptInvitation('u2', 'inv1')).rejects.toMatchObject({ errorCode: 'invitation_not_pending' });
    db.state.resolve = (text) =>
      text.includes('SELECT * FROM team_invitations WHERE id = $1')
        ? [invitationRow({ expires_at: new Date(Date.now() - 1000) })]
        : null;
    await expect(acceptInvitation('u2', 'inv1')).rejects.toMatchObject({ errorCode: 'invitation_expired' });
    expect(callsMatching("UPDATE team_invitations SET state = 'EXPIRED'")).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.invitation_expired' }));
  });

  it('rejects and cancels invitations with audit', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT * FROM team_invitations WHERE id = $1') ? [invitationRow()] : null;
    await expect(rejectInvitation('u2', 'inv1')).resolves.toMatchObject({ state: 'REJECTED' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.invitation_rejected' }));

    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT * FROM team_invitations WHERE id = $1 AND team_id = $2')) return [invitationRow()];
      return null;
    };
    await expect(cancelInvitation('u1', 't1', 'inv1')).resolves.toMatchObject({ state: 'CANCELLED' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.invitation_cancelled' }));
  });

  it('expires pending invitations past deadline (system sweep) with audit', async () => {
    db.state.resolve = (text) =>
      text.includes('UPDATE team_invitations SET state =')
        ? [{ id: 'inv1', team_id: 't1', invitee_user_id: 'u2' }]
        : null;
    const n = await expireInvitations();
    expect(n).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'team.invitation_expired', scope: 'SYSTEM', detail: { count: 1 } }),
    );
  });

  it('lists invitations for a team', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT * FROM team_invitations WHERE team_id')) return [invitationRow()];
      return null;
    };
    const invitations = await listInvitations('u2', 't1');
    expect(invitations[0]).toMatchObject({ id: 'inv1' });
  });
});

describe('member management', () => {
  it('owner changes a member role with notify + audit; last owner protected', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'owner'"))
        return [{ user_id: 'u2' }];
      return null;
    };
    // Demoting the only owner -> last_owner
    await expect(changeMemberRole('u1', 't1', 'u2', 'editor')).rejects.toMatchObject({ errorCode: 'last_owner' });

    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'owner'"))
        return [{ user_id: 'u1' }, { user_id: 'u2' }];
      return null;
    };
    await expect(changeMemberRole('u1', 't1', 'u2', 'editor')).resolves.toBeUndefined();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'team.member_role_changed', detail: { member: 'u2', from: 'owner', to: 'editor' } }),
    );
    expect(notify).toHaveBeenCalledWith('u2', 'team.role_changed', 'Your team role changed', expect.anything());
  });

  it('removes a member (revoke) with notify; suspended status is honoured', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'owner'"))
        return [{ user_id: 'u1' }, { user_id: 'u2' }];
      return null;
    };
    await removeTeamMember('u1', 't1', 'u2');
    const upd = callsMatching("UPDATE team_members SET status = 'REVOKED'")[0];
    expect(upd.params).toEqual(['t1', 'u2']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.member_removed' }));
    expect(notify).toHaveBeenCalledWith('u2', 'team.member_removed', expect.anything(), expect.anything());

    // revokeMembership aliases removal
    db.state.calls = [];
    notify.mockClear();
    recordAudit.mockClear();
    await revokeMembership('u1', 't1', 'u2');
    expect(callsMatching("UPDATE team_members SET status = 'REVOKED'")).toHaveLength(1);
  });

  it('suspends a member but never an owner', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return params[1] === 'u1' ? [{ role: 'owner' }] : [{ role: 'owner' }];
      return null;
    };
    await expect(suspendMember('u1', 't1', 'u2')).rejects.toMatchObject({ errorCode: 'cannot_suspend_owner' });

    db.state.resolve = (text, params) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return params[1] === 'u1' ? [{ role: 'owner' }] : [{ role: 'editor' }];
      return null;
    };
    await suspendMember('u1', 't1', 'u2');
    expect(callsMatching("UPDATE team_members SET status = 'SUSPENDED'")).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.member_suspended' }));
  });
});

describe('shared projects', () => {
  it('attaches an owned project to a team (manage role) and notifies members', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id, owner_id FROM projects')) return [{ id: 'p1', owner_id: 'u1' }];
      if (text.includes('SELECT user_id FROM team_members')) return [{ user_id: 'u1' }, { user_id: 'u2' }];
      return null;
    };
    await attachProjectToTeam('u1', 't1', 'p1');
    const upd = callsMatching('UPDATE projects SET team_id')[0];
    expect(upd.params).toEqual(['t1', 'p1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.project_shared' }));
    expect(notify).toHaveBeenCalledWith('u2', 'team.project_updated', expect.anything(), expect.anything());
  });

  it('refuses to attach someone else’s project and detaches on owner action', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id, owner_id FROM projects')) return [{ id: 'p1', owner_id: 'u9' }];
      return null;
    };
    await expect(attachProjectToTeam('u1', 't1', 'p1')).rejects.toMatchObject({ errorCode: 'forbidden' });

    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'owner' }];
      if (text.includes('SELECT id, owner_id FROM projects')) return [{ id: 'p1', owner_id: 'u1' }];
      return null;
    };
    await detachProjectFromTeam('u1', 't1', 'p1');
    expect(callsMatching('UPDATE projects SET team_id = NULL')).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.project_unshared' }));
  });

  it('lists team projects scoped to the team', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('FROM projects p')) return [projectRow({ owner_name: 'u1' })];
      return null;
    };
    const projects = await listTeamProjects('u2', 't1');
    expect(projects[0]).toMatchObject({ id: 'p1' });
    const sql = callsMatching('FROM projects p')[0];
    expect(sql.text).toContain('p.team_id = $1 AND p.deleted_at IS NULL');
  });

  it('team members can read team projects via getProject fallback', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM projects')) return [projectRow()];
      if (text.includes('SELECT 1 FROM project_members')) return [];
      if (text.includes('SELECT 1 FROM team_members')) return [{}];
      return null;
    };
    await expect(getProject('u_member', 'p1')).resolves.toMatchObject({ id: 'p1' });
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM projects')) return [projectRow()];
      if (text.includes('SELECT 1 FROM project_members')) return [];
      if (text.includes('SELECT 1 FROM team_members')) return [];
      return null;
    };
    await expect(getProject('u_stranger', 'p1')).rejects.toMatchObject({ errorCode: 'forbidden', status: 403 });
  });
});

describe('shared conversations', () => {
  it('shares a conversation with a team (owner only) and unshares', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT id, owner_id FROM conversations')) return [{ id: 'c1', owner_id: 'u1' }];
      if (text.includes('SELECT user_id FROM team_members')) return [{ user_id: 'u2' }];
      return null;
    };
    await shareConversationWithTeam('u1', 't1', 'c1');
    expect(callsMatching('UPDATE conversations SET team_id')[0].params).toEqual(['t1', 'c1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.conversation_shared' }));
    expect(notify).toHaveBeenCalledWith('u2', 'team.project_updated', expect.anything(), expect.anything());
    await unshareConversationFromTeam('u1', 't1', 'c1');
    expect(callsMatching('UPDATE conversations SET team_id = NULL')).toHaveLength(1);
  });

  it('refuses to share a conversation the user does not own', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('SELECT id, owner_id FROM conversations')) return [{ id: 'c1', owner_id: 'u9' }];
      return null;
    };
    await expect(shareConversationWithTeam('u1', 't1', 'c1')).rejects.toMatchObject({ errorCode: 'forbidden' });
  });

  it('team members can read shared conversations; strangers cannot', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) return params[1] === 'u1' || params[1] === 'u2' ? [convRow()] : [];
      return null;
    };
    await expect(getConversation('u1', 'c1')).resolves.toMatchObject({ id: 'c1', team_id: 't1' });
    await expect(getConversation('u2', 'c1')).resolves.toMatchObject({ id: 'c1' });
    await expect(getConversation('u3', 'c1')).rejects.toMatchObject({ errorCode: 'not_found' });
    const sql = callsMatching('SELECT * FROM conversations')[0];
    expect(sql.text).toContain(
      "(owner_id = $2 OR team_id IN (SELECT team_id FROM team_members WHERE user_id = $2 AND status = 'ACTIVE'))",
    );
  });

  it('listConversations optionally includes team scope without shifting params', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) return params[0] === 'u1' ? [convRow()] : [];
      return null;
    };
    const owned = await listConversations('u2');
    expect(owned).toEqual([]);
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) return params[0] === 'u1' || params[0] === 'u2' ? [convRow()] : [];
      return null;
    };
    const teamScope = await listConversations('u2', undefined, {}, true);
    expect(teamScope).toHaveLength(1);
    const sql = db.state.calls.find((c) => c.text.includes('SELECT * FROM conversations') && c.text.includes('team_id IN'))!;
    expect(sql.text).toContain("(owner_id = $1 OR team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE'))");
    expect(sql.params).toEqual(['u2']);
  });

  it('archiving/trashing a team conversation requires owner or team admin', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) return params[1] === 'u1' || params[1] === 'u2' ? [convRow()] : [];
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      return null;
    };
    await expect(updateConversation('u2', 'c1', { archived: true })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
    await expect(softDeleteConversation('u2', 'c1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });

    db.state.resolve = (text, params) => {
      if (text.includes('SELECT * FROM conversations')) return params[1] === 'u1' ? [convRow()] : [];
      return null;
    };
    await expect(updateConversation('u1', 'c1', { archived: true })).resolves.toMatchObject({ id: 'c1' });
    expect(callsMatching('UPDATE conversations SET archived')).toHaveLength(1);
    await expect(softDeleteConversation('u1', 'c1')).resolves.toBeUndefined();
    expect(callsMatching('UPDATE conversations SET deleted_at = now()')).toHaveLength(1);
  });

  it('lists conversations shared with a team', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('FROM conversations WHERE team_id')) return [convRow()];
      return null;
    };
    const conversations = await listTeamConversations('u2', 't1');
    expect(conversations[0]).toMatchObject({ id: 'c1' });
    const sql = callsMatching('FROM conversations WHERE team_id')[0];
    expect(sql.text).toContain('team_id = $1 AND deleted_at IS NULL');
  });
});

describe('team memory', () => {
  it('listTeamMemories is membership-gated and scoped to the team', async () => {
    db.state.resolve = roleResolver(null);
    await expect(listTeamMemories('u_stranger', 't1')).rejects.toMatchObject({ errorCode: 'insufficient_permission' });

    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      if (text.includes('SELECT * FROM memories')) return [{ id: 'mem1', team_id: 't1', content: 'team fact', type: 'fact', source: 'user_stated', provenance: 'u1', confidence: 0.9, contradiction_state: 'NONE', created_at: new Date() }];
      return null;
    };
    const { items } = await listTeamMemories('u2', 't1', { search: 'fact' });
    expect(items[0]).toMatchObject({ id: 'mem1' });
    const sql = callsMatching('SELECT * FROM memories')[0];
    expect(sql.text).toContain('team_id = $1');
    expect(sql.text).toContain('(content ILIKE $2 OR provenance ILIKE $2)');
  });

  it('retrieveTeamMemoriesForPrompt gates membership and labels source', async () => {
    db.state.resolve = roleResolver(null);
    await expect(retrieveTeamMemoriesForPrompt('u_stranger', 't1')).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });

    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      if (text.includes('SELECT * FROM memories'))
        return [{ id: 'mem1', content: 'Postgres chosen', source: 'user_stated', provenance: 'u1', confidence: 0.9, contradiction_state: 'NONE' }];
      return null;
    };
    const memories = await retrieveTeamMemoriesForPrompt('u2', 't1', 4);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toContain('[user_stated @ u1]: Postgres chosen');
    const sql = callsMatching('SELECT * FROM memories')[0];
    expect(sql.text).toContain("team_id = $1 AND deleted_at IS NULL AND contradiction_state <> 'CONFIRMED'");
  });
});

describe('team DNA merge restrictions', () => {
  it('rejects merges by editors/views; only owner/admin may merge', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      return null;
    };
    await expect(mergeTeamBranches('u2', 't1', 'br', 'base')).rejects.toMatchObject({ status: 403 });

    db.state.resolve = (text, params) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'admin' }];
      if (text.includes('SELECT * FROM team_dna WHERE id = $1')) {
        if (params[0] === 'br') return [{ id: 'br', team_id: 't1', scope: 'BRANCH', created_at: new Date('2026-01-01T00:00:00Z') }];
        return [{ id: 'base', team_id: 't1', scope: 'MAIN', updated_at: new Date('2026-01-02T00:00:00Z') }];
      }
      return null;
    };
    await expect(mergeTeamBranches('u2', 't1', 'br', 'base')).rejects.toMatchObject({ errorCode: 'team_dna_conflict' });
  });
});

describe('team scoped search', () => {
  it('search within a team requires membership and adds team scope', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM team_members')) return [{ role: 'editor' }];
      if (text.includes('FROM projects p'))
        return [{ id: 'p1', name: 'Alpha', description: null, created_at: new Date(), owner_id: 'u1' }];
      return null;
    };
    const { results, total } = await globalSearch('u2', { q: 'alpha', type: 'project', teamId: 't1' });
    expect(total).toBe(1);
    const sql = callsMatching('FROM projects p')[0];
    expect(sql.text).toContain('p.team_id = $3');
    expect(sql.params[2]).toBe('t1');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ filters: { teamId: 't1' } }) }));
  });

  it('non-members see no results and no entity queries for a team scope', async () => {
    db.state.resolve = roleResolver(null);
    const { results, total } = await globalSearch('u_stranger', { q: 'alpha', teamId: 't1' });
    expect(results).toEqual([]);
    expect(total).toBe(0);
    expect(callsMatching('FROM projects p')).toHaveLength(0);
  });

  it('memberId narrows results to that member’s resources', async () => {
    db.state.resolve = (text) => (text.includes('FROM files f') ? [] : null);
    await globalSearch('u1', { q: 'plan', type: 'file', memberId: 'u2' });
    const sql = callsMatching('FROM files f')[0];
    expect(sql.text).toContain('f.owner_id = $3');
    expect(sql.params[2]).toBe('u2');
  });
});

describe('team task notifications', () => {
  it('createTask announces assignment to team members of a team project', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT team_id FROM projects')) return [{ team_id: 't1' }];
      if (text.includes('SELECT user_id FROM team_members')) return [{ user_id: 'u1' }, { user_id: 'u2' }];
      if (text.includes('SELECT * FROM tasks WHERE id = $1 AND owner_id = $2')) return [taskRow()];
      return null;
    };
    await createTask({ userId: 'u1', projectId: 'p1', title: 'Deploy release' });
    expect(notify).toHaveBeenCalledWith('u2', 'team.task_assigned', expect.anything(), expect.anything());
    expect(notify).not.toHaveBeenCalledWith('u1', 'team.task_assigned', expect.anything(), expect.anything());
  });

  it('setTaskStatus notifies the team when a team task completes', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM tasks WHERE id = $1')) return [taskRow({ status: 'RUNNING', project_id: 'p1' })];
      if (text.includes('SELECT team_id FROM projects')) return [{ team_id: 't1' }];
      if (text.includes('SELECT user_id FROM team_members')) return [{ user_id: 'u2' }];
      return null;
    };
    await setTaskStatus('task1', 'COMPLETED');
    expect(notify).toHaveBeenCalledWith('u1', 'task.completed', expect.anything(), expect.anything());
    expect(notify).toHaveBeenCalledWith('u2', 'team.task_completed', expect.anything(), expect.anything());
  });
});

describe('team stats + activity', () => {
  it('teamStats aggregates members/projects/invitations/activity', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('count(*)::int AS n')) return [{ n: 3 }];
      return null;
    };
    const stats = await teamStats('u2', 't1');
    expect(stats).toEqual({ members: 3, projects: 3, pendingInvitations: 3, activities: 3 });
  });

  it('listTeamActivity returns the team feed with actor names', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT t.* FROM teams t JOIN team_members')) return [teamRow()];
      if (text.includes('FROM team_activity ta')) return [{ id: 'a1', action: 'member.invited', display_name: 'u1' }];
      return null;
    };
    const activity = await listTeamActivity('u2', 't1');
    expect(activity[0]).toMatchObject({ action: 'member.invited' });
    const sql = callsMatching('FROM team_activity ta')[0];
    expect(sql.text).toContain('WHERE ta.team_id = $1 ORDER BY ta.created_at DESC LIMIT 100');
  });
});

describe('watchdog wiring', () => {
  it('sweepOnce expires team invitations', async () => {
    db.state.resolve = (text) =>
      text.includes("UPDATE team_invitations SET state = 'EXPIRED'")
        ? [{ id: 'inv1', team_id: 't1', invitee_user_id: 'u2' }]
        : null;
    const out = await sweepOnce();
    expect(out.invitationsExpired).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'team.invitation_expired', scope: 'SYSTEM', detail: { count: 1 } }),
    );
  });
});