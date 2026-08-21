/**
 * CodeConClave — ideas module (Phase 13).
 * Ideas workspace with real persisted rows. Server-authoritative authorization:
 * an idea is visible/editable by its owner, project members (when project-scoped)
 * or ACTIVE team members (when team-scoped). Statuses and priorities are enforced
 * server-side; voting and comments are real rows; archive/trash/restore are
 * reversible state changes. AI-derived ideas keep ai_generated + provenance and
 * are never silently converted to verified memory.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { requireProjectRole } from '../auth/rbac.js';
import { requireTeamRole } from '../teams/service.js';
import {
  AuditAction,
  IdeaStatus,
  NotificationType,
  TeamRole,
} from '@codeconclave/shared';

export interface IdeaRow {
  id: string;
  owner_id: string;
  team_id: string | null;
  project_id: string | null;
  title: string;
  description: string | null;
  tags: string[];
  category: string | null;
  priority: string;
  status: string;
  assignee_id: string | null;
  archived: boolean;
  deleted_at: Date | null;
  vote_count: number;
  comment_count: number;
  ai_generated: boolean;
  provenance: string | null;
  references: Array<{ type: 'memory' | 'dna'; id: string; label?: string }>;
  created_at: Date;
  updated_at: Date;
}

export function toIdeaJson(r: IdeaRow) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    teamId: r.team_id ?? null,
    projectId: r.project_id ?? null,
    title: r.title,
    description: r.description ?? null,
    tags: r.tags ?? [],
    category: r.category ?? null,
    priority: r.priority,
    status: r.status,
    assigneeId: r.assignee_id ?? null,
    archived: r.archived,
    deletedAt: r.deleted_at ?? null,
    voteCount: Number(r.vote_count ?? 0),
    commentCount: Number(r.comment_count ?? 0),
    aiGenerated: r.ai_generated,
    provenance: r.provenance ?? null,
    references: r.references ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const IDEA_TENANT_SQL =
  `(i.owner_id = $1 OR i.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1) ` +
  `OR i.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE'))`;

export async function getIdeaRow(userId: string, ideaId: string): Promise<IdeaRow> {
  const row = await queryOne<IdeaRow>(
    `SELECT i.* FROM ideas i WHERE i.id = $1 AND ${IDEA_TENANT_SQL}`,
    [ideaId, userId],
  );
  if (!row) throw AppError.notFound('Idea');
  return row;
}

/** Access to a known idea: owner, project member, or ACTIVE team member. */
export async function assertIdeaAccess(userId: string, idea: IdeaRow): Promise<void> {
  if (idea.owner_id === userId) return;
  if (idea.project_id) {
    const role = await requireProjectRole(userId, idea.project_id, ['owner', 'admin', 'editor', 'member', 'viewer']);
    if (role) return;
  }
  if (idea.team_id) {
    const role = await requireTeamRole(userId, idea.team_id, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    if (role) return;
  }
  throw AppError.forbidden('insufficient_permission', 'You do not have permission to access this idea');
}

async function notifyAssignee(ideaId: string, title: string, assigneeId: string, actorUserId: string) {
  if (assigneeId === actorUserId) return;
  await notify(assigneeId, NotificationType.IDEA_ASSIGNED, `You were assigned an idea: ${title}`, {
    resourceType: 'idea',
    resourceId: ideaId,
    body: `Idea "${title}" was assigned to you.`,
  });
}

export interface IdeaListFilters {
  q?: string;
  status?: string;
  priority?: string;
  category?: string;
  tag?: string;
  projectId?: string;
  teamId?: string;
  assigneeId?: string;
  archived?: boolean;
  trashed?: boolean;
  limit?: number;
  offset?: number;
}

export async function listIdeas(userId: string, filters: IdeaListFilters = {}) {
  const params: unknown[] = [userId];
  const clauses: string[] = [IDEA_TENANT_SQL];
  const where = (cond: string, value: unknown) => {
    params.push(value);
    clauses.push(cond.replace('?', `$${params.length}`));
  };
  if (filters.trashed) {
    clauses.push('i.deleted_at IS NOT NULL');
  } else {
    clauses.push('i.deleted_at IS NULL');
    if (filters.archived !== undefined) where('i.archived = ?', filters.archived);
  }
  if (filters.status) where('i.status = ?', filters.status);
  if (filters.priority) where('i.priority = ?', filters.priority);
  if (filters.category) where('i.category = ?', filters.category);
  if (filters.projectId) where('i.project_id = ?', filters.projectId);
  if (filters.teamId) where('i.team_id = ?', filters.teamId);
  if (filters.assigneeId) where('i.assignee_id = ?', filters.assigneeId);
  if (filters.tag) where('? = ANY(i.tags)', filters.tag);
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
    clauses.push(`(i.title ILIKE $${params.length - 1} OR COALESCE(i.description, '') ILIKE $${params.length})`);
  }
  const whereSql = clauses.join('\n  AND ');
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  params.push(limit, filters.offset ?? 0);
  const totalRow = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ideas i WHERE ${whereSql}`,
    params.slice(0, params.length - 2),
  );
  const rows = await queryMany<IdeaRow>(
    `SELECT i.* FROM ideas i WHERE ${whereSql}
     ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows, total: totalRow?.n ?? 0 };
}

export async function getIdea(userId: string, ideaId: string) {
  const row = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, row);
  return toIdeaJson(row);
}

export interface CreateIdeaInput {
  title: string;
  description?: string;
  tags?: string[];
  category?: string;
  priority?: string;
  status?: string;
  projectId?: string;
  teamId?: string;
  assigneeId?: string | null;
  references?: Array<{ type: 'memory' | 'dna'; id: string; label?: string }>;
  provenance?: string;
  aiGenerated?: boolean;
}

export async function createIdea(userId: string, input: CreateIdeaInput) {
  if (input.projectId) {
    await requireProjectRole(userId, input.projectId, ['owner', 'admin', 'editor', 'member', 'viewer']);
  }
  if (input.teamId && !input.projectId) {
    await requireTeamRole(userId, input.teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
  }
  const id = newId(PREFIX.IDEA);
  const status = input.status ?? IdeaStatus.PROPOSED;
  const rows = await queryMany<IdeaRow>(
    `INSERT INTO ideas
       (id, owner_id, team_id, project_id, title, description, tags, category, priority, status,
        assignee_id, references, provenance, ai_generated)
     VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12::jsonb,$13,$14)
     RETURNING *`,
    [
      id,
      userId,
      input.projectId ? null : (input.teamId ?? null),
      input.projectId ?? null,
      input.title,
      input.description ?? null,
      input.tags ?? [],
      input.category ?? null,
      input.priority ?? 'MEDIUM',
      status,
      input.assigneeId ?? null,
      JSON.stringify(input.references ?? []),
      input.provenance ?? null,
      input.aiGenerated ?? false,
    ],
  );
  const row = rows[0] as IdeaRow;
  await recordAudit({
    action: AuditAction.IDEA_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: id,
    detail: { projectId: input.projectId ?? null, teamId: input.teamId ?? null, priority: input.priority, status },
  });
  if (row.assignee_id) {
    await notifyAssignee(id, row.title, row.assignee_id, userId);
    await recordAudit({
      action: AuditAction.IDEA_ASSIGNED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'idea',
      resourceId: id,
      detail: { assigneeId: row.assignee_id },
    });
  }
  return toIdeaJson(row);
}

export interface UpdateIdeaInput {
  title?: string;
  description?: string | null;
  tags?: string[];
  category?: string | null;
  priority?: string;
  status?: string;
  assigneeId?: string | null;
}

export async function updateIdea(userId: string, ideaId: string, input: UpdateIdeaInput) {
  const current = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, current);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.title !== undefined) set('title', input.title);
  if (input.description !== undefined) set('description', input.description);
  if (input.tags !== undefined) set('tags', input.tags);
  if (input.category !== undefined) set('category', input.category);
  if (input.priority !== undefined) set('priority', input.priority);
  if (input.status !== undefined) set('status', input.status);
  if (input.assigneeId !== undefined) set('assignee_id', input.assigneeId);
  if (!sets.length) return toIdeaJson(current);
  const nextAssignee = input.assigneeId !== undefined ? input.assigneeId : current.assignee_id;
  const rows = await queryMany<IdeaRow>(
    `UPDATE ideas SET ${sets.join(', ')} WHERE id = $${params.length + 1} RETURNING *`,
    [...params, ideaId],
  );
  const updated = rows[0] as IdeaRow;
  await recordAudit({
    action: AuditAction.IDEA_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: ideaId,
    detail: {
      changed: sets.map((s) => s.split(' = ')[0]),
      status: updated.status,
      priority: updated.priority,
    },
  });
  if (nextAssignee && nextAssignee !== current.assignee_id) {
    await notifyAssignee(ideaId, updated.title, nextAssignee, userId);
    await recordAudit({
      action: AuditAction.IDEA_ASSIGNED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'idea',
      resourceId: ideaId,
      detail: { assigneeId: nextAssignee },
    });
  }
  return toIdeaJson(updated);
}

export async function setIdeaArchived(userId: string, ideaId: string, archived: boolean) {
  const row = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, row);
  const rows = await queryMany<IdeaRow>(
    'UPDATE ideas SET archived = $1 WHERE id = $2 RETURNING *',
    [archived, ideaId],
  );
  await recordAudit({
    action: AuditAction.IDEA_ARCHIVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: ideaId,
    detail: { archived },
  });
  return toIdeaJson(rows[0] as IdeaRow);
}

export async function trashIdea(userId: string, ideaId: string) {
  const row = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, row);
  if (row.deleted_at) throw AppError.conflict('already_trashed', 'Idea is already trashed');
  await pool.query('UPDATE ideas SET deleted_at = now() WHERE id = $1', [ideaId]);
  await recordAudit({
    action: AuditAction.IDEA_TRASHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: ideaId,
  });
  return { id: ideaId, trashed: true };
}

export async function restoreIdea(userId: string, ideaId: string) {
  const row = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, row);
  if (!row.deleted_at) throw AppError.conflict('not_trashed', 'Idea is not trashed');
  await pool.query('UPDATE ideas SET deleted_at = NULL WHERE id = $1', [ideaId]);
  await recordAudit({
    action: AuditAction.IDEA_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: ideaId,
  });
  const restored = await getIdeaRow(userId, ideaId);
  return toIdeaJson(restored);
}

// ---------------------------------------------------------------- voting

export async function voteIdea(userId: string, ideaId: string, on: boolean) {
  const row = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, row);
  if (row.deleted_at) throw AppError.conflict('not_found', 'Idea is not available');
  if (on) {
    await pool.query(
      'INSERT INTO idea_votes (id, idea_id, user_id) VALUES ($1,$2,$3) ON CONFLICT (idea_id, user_id) DO NOTHING',
      [newId(PREFIX.IDEA_VOTE), ideaId, userId],
    );
  } else {
    await pool.query('DELETE FROM idea_votes WHERE idea_id = $1 AND user_id = $2', [ideaId, userId]);
  }
  await pool.query(
    'UPDATE ideas SET vote_count = (SELECT count(*)::int FROM idea_votes WHERE idea_id = $1) WHERE id = $1',
    [ideaId],
  );
  await recordAudit({
    action: AuditAction.IDEA_VOTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: ideaId,
    detail: { on },
  });
  const updated = await getIdeaRow(userId, ideaId);
  return toIdeaJson(updated);
}

export async function ideaVoteState(userId: string, ideaId: string): Promise<boolean> {
  await getIdeaRow(userId, ideaId);
  const rows = await queryMany<{ n: number }>(
    'SELECT count(*)::int AS n FROM idea_votes WHERE idea_id = $1 AND user_id = $2',
    [ideaId, userId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

// ---------------------------------------------------------------- comments

export interface IdeaCommentRow {
  id: string;
  idea_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  deleted_at: Date | null;
  created_at: Date;
}

export function toIdeaCommentJson(c: IdeaCommentRow) {
  return {
    id: c.id,
    ideaId: c.idea_id,
    authorId: c.author_id,
    parentId: c.parent_id ?? null,
    content: c.content,
    deletedAt: c.deleted_at ?? null,
    createdAt: c.created_at,
  };
}

export async function addIdeaComment(
  userId: string,
  ideaId: string,
  input: { content: string; parentId?: string },
) {
  const idea = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, idea);
  if (idea.deleted_at) throw AppError.conflict('not_found', 'Idea is not available');
  if (input.parentId) {
    const parent = await queryOne<IdeaCommentRow>(
      'SELECT * FROM idea_comments WHERE id = $1 AND idea_id = $2',
      [input.parentId, ideaId],
    );
    if (!parent) throw AppError.notFound('Comment');
  }
  const id = newId(PREFIX.IDEA_COMMENT);
  const rows = await queryMany<IdeaCommentRow>(
    `INSERT INTO idea_comments (id, idea_id, author_id, parent_id, content)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, ideaId, userId, input.parentId ?? null, input.content],
  );
  await pool.query('UPDATE ideas SET comment_count = comment_count + 1 WHERE id = $1', [ideaId]);
  await recordAudit({
    action: AuditAction.IDEA_COMMENTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'idea',
    resourceId: ideaId,
    detail: { commentId: id },
  });
  return toIdeaCommentJson(rows[0] as IdeaCommentRow);
}

export async function listIdeaComments(userId: string, ideaId: string) {
  const idea = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, idea);
  const rows = await queryMany<IdeaCommentRow>(
    `SELECT * FROM idea_comments WHERE idea_id = $1
     ORDER BY created_at ASC LIMIT 200`,
    [ideaId],
  );
  return rows.map(toIdeaCommentJson);
}

export async function deleteIdeaComment(userId: string, ideaId: string, commentId: string) {
  const idea = await getIdeaRow(userId, ideaId);
  await assertIdeaAccess(userId, idea);
  const comment = await queryOne<IdeaCommentRow>(
    'SELECT * FROM idea_comments WHERE id = $1 AND idea_id = $2',
    [commentId, ideaId],
  );
  if (!comment) throw AppError.notFound('Comment');
  if (comment.author_id !== userId && idea.owner_id !== userId) {
    throw AppError.forbidden('insufficient_permission', 'Only the author or idea owner can delete this comment');
  }
  await pool.query('UPDATE idea_comments SET deleted_at = now() WHERE id = $1', [commentId]);
  await pool.query(
    'UPDATE ideas SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1',
    [ideaId],
  );
  return { id: commentId, deleted: true };
}