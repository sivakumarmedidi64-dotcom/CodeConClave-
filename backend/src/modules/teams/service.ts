/**
 * CodeConClave — teams module (Phase 9).
 * Full team lifecycle (create/rename/archive/restore/description/settings),
 * members with roles + status, invitations with expiry and audit, team
 * activity feed, stats, and shared resources (projects, conversations,
 * memory, DNA). Server-side authority only — every function re-resolves the
 * caller's role against team_members from the database.
 */
import { pool, withTenant, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import {
  AuditAction,
  InvitationState,
  NotificationType,
  TeamMemberStatus,
  TeamRole,
  TEAM_INVITATION_TTL_MS,
  type TeamRole as TeamRoleType,
} from '@codeconclave/shared';

export interface TeamRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  archived_at: Date | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface TeamMemberRow {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRoleType;
  status: string;
  invited_by: string | null;
  joined_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface TeamInvitationRow {
  id: string;
  team_id: string;
  invited_by: string;
  invitee_user_id: string;
  invitee_email: string;
  role: TeamRoleType;
  state: string;
  expires_at: Date;
  accepted_at: Date | null;
  rejected_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
}

const EDIT_ROLES: readonly TeamRoleType[] = [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR];
const MANAGE_ROLES: readonly TeamRoleType[] = [TeamRole.OWNER, TeamRole.ADMIN];
const INVITE_ROLES: readonly TeamRoleType[] = [
  TeamRole.ADMIN,
  TeamRole.EDITOR,
  TeamRole.VIEWER,
  TeamRole.GUEST,
];

function isTeamRole(value: string): value is TeamRoleType {
  return (Object.values(TeamRole) as string[]).includes(value);
}

function assertArchivedAllowed(team: TeamRow): void {
  if (team.archived_at) throw AppError.badRequest('team_archived', 'Team is archived');
}

/** Server-side role gate: re-resolves membership from the database. */
export async function requireTeamRole(
  userId: string,
  teamId: string,
  allowed: readonly TeamRoleType[],
): Promise<TeamRoleType> {
  const role = await teamRoleFor(userId, teamId);
  if (!role || !allowed.includes(role as TeamRoleType)) throw AppError.forbidden('insufficient_permission');
  return role as TeamRoleType;
}

/**
 * Resolve an ACTIVE membership role, or null. Suspended/revoked members get
 * null. Returns the raw stored role (including legacy aliases such as
 * 'member'); canonical roles are OWNER/ADMIN/EDITOR/VIEWER/GUEST and manage
 * gates in requireTeamRole only ever match those.
 */
export async function teamRoleFor(userId: string, teamId: string): Promise<string | null> {
  const rows = await queryMany<{ role: string }>(
    "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
    [teamId, userId],
  );
  return rows[0]?.role ?? null;
}

export async function recordTeamActivity(
  teamId: string,
  actorUserId: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    'INSERT INTO team_activity (id, team_id, actor_user_id, action, detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [newId(PREFIX.TEAM_ACTIVITY), teamId, actorUserId, action, JSON.stringify(detail)],
  );
}

export async function notifyTeamMembers(
  teamId: string,
  type: (typeof NotificationType)[keyof typeof NotificationType],
  title: string,
  opts: {
    exceptUserId?: string;
    body?: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const rows = await queryMany<{ user_id: string }>(
    "SELECT user_id FROM team_members WHERE team_id = $1 AND status = 'ACTIVE'",
    [teamId],
  );
  await Promise.all(
    rows
      .map((r) => r.user_id)
      .filter((id) => id !== opts.exceptUserId)
      .map((id) =>
        notify(id, type, title, {
          body: opts.body,
          resourceType: opts.resourceType ?? 'team',
          resourceId: opts.resourceId ?? teamId,
          metadata: opts.metadata,
        }).catch(() => undefined),
      ),
  );
}

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

export async function createTeam(userId: string, name: string, description?: string): Promise<TeamRow> {
  const teamId = newId(PREFIX.TEAM);
  await withTenant(userId, async (q) => {
    await q.query('INSERT INTO teams (id, owner_id, name, description) VALUES ($1,$2,$3,$4)', [
      teamId,
      userId,
      name,
      description ?? null,
    ]);
    await q.query(
      `INSERT INTO team_members (id, team_id, user_id, role, status, invited_by, joined_at)
       VALUES ($1,$2,$3,'owner','ACTIVE',$4,now())`,
      [newId(PREFIX.TEAM), teamId, userId, userId],
    );
  });
  await recordAudit({
    action: AuditAction.TEAM_CREATED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
  });
  await recordTeamActivity(teamId, userId, 'team.created', { name });
  const rows = await queryMany<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
  return rows[0]!;
}

export async function listTeams(userId: string): Promise<TeamRow[]> {
  return queryMany<TeamRow>(
    `SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = $1 AND tm.status = 'ACTIVE' ORDER BY t.updated_at DESC`,
    [userId],
  );
}

export async function getTeam(userId: string, teamId: string): Promise<TeamRow> {
  const rows = await queryMany<TeamRow>(
    `SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id
     WHERE t.id = $1 AND tm.user_id = $2 AND tm.status = 'ACTIVE'`,
    [teamId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Team');
  return rows[0];
}

export async function renameTeam(userId: string, teamId: string, name: string): Promise<TeamRow> {
  const team = await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  assertArchivedAllowed(team);
  await pool.query('UPDATE teams SET name = $1 WHERE id = $2', [name, teamId]);
  await recordAudit({
    action: AuditAction.TEAM_RENAMED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
  });
  await recordTeamActivity(teamId, userId, 'team.renamed', { name });
  return { ...team, name };
}

export async function updateTeamDescription(
  userId: string,
  teamId: string,
  description: string,
): Promise<TeamRow> {
  const team = await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, EDIT_ROLES);
  await pool.query('UPDATE teams SET description = $1 WHERE id = $2', [description, teamId]);
  await recordAudit({
    action: AuditAction.TEAM_DESCRIPTION_UPDATED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
  });
  return { ...team, description };
}

export async function updateTeamSettings(
  userId: string,
  teamId: string,
  patch: Record<string, unknown>,
): Promise<TeamRow> {
  const team = await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  const settings = { ...team.settings, ...patch };
  await pool.query('UPDATE teams SET settings = $1::jsonb WHERE id = $2', [JSON.stringify(settings), teamId]);
  await recordAudit({
    action: AuditAction.TEAM_SETTINGS_UPDATED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
    detail: { patch },
  });
  return { ...team, settings };
}

export async function archiveTeam(userId: string, teamId: string): Promise<TeamRow> {
  const team = await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, [TeamRole.OWNER]);
  await pool.query('UPDATE teams SET archived_at = now() WHERE id = $1', [teamId]);
  await recordAudit({
    action: AuditAction.TEAM_ARCHIVED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
  });
  await recordTeamActivity(teamId, userId, 'team.archived');
  return { ...team, archived_at: new Date() };
}

export async function restoreTeam(userId: string, teamId: string): Promise<TeamRow> {
  const team = await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, [TeamRole.OWNER]);
  await pool.query('UPDATE teams SET archived_at = NULL WHERE id = $1', [teamId]);
  await recordAudit({
    action: AuditAction.TEAM_RESTORED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
  });
  await recordTeamActivity(teamId, userId, 'team.restored');
  return { ...team, archived_at: null };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function teamMembers(userId: string, teamId: string): Promise<unknown[]> {
  await getTeam(userId, teamId);
  return queryMany(
    `SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.status, tm.invited_by, tm.joined_at,
            u.email, u.display_name
     FROM team_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1 ORDER BY tm.joined_at ASC`,
    [teamId],
  );
}

export async function inviteMember(
  userId: string,
  teamId: string,
  email: string,
  role: string,
): Promise<TeamInvitationRow> {
  const team = await getTeam(userId, teamId);
  assertArchivedAllowed(team);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  if (!isTeamRole(role)) throw AppError.badRequest('invalid_role', 'Invalid role');
  if (role === TeamRole.OWNER) {
    await requireTeamRole(userId, teamId, [TeamRole.OWNER]);
  }
  const member = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email.toLowerCase()]);
  const memberId = member.rows[0]?.id as string | undefined;
  if (!memberId) throw AppError.notFound('User', 'user_not_found');

  const existing = await queryMany<{ status: string }>(
    'SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2',
    [teamId, memberId],
  );
  if (existing[0] && existing[0].status === TeamMemberStatus.ACTIVE) {
    throw AppError.badRequest('already_member', 'User is already a member');
  }
  const pending = await queryMany<{ id: string }>(
    "SELECT id FROM team_invitations WHERE team_id = $1 AND invitee_user_id = $2 AND state = 'PENDING'",
    [teamId, memberId],
  );
  if (pending[0]) throw AppError.badRequest('invitation_pending', 'An invitation is already pending');

  const invitationId = newId(PREFIX.TEAM_INVITATION);
  const days = Number(team.settings?.inviteExpiryDays) || 7;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO team_invitations (id, team_id, invited_by, invitee_user_id, invitee_email, role, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [invitationId, teamId, userId, memberId, email, role, expiresAt],
  );
  await recordAudit({
    action: AuditAction.TEAM_MEMBER_INVITED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
    detail: { invitee: memberId, role, invitation: invitationId },
  });
  await recordTeamActivity(teamId, userId, 'member.invited', { invitee: memberId, role });
  await notify(memberId, NotificationType.TEAM_INVITATION, `You're invited to join ${team.name}`, {
    body: `Role: ${role}`,
    resourceType: 'team',
    resourceId: teamId,
    metadata: { invitationId, role },
  }).catch(() => undefined);
  const rows = await queryMany<TeamInvitationRow>('SELECT * FROM team_invitations WHERE id = $1', [invitationId]);
  return rows[0]!;
}

export async function listInvitations(userId: string, teamId: string): Promise<TeamInvitationRow[]> {
  await getTeam(userId, teamId);
  return queryMany<TeamInvitationRow>(
    'SELECT * FROM team_invitations WHERE team_id = $1 ORDER BY created_at DESC',
    [teamId],
  );
}

export async function listMyInvitations(userId: string): Promise<TeamInvitationRow[]> {
  return queryMany<TeamInvitationRow>(
    `SELECT * FROM team_invitations WHERE invitee_user_id = $1
     ORDER BY (state = 'PENDING') DESC, created_at DESC`,
    [userId],
  );
}

export async function acceptInvitation(userId: string, invitationId: string): Promise<TeamInvitationRow> {
  const rows = await queryMany<TeamInvitationRow>('SELECT * FROM team_invitations WHERE id = $1', [invitationId]);
  const invitation = rows[0];
  if (!invitation) throw AppError.notFound('Invitation');
  if (invitation.invitee_user_id !== userId) throw AppError.forbidden();
  if (invitation.state !== InvitationState.PENDING) {
    throw AppError.badRequest('invitation_not_pending', 'Invitation is not pending');
  }
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    await pool.query("UPDATE team_invitations SET state = 'EXPIRED' WHERE id = $1", [invitationId]);
    await recordAudit({
      action: AuditAction.TEAM_INVITATION_EXPIRED,
      actorUserId: userId,
      scope: 'TEAM',
      tenantId: invitation.team_id,
      resourceType: 'team',
      resourceId: invitation.team_id,
    });
    throw AppError.badRequest('invitation_expired', 'Invitation has expired');
  }
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO team_members (id, team_id, user_id, role, status, invited_by, joined_at)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5,now())
       ON CONFLICT (team_id, user_id) DO UPDATE SET status = 'ACTIVE', role = EXCLUDED.role, joined_at = now()`,
      [newId(PREFIX.TEAM), invitation.team_id, userId, invitation.role, invitation.invited_by],
    );
    await q.query("UPDATE team_invitations SET state = 'ACCEPTED', accepted_at = now() WHERE id = $1", [invitationId]);
  });
  await recordAudit({
    action: AuditAction.TEAM_INVITATION_ACCEPTED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: invitation.team_id,
    resourceType: 'team',
    resourceId: invitation.team_id,
  });
  await recordTeamActivity(invitation.team_id, userId, 'member.joined', { invitation: invitationId });
  await notifyTeamMembers(invitation.team_id, NotificationType.TEAM_MEMBER_JOINED, 'New team member joined', {
    exceptUserId: userId,
    resourceType: 'team',
    resourceId: invitation.team_id,
    metadata: { member: userId },
  });
  return { ...invitation, state: InvitationState.ACCEPTED, accepted_at: new Date() };
}

export async function rejectInvitation(userId: string, invitationId: string): Promise<TeamInvitationRow> {
  const rows = await queryMany<TeamInvitationRow>('SELECT * FROM team_invitations WHERE id = $1', [invitationId]);
  const invitation = rows[0];
  if (!invitation) throw AppError.notFound('Invitation');
  if (invitation.invitee_user_id !== userId) throw AppError.forbidden();
  if (invitation.state !== InvitationState.PENDING) {
    throw AppError.badRequest('invitation_not_pending', 'Invitation is not pending');
  }
  await pool.query("UPDATE team_invitations SET state = 'REJECTED', rejected_at = now() WHERE id = $1", [invitationId]);
  await recordAudit({
    action: AuditAction.TEAM_INVITATION_REJECTED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: invitation.team_id,
    resourceType: 'team',
    resourceId: invitation.team_id,
  });
  await recordTeamActivity(invitation.team_id, userId, 'member.rejected');
  return { ...invitation, state: InvitationState.REJECTED, rejected_at: new Date() };
}

export async function cancelInvitation(
  userId: string,
  teamId: string,
  invitationId: string,
): Promise<TeamInvitationRow> {
  await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  const rows = await queryMany<TeamInvitationRow>('SELECT * FROM team_invitations WHERE id = $1 AND team_id = $2', [
    invitationId,
    teamId,
  ]);
  const invitation = rows[0];
  if (!invitation) throw AppError.notFound('Invitation');
  if (invitation.state !== InvitationState.PENDING) {
    throw AppError.badRequest('invitation_not_pending', 'Invitation is not pending');
  }
  await pool.query("UPDATE team_invitations SET state = 'CANCELLED', cancelled_at = now() WHERE id = $1", [invitationId]);
  await recordAudit({
    action: AuditAction.TEAM_INVITATION_CANCELLED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
  });
  await recordTeamActivity(teamId, userId, 'member.invitation_cancelled');
  return { ...invitation, state: InvitationState.CANCELLED, cancelled_at: new Date() };
}

/** System sweep: expire PENDING invitations past their deadline. */
export async function expireInvitations(): Promise<number> {
  const result = await pool.query<{ id: string; team_id: string; invitee_user_id: string }>(
    "UPDATE team_invitations SET state = 'EXPIRED' WHERE state = 'PENDING' AND expires_at < now() RETURNING id, team_id, invitee_user_id",
  );
  const expired = result.rows;
  if (expired.length > 0) {
    await recordAudit({
      action: AuditAction.TEAM_INVITATION_EXPIRED,
      actorUserId: null,
      scope: 'SYSTEM',
      resourceType: 'team_invitation',
      detail: { count: expired.length },
    });
  }
  return expired.length;
}

export async function changeMemberRole(
  userId: string,
  teamId: string,
  memberUserId: string,
  newRole: string,
): Promise<void> {
  await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  if (!isTeamRole(newRole)) throw AppError.badRequest('invalid_role', 'Invalid role');
  const target = await queryMany<{ role: string }>(
    "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
    [teamId, memberUserId],
  );
  if (!target[0]) throw AppError.notFound('Member');
  const targetRole = target[0].role;
  if (targetRole === TeamRole.OWNER && userId !== memberUserId) {
    // Only an owner may change another owner's role.
    await requireTeamRole(userId, teamId, [TeamRole.OWNER]);
  }
  if (newRole === TeamRole.OWNER) {
    await requireTeamRole(userId, teamId, [TeamRole.OWNER]);
  }
  if (targetRole === TeamRole.OWNER && newRole !== TeamRole.OWNER && (await teamHasOnlyOwner(userId, teamId, memberUserId))) {
    throw AppError.badRequest('last_owner', 'Cannot remove the last owner');
  }
  await pool.query('UPDATE team_members SET role = $1, updated_at = now() WHERE team_id = $2 AND user_id = $3', [
    newRole,
    teamId,
    memberUserId,
  ]);
  await recordAudit({
    action: AuditAction.TEAM_MEMBER_ROLE_CHANGED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
    detail: { member: memberUserId, from: targetRole, to: newRole },
  });
  await recordTeamActivity(teamId, userId, 'member.role_changed', { member: memberUserId, from: targetRole, to: newRole });
  await notify(memberUserId, NotificationType.TEAM_ROLE_CHANGED, 'Your team role changed', {
    body: `${targetRole} → ${newRole}`,
    resourceType: 'team',
    resourceId: teamId,
    metadata: { from: targetRole, to: newRole },
  }).catch(() => undefined);
}

async function teamHasOnlyOwner(userId: string, teamId: string, memberUserId: string): Promise<boolean> {
  const owners = await queryMany<{ user_id: string }>(
    "SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'owner' AND status = 'ACTIVE'",
    [teamId],
  );
  const activeOwners = owners.map((o) => o.user_id);
  void userId;
  return activeOwners.length <= 1 && activeOwners.includes(memberUserId);
}

export async function removeTeamMember(userId: string, teamId: string, memberUserId: string): Promise<void> {
  const team = await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  const target = await queryMany<{ role: string }>(
    "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status IN ('ACTIVE','SUSPENDED')",
    [teamId, memberUserId],
  );
  if (!target[0]) throw AppError.notFound('Member');
  const targetRole = target[0].role;
  if (targetRole === TeamRole.OWNER && userId !== memberUserId) {
    await requireTeamRole(userId, teamId, [TeamRole.OWNER]);
  }
  if (targetRole === TeamRole.OWNER && (await teamHasOnlyOwner(userId, teamId, memberUserId))) {
    throw AppError.badRequest('last_owner', 'Cannot remove the last owner');
  }
  await pool.query("UPDATE team_members SET status = 'REVOKED', updated_at = now() WHERE team_id = $1 AND user_id = $2", [
    teamId,
    memberUserId,
  ]);
  await recordAudit({
    action: AuditAction.TEAM_MEMBER_REMOVED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
    detail: { member: memberUserId, team: team.name },
  });
  await recordTeamActivity(teamId, userId, 'member.removed', { member: memberUserId });
  await notify(memberUserId, NotificationType.TEAM_MEMBER_REMOVED, `You were removed from ${team.name}`, {
    resourceType: 'team',
    resourceId: teamId,
  }).catch(() => undefined);
}

export async function suspendMember(userId: string, teamId: string, memberUserId: string): Promise<void> {
  await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  const target = await queryMany<{ role: string }>(
    "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
    [teamId, memberUserId],
  );
  if (!target[0]) throw AppError.notFound('Member');
  if (target[0].role === TeamRole.OWNER) throw AppError.badRequest('cannot_suspend_owner', 'Cannot suspend an owner');
  await pool.query("UPDATE team_members SET status = 'SUSPENDED', updated_at = now() WHERE team_id = $1 AND user_id = $2", [
    teamId,
    memberUserId,
  ]);
  await recordAudit({
    action: AuditAction.TEAM_MEMBER_SUSPENDED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team',
    resourceId: teamId,
    detail: { member: memberUserId },
  });
  await recordTeamActivity(teamId, userId, 'member.suspended', { member: memberUserId });
}

export async function revokeMembership(userId: string, teamId: string, memberUserId: string): Promise<void> {
  return removeTeamMember(userId, teamId, memberUserId);
}

export async function teamStats(userId: string, teamId: string): Promise<Record<string, number>> {
  await getTeam(userId, teamId);
  const members = await pool.query(
    "SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND status = 'ACTIVE'",
    [teamId],
  );
  const projects = await pool.query('SELECT count(*)::int AS n FROM projects WHERE team_id = $1 AND deleted_at IS NULL', [
    teamId,
  ]);
  const invitations = await pool.query(
    "SELECT count(*)::int AS n FROM team_invitations WHERE team_id = $1 AND state = 'PENDING'",
    [teamId],
  );
  const activities = await pool.query('SELECT count(*)::int AS n FROM team_activity WHERE team_id = $1', [teamId]);
  return {
    members: members.rows[0]?.n ?? 0,
    projects: projects.rows[0]?.n ?? 0,
    pendingInvitations: invitations.rows[0]?.n ?? 0,
    activities: activities.rows[0]?.n ?? 0,
  };
}

export async function listTeamActivity(userId: string, teamId: string): Promise<unknown[]> {
  await getTeam(userId, teamId);
  return queryMany(
    `SELECT ta.id, ta.team_id, ta.actor_user_id, ta.action, ta.detail, ta.created_at, u.display_name
     FROM team_activity ta JOIN users u ON u.id = ta.actor_user_id
     WHERE ta.team_id = $1 ORDER BY ta.created_at DESC LIMIT 100`,
    [teamId],
  );
}

// ---------------------------------------------------------------------------
// Shared resources
// ---------------------------------------------------------------------------

export async function listTeamProjects(userId: string, teamId: string): Promise<unknown[]> {
  await getTeam(userId, teamId);
  return queryMany(
    `SELECT p.*, u.display_name AS owner_name FROM projects p
     JOIN users u ON u.id = p.owner_id
     WHERE p.team_id = $1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`,
    [teamId],
  );
}

export async function attachProjectToTeam(
  userId: string,
  teamId: string,
  projectId: string,
): Promise<unknown> {
  await getTeam(userId, teamId);
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  const project = await pool.query('SELECT id, owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId]);
  if (!project.rows[0]) throw AppError.notFound('Project');
  if (project.rows[0].owner_id !== userId) throw AppError.forbidden();
  await pool.query('UPDATE projects SET team_id = $1 WHERE id = $2', [teamId, projectId]);
  await recordAudit({
    action: AuditAction.TEAM_PROJECT_SHARED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'project',
    resourceId: projectId,
    detail: { team: teamId },
  });
  await recordTeamActivity(teamId, userId, 'project.shared', { project: projectId });
  await notifyTeamMembers(teamId, NotificationType.TEAM_PROJECT_UPDATED, 'A project was shared with the team', {
    exceptUserId: userId,
    resourceType: 'project',
    resourceId: projectId,
  });
  return project.rows[0];
}

export async function detachProjectFromTeam(userId: string, teamId: string, projectId: string): Promise<void> {
  await getTeam(userId, teamId);
  const project = await pool.query('SELECT id, owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId]);
  if (!project.rows[0]) throw AppError.notFound('Project');
  if (project.rows[0].owner_id === userId) {
    // project owner may detach freely
  } else {
    await requireTeamRole(userId, teamId, MANAGE_ROLES);
  }
  await pool.query('UPDATE projects SET team_id = NULL WHERE id = $1', [projectId]);
  await recordAudit({
    action: AuditAction.TEAM_PROJECT_UNSHARED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'project',
    resourceId: projectId,
  });
  await recordTeamActivity(teamId, userId, 'project.unshared', { project: projectId });
}

export async function listTeamConversations(userId: string, teamId: string): Promise<unknown[]> {
  await getTeam(userId, teamId);
  return queryMany(
    `SELECT id, title, owner_id, project_id, team_id, sharing, archived, created_at, updated_at
     FROM conversations WHERE team_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
    [teamId],
  );
}

export async function shareConversationWithTeam(
  userId: string,
  teamId: string,
  conversationId: string,
): Promise<void> {
  await getTeam(userId, teamId);
  const conv = await pool.query('SELECT id, owner_id FROM conversations WHERE id = $1 AND deleted_at IS NULL', [
    conversationId,
  ]);
  if (!conv.rows[0]) throw AppError.notFound('Conversation');
  if (conv.rows[0].owner_id !== userId) throw AppError.forbidden();
  await pool.query('UPDATE conversations SET team_id = $1 WHERE id = $2', [teamId, conversationId]);
  await recordAudit({
    action: AuditAction.TEAM_CONVERSATION_SHARED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'conversation',
    resourceId: conversationId,
    detail: { team: teamId },
  });
  await recordTeamActivity(teamId, userId, 'conversation.shared', { conversation: conversationId });
  await notifyTeamMembers(teamId, NotificationType.TEAM_PROJECT_UPDATED, 'A conversation was shared with the team', {
    exceptUserId: userId,
    resourceType: 'conversation',
    resourceId: conversationId,
  });
}

export async function unshareConversationFromTeam(
  userId: string,
  teamId: string,
  conversationId: string,
): Promise<void> {
  await getTeam(userId, teamId);
  const conv = await pool.query('SELECT id, owner_id FROM conversations WHERE id = $1 AND deleted_at IS NULL', [
    conversationId,
  ]);
  if (!conv.rows[0]) throw AppError.notFound('Conversation');
  if (conv.rows[0].owner_id !== userId) throw AppError.forbidden();
  await pool.query('UPDATE conversations SET team_id = NULL WHERE id = $1', [conversationId]);
  await recordAudit({
    action: AuditAction.TEAM_CONVERSATION_UNSHARED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'conversation',
    resourceId: conversationId,
  });
  await recordTeamActivity(teamId, userId, 'conversation.unshared', { conversation: conversationId });
}

/** Ad-hoc notification used by projects/tasks within team projects (Phase 9). */
export async function notifyTeamMembersAbout(
  teamId: string,
  type: (typeof NotificationType)[keyof typeof NotificationType],
  title: string,
  opts: { exceptUserId?: string; body?: string; resourceType?: string; resourceId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  return notifyTeamMembers(teamId, type, title, opts);
}