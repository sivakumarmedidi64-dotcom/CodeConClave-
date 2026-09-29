/**
 * CodeConClave — projects module.
 * CRUD, status lifecycle (ACTIVE/ARCHIVED/COMPLETED/ON_HOLD), favorites, tags,
 * deadlines, activity feed, membership, soft delete (30-day recovery).
 * Permissions (server-side): read = owner/admin/editor/member/viewer;
 * write/status/members = owner/admin/editor; delete = owner. VIEWER is read-only.
 */
import { withSystem, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { FreeLimits, ProjectStatus, AuditAction, type ProjectStatus as ProjectStatusType } from '@codeconclave/shared';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/service.js';
import { requireProjectRole } from '../auth/rbac.js';

export interface ProjectRow {
  id: string;
  owner_id: string;
  team_id: string | null;
  name: string;
  description: string | null;
  repo_url: string | null;
  workspace_root: string | null;
  status: ProjectStatusType;
  deadline: Date | null;
  is_favorite: boolean;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const PROJECT_STATUSES: readonly ProjectStatusType[] = [
  ProjectStatus.ACTIVE,
  ProjectStatus.ARCHIVED,
  ProjectStatus.COMPLETED,
  ProjectStatus.ON_HOLD,
];

function toJson(row: ProjectRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    repoUrl: row.repo_url,
    workspaceRoot: row.workspace_root,
    status: row.status,
    deadline: row.deadline ?? null,
    favorite: row.is_favorite ?? false,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** Insert an immutable activity record; best-effort (never blocks the action). */
async function recordProjectActivity(
  userId: string,
  projectId: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO project_activity (id, project_id, actor_user_id, action, detail)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [newId(PREFIX.PROJECT_ACTIVITY), projectId, userId, action, JSON.stringify(detail)],
      ),
    );
  } catch {
    /* activity is a feed, not a source of truth */
  }
}

export async function countProjects(userId: string): Promise<number> {
  const result = await withTenant(userId, (q) =>
    q.query('SELECT count(*)::int AS n FROM projects WHERE owner_id = $1 AND deleted_at IS NULL', [userId]),
  );
  return result.rows[0]?.n ?? 0;
}

export async function createProject(
  userId: string,
  input: { name: string; description?: string; repoUrl?: string; deadline?: string | null; tags?: string[] },
): Promise<ProjectRow> {
  const user = await withTenant(userId, (q) => q.query('SELECT plan_id FROM users WHERE id = $1', [userId]));
  const planId = user.rows[0]?.plan_id ?? 'free';
  const count = await countProjects(userId);
  const maxProjects = planId === 'pro' ? 10 : FreeLimits.MAX_PROJECTS;
  if (count >= maxProjects) {
    throw AppError.badRequest(
      'project_limit_reached',
      planId === 'pro'
        ? 'You have reached your project limit (10). Archive or delete projects to continue.'
        : 'Free plan allows 1 project. Upgrade to Pro for 10 projects.',
      { current: count, max: maxProjects, plan: planId },
    );
  }

  const projectId = newId(PREFIX.PROJECT);
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO projects (id, owner_id, name, description, repo_url, deadline, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        projectId,
        userId,
        input.name,
        input.description ?? null,
        input.repoUrl ?? null,
        input.deadline ?? null,
        input.tags ?? [],
      ],
    );
  });
  const project = await getProject(userId, projectId);
  await recordAudit({
    action: AuditAction.PROJECT_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
  });
  await recordProjectActivity(userId, projectId, 'project.created', { name: input.name });

  // 24/7 autonomous provisioning (inert unless AIOS_P2_AUTONOMY=true).
  // Fire-and-forget: project creation NEVER fails because provisioning did.
  await import('../autonomy/provision.js')
    .then((m) => m.provisionAutonomousProject(userId, projectId, input.name))
    .catch(() => undefined);

  return project;
}

export async function getProject(userId: string, projectId: string): Promise<ProjectRow> {
  const result = await withTenant(userId, (q) =>
    q.query(`SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]),
  );
  const row = result.rows[0] as ProjectRow | undefined;
  if (!row) throw AppError.notFound('Project');
  if (row.owner_id !== userId) {
    const member = await withTenant(userId, (q) =>
      q.query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]),
    );
    if (!member.rows[0] && row.team_id) {
      // Phase 9: team members share team projects (team_id is set).
      const teamMember = await withTenant(userId, (q) =>
        q.query("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'ACTIVE'", [
          row.team_id,
          userId,
        ]),
      );
      if (!teamMember.rows[0]) throw AppError.forbidden();
    } else if (!member.rows[0]) {
      throw AppError.forbidden();
    }
  }
  return row;
}

export async function listProjects(
  userId: string,
  includeArchived = false,
  filters: { favorite?: boolean; status?: string; tag?: string } = {},
): Promise<ProjectRow[]> {
  const params: unknown[] = [userId, includeArchived];
  const clauses: string[] = [
    "(p.owner_id = $1 OR pm.user_id IS NOT NULL OR p.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE')) AND p.deleted_at IS NULL",
    '(p.status = $2 OR p.status = \'ACTIVE\' OR p.status = \'COMPLETED\' OR p.status = \'ON_HOLD\')',
  ];
  if (includeArchived) clauses.pop();
  if (filters.favorite !== undefined) {
    params.push(filters.favorite);
    clauses.push(`p.is_favorite = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`p.status = $${params.length}`);
  }
  if (filters.tag) {
    params.push(filters.tag);
    clauses.push(`$${params.length} = ANY(p.tags)`);
  }
  const rows = await withTenant<ProjectRow[]>(userId, async (q) =>
    (
      await q.query<ProjectRow>(
        `SELECT p.* FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.updated_at DESC`,
        params,
      )
    ).rows,
  );
  return rows;
}

export async function updateProject(
  userId: string,
  projectId: string,
  input: {
    name?: string;
    description?: string | null;
    repoUrl?: string | null;
    status?: ProjectStatusType;
    deadline?: string | null;
    favorite?: boolean;
    tags?: string[];
  },
): Promise<ProjectRow> {
  await requireProjectRole(userId, projectId, ['owner', 'admin', 'editor']);
  const fields: string[] = [];
  const params: unknown[] = [projectId];
  const set = (col: string, value: unknown) => {
    fields.push(`${col} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name !== undefined) set('name', input.name);
  if (input.description !== undefined) set('description', input.description);
  if (input.repoUrl !== undefined) set('repo_url', input.repoUrl || null);
  if (input.status !== undefined) {
    if (!PROJECT_STATUSES.includes(input.status)) {
      throw AppError.badRequest('invalid_status', 'Status must be ACTIVE, ARCHIVED, COMPLETED, or ON_HOLD');
    }
    set('status', input.status);
  }
  if (input.deadline !== undefined) set('deadline', input.deadline);
  if (input.favorite !== undefined) set('is_favorite', input.favorite);
  if (input.tags !== undefined) set('tags', input.tags);
  if (fields.length) {
    await withTenant(userId, (q) => q.query(`UPDATE projects SET ${fields.join(', ')} WHERE id = $1`, params));
  }
  if (input.status !== undefined) {
    await recordAudit({
      action: AuditAction.PROJECT_STATUS_CHANGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'project',
      resourceId: projectId,
      detail: { status: input.status },
    });
    await recordProjectActivity(userId, projectId, 'project.status_changed', { status: input.status });
  } else {
    await recordAudit({
      action: AuditAction.PROJECT_UPDATED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'project',
      resourceId: projectId,
    });
  }
  return getProject(userId, projectId);
}

/** Convenience lifecycle helpers (same permission surface as updateProject). */
export function completeProject(userId: string, projectId: string): Promise<ProjectRow> {
  return updateProject(userId, projectId, { status: ProjectStatus.COMPLETED });
}

export function onHoldProject(userId: string, projectId: string): Promise<ProjectRow> {
  return updateProject(userId, projectId, { status: ProjectStatus.ON_HOLD });
}

export async function toggleFavoriteProject(userId: string, projectId: string): Promise<ProjectRow> {
  await requireProjectRole(userId, projectId, ['owner', 'admin', 'editor']);
  const result = await withTenant(userId, (q) =>
    q.query('UPDATE projects SET is_favorite = NOT is_favorite WHERE id = $1 RETURNING is_favorite', [projectId]),
  );
  const favorite = Boolean(result.rows[0]?.is_favorite);
  await recordAudit({
    action: AuditAction.PROJECT_FAVORITED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
    detail: { favorite },
  });
  await recordProjectActivity(userId, projectId, 'project.favorited', { favorite });
  return getProject(userId, projectId);
}

export async function archiveProject(userId: string, projectId: string, archive: boolean): Promise<ProjectRow> {
  await requireProjectRole(userId, projectId, ['owner', 'admin', 'editor']);
  await withTenant(userId, (q) =>
    q.query('UPDATE projects SET status = $1 WHERE id = $2', [archive ? 'ARCHIVED' : 'ACTIVE', projectId]),
  );
  await recordAudit({
    action: archive ? AuditAction.PROJECT_ARCHIVED : AuditAction.PROJECT_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
  });
  await recordProjectActivity(userId, projectId, archive ? 'project.archived' : 'project.unarchived', {});
  return getProject(userId, projectId);
}

export async function softDeleteProject(userId: string, projectId: string): Promise<void> {
  await requireProjectRole(userId, projectId, ['owner']);
  await withTenant(userId, (q) => q.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [projectId]));
  await recordAudit({
    action: AuditAction.PROJECT_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
    detail: { soft: true },
  });
  await recordProjectActivity(userId, projectId, 'project.deleted', { soft: true });
}

export async function restoreProject(userId: string, projectId: string): Promise<ProjectRow> {
  const result = await withTenant(userId, (q) =>
    q.query('UPDATE projects SET deleted_at = NULL WHERE id = $1 AND owner_id = $2 RETURNING *', [projectId, userId]),
  );
  const row = result.rows[0] as ProjectRow | undefined;
  if (!row) throw AppError.notFound('Project');
  await recordAudit({
    action: AuditAction.PROJECT_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
  });
  await recordProjectActivity(userId, projectId, 'project.restored', {});
  return row;
}

export async function trashCandidates(userId: string): Promise<ProjectRow[]> {
  return withTenant<ProjectRow[]>(userId, async (q) =>
    (
      await q.query<ProjectRow>(
        `SELECT * FROM projects WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at > now() - interval '30 days'
         ORDER BY deleted_at DESC`,
        [userId],
      )
    ).rows,
  );
}

export async function listProjectActivity(userId: string, projectId: string, limit = 50): Promise<unknown[]> {
  await getProject(userId, projectId);
  return withSystem<unknown[]>(async (q) =>
    (
      await q.query(
        `SELECT pa.id, pa.action, pa.detail, pa.created_at, u.display_name AS actor_name
         FROM project_activity pa LEFT JOIN users u ON u.id = pa.actor_user_id
         WHERE pa.project_id = $1 ORDER BY pa.created_at DESC LIMIT $2`,
        [projectId, Math.min(limit, 200)],
      )
    ).rows,
  );
}

export async function projectStats(userId: string, projectId: string): Promise<Record<string, number>> {
  const project = await getProject(userId, projectId);
  void project;
  const [files, conversations, tasks, messages, members] = await withTenant(userId, (q) =>
    Promise.all([
      q.query('SELECT count(*)::int AS n FROM files WHERE project_id = $1 AND deleted_at IS NULL', [projectId]),
      q.query('SELECT count(*)::int AS n FROM conversations WHERE project_id = $1 AND deleted_at IS NULL', [projectId]),
      q.query('SELECT count(*)::int AS n FROM tasks WHERE project_id = $1', [projectId]),
      q.query(
        `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.project_id = $1 AND m.deleted_at IS NULL`,
        [projectId],
      ),
      q.query('SELECT count(*)::int AS n FROM project_members WHERE project_id = $1', [projectId]),
    ]),
  );
  return {
    files: files.rows[0]?.n ?? 0,
    conversations: conversations.rows[0]?.n ?? 0,
    tasks: tasks.rows[0]?.n ?? 0,
    messages: messages.rows[0]?.n ?? 0,
    members: members.rows[0]?.n ?? 0,
  };
}

export async function listProjectMembers(userId: string, projectId: string): Promise<unknown[]> {
  await getProject(userId, projectId);
  const result = await withSystem((q) =>
    q.query(
      `SELECT pm.id, pm.user_id, pm.role, u.email, u.display_name FROM project_members pm
       JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1`,
      [projectId],
    ),
  );
  return result.rows;
}

export async function addProjectMember(userId: string, projectId: string, memberEmail: string, role: string): Promise<void> {
  const callerRole = await requireProjectRole(userId, projectId, ['owner', 'admin']);
  // Only the owner may grant owner membership.
  if (role === 'owner' && callerRole !== 'owner') {
    throw AppError.forbidden('insufficient_permission', 'Only the project owner may grant the owner role');
  }
  const member = await withSystem((q) =>
    q.query('SELECT id FROM users WHERE lower(email) = $1', [memberEmail.toLowerCase()]),
  );
  const memberId = member.rows[0]?.id as string | undefined;
  if (!memberId) throw AppError.notFound('User', 'user_not_found');
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO project_members (id, project_id, user_id, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [newId(PREFIX.PROJECT), projectId, memberId, role],
    ),
  );
  await recordAudit({
    action: AuditAction.PROJECT_MEMBER_ADDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
    detail: { memberUserId: memberId, role },
  });
  await recordProjectActivity(userId, projectId, 'project.member_added', { memberUserId: memberId, role });
}

export async function removeProjectMember(userId: string, projectId: string, memberUserId: string): Promise<void> {
  const callerRole = await requireProjectRole(userId, projectId, ['owner', 'admin']);
  // Only the owner may remove the last owner from a project.
  if (callerRole !== 'owner') {
    const isOwnerRow = await withTenant(userId, (q) =>
      q.query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = $3', [
        projectId,
        memberUserId,
        'owner',
      ]),
    );
    if (isOwnerRow.rows[0]) {
      throw AppError.forbidden('insufficient_permission', 'Only the project owner may remove the project owner');
    }
  }
  await withTenant(userId, (q) =>
    q.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, memberUserId]),
  );
  await recordAudit({
    action: AuditAction.PROJECT_MEMBER_REMOVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'project',
    resourceId: projectId,
    detail: { memberUserId },
  });
  await recordProjectActivity(userId, projectId, 'project.member_removed', { memberUserId });
}

export const userHasAccess = async (userId: string, projectId: string): Promise<boolean> => {
  try {
    await getProject(userId, projectId);
    return true;
  } catch {
    return false;
  }
};