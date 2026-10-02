/**
 * CodeConClave — Phase 9 shared contracts.
 * Team collaboration constants must be frozen and match the values the
 * backend services, migrations and frontend rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  TeamRole,
  TEAM_ROLE_RANK,
  TeamMemberStatus,
  InvitationState,
  TEAM_INVITATION_TTL_MS,
  NotificationType,
  AuditAction,
} from './constants.js';

describe('Phase 9 — team roles', () => {
  it('team roles cover owner, admin, editor, viewer and guest', () => {
    expect(TeamRole.OWNER).toBe('owner');
    expect(TeamRole.ADMIN).toBe('admin');
    expect(TeamRole.EDITOR).toBe('editor');
    expect(TeamRole.VIEWER).toBe('viewer');
    expect(TeamRole.GUEST).toBe('guest');
  });

  it('roles are strictly ordered: owner > admin > editor > viewer > guest', () => {
    expect(TEAM_ROLE_RANK[TeamRole.OWNER]).toBeGreaterThan(TEAM_ROLE_RANK[TeamRole.ADMIN]);
    expect(TEAM_ROLE_RANK[TeamRole.ADMIN]).toBeGreaterThan(TEAM_ROLE_RANK[TeamRole.EDITOR]);
    expect(TEAM_ROLE_RANK[TeamRole.EDITOR]).toBeGreaterThan(TEAM_ROLE_RANK[TeamRole.VIEWER]);
    expect(TEAM_ROLE_RANK[TeamRole.VIEWER]).toBeGreaterThan(TEAM_ROLE_RANK[TeamRole.GUEST]);
  });
});

describe('Phase 9 — membership status + invitations', () => {
  it('member status distinguishes ACTIVE, SUSPENDED and REVOKED', () => {
    expect(TeamMemberStatus.ACTIVE).toBe('ACTIVE');
    expect(TeamMemberStatus.SUSPENDED).toBe('SUSPENDED');
    expect(TeamMemberStatus.REVOKED).toBe('REVOKED');
  });

  it('invitation state covers the full lifecycle', () => {
    expect(InvitationState.PENDING).toBe('PENDING');
    expect(InvitationState.ACCEPTED).toBe('ACCEPTED');
    expect(InvitationState.REJECTED).toBe('REJECTED');
    expect(InvitationState.EXPIRED).toBe('EXPIRED');
    expect(InvitationState.CANCELLED).toBe('CANCELLED');
  });

  it('invitations are valid for 7 days by default', () => {
    expect(TEAM_INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('Phase 9 — notifications', () => {
  it('team notification types exist', () => {
    expect(NotificationType.TEAM_INVITATION).toBe('team.invitation');
    expect(NotificationType.TEAM_MEMBER_JOINED).toBe('team.member_joined');
    expect(NotificationType.TEAM_MEMBER_REMOVED).toBe('team.member_removed');
    expect(NotificationType.TEAM_ROLE_CHANGED).toBe('team.role_changed');
    expect(NotificationType.TEAM_PROJECT_UPDATED).toBe('team.project_updated');
    expect(NotificationType.TEAM_TASK_ASSIGNED).toBe('team.task_assigned');
    expect(NotificationType.TEAM_TASK_COMPLETED).toBe('team.task_completed');
    expect(NotificationType.TEAM_APPROVAL_REQUESTED).toBe('team.approval_requested');
  });
});

describe('Phase 9 — audit actions', () => {
  it('team audit action codes exist', () => {
    expect(AuditAction.TEAM_CREATED).toBe('team.created');
    expect(AuditAction.TEAM_RENAMED).toBe('team.renamed');
    expect(AuditAction.TEAM_ARCHIVED).toBe('team.archived');
    expect(AuditAction.TEAM_RESTORED).toBe('team.restored');
    expect(AuditAction.TEAM_DESCRIPTION_UPDATED).toBe('team.description_updated');
    expect(AuditAction.TEAM_SETTINGS_UPDATED).toBe('team.settings_updated');
    expect(AuditAction.TEAM_MEMBER_INVITED).toBe('team.member_invited');
    expect(AuditAction.TEAM_INVITATION_ACCEPTED).toBe('team.invitation_accepted');
    expect(AuditAction.TEAM_INVITATION_REJECTED).toBe('team.invitation_rejected');
    expect(AuditAction.TEAM_INVITATION_CANCELLED).toBe('team.invitation_cancelled');
    expect(AuditAction.TEAM_INVITATION_EXPIRED).toBe('team.invitation_expired');
    expect(AuditAction.TEAM_MEMBER_ADDED).toBe('team.member_added');
    expect(AuditAction.TEAM_MEMBER_REMOVED).toBe('team.member_removed');
    expect(AuditAction.TEAM_MEMBER_ROLE_CHANGED).toBe('team.member_role_changed');
    expect(AuditAction.TEAM_MEMBER_SUSPENDED).toBe('team.member_suspended');
    expect(AuditAction.TEAM_MEMBER_REVOKED).toBe('team.member_revoked');
    expect(AuditAction.TEAM_PROJECT_SHARED).toBe('team.project_shared');
    expect(AuditAction.TEAM_PROJECT_UNSHARED).toBe('team.project_unshared');
    expect(AuditAction.TEAM_CONVERSATION_SHARED).toBe('team.conversation_shared');
    expect(AuditAction.TEAM_CONVERSATION_UNSHARED).toBe('team.conversation_unshared');
    expect(AuditAction.TEAM_MEMORY_ADDED).toBe('team.memory_added');
    expect(AuditAction.TEAM_PERMISSION_CHANGED).toBe('team.permission_changed');
  });
});