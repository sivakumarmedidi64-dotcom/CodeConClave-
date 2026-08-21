/**
 * Stage 26G — preview commenting ("click element -> task").
 *
 * A comment is anchored to a preview version and an element selector (the
 * client sends the selector path of the clicked element). Creating a comment
 * opens a real task through the existing task engine — the comment itself is
 * the request; the task is the work item. Comments are tenant-scoped and can
 * be resolved once their task completes.
 */
import { pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { createTask } from '../execution/tasks.js';
import { getPreview } from './service.js';

export interface PreviewCommentRow {
  id: string;
  owner_id: string;
  project_id: string;
  preview_version: number;
  selector: string;
  comment: string;
  task_id: string | null;
  status: 'OPEN' | 'RESOLVED';
  created_at: Date;
  updated_at: Date;
}

export interface AddPreviewCommentInput {
  projectId: string;
  selector: string;
  comment: string;
}

function assertProject(userId: string, projectId: string): Promise<unknown> {
  return getPreview(userId, projectId);
}

export async function listPreviewComments(userId: string, projectId: string): Promise<PreviewCommentRow[]> {
  return queryMany<PreviewCommentRow>(
    'SELECT * FROM preview_comments WHERE owner_id = $1 AND project_id = $2 ORDER BY created_at DESC',
    [userId, projectId],
  );
}

export async function addPreviewComment(userId: string, input: AddPreviewCommentInput): Promise<PreviewCommentRow> {
  if (!input.projectId || !input.selector?.trim() || !input.comment?.trim()) {
    throw AppError.badRequest('comment_invalid_input', 'projectId, selector and comment are required');
  }
  const selector = input.selector.trim().slice(0, 300);
  const comment = input.comment.trim().slice(0, 4000);
  await assertProject(userId, input.projectId);
  const session = await getPreview(userId, input.projectId);
  const id = newId(PREFIX.PREVIEW_COMMENT);
  const task = await createTask({
    userId,
    projectId: input.projectId,
    title: `Preview comment: ${selector}`,
    description: `Element "${selector}" in the live preview was flagged:\n\n${comment}`,
    riskLevel: 'MEDIUM',
  });
  await pool.query(
    `INSERT INTO preview_comments (id, owner_id, project_id, preview_version, selector, comment, task_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN')`,
    [id, userId, input.projectId, session.version, selector, comment, task.id],
  );
  await recordAudit({
    action: AuditAction.PREVIEW_COMMENT_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'preview_comment',
    resourceId: id,
    detail: { projectId: input.projectId, selector, taskId: task.id, version: session.version },
  });
  await notify(userId, NotificationType.PREVIEW_COMMENT_TASK_CREATED, 'Preview comment task created', {
    body: `"${selector}" → task ${task.title}`,
    resourceType: 'preview_comment',
    resourceId: id,
    metadata: { taskId: task.id, projectId: input.projectId },
  }).catch(() => undefined);
  return (await queryMany<PreviewCommentRow>('SELECT * FROM preview_comments WHERE id = $1', [id]))[0]!;
}

export async function resolvePreviewComment(userId: string, commentId: string): Promise<PreviewCommentRow> {
  const rows = await queryMany<PreviewCommentRow>(
    'SELECT * FROM preview_comments WHERE id = $1 AND owner_id = $2',
    [commentId, userId],
  );
  const comment = rows[0];
  if (!comment) throw AppError.notFound('Preview comment');
  if (comment.status !== 'OPEN') throw AppError.conflict('comment_not_open', `Comment is ${comment.status}`);
  await pool.query(
    `UPDATE preview_comments SET status = 'RESOLVED', updated_at = now() WHERE id = $1 AND owner_id = $2`,
    [commentId, userId],
  );
  await recordAudit({
    action: AuditAction.PREVIEW_COMMENT_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'preview_comment',
    resourceId: commentId,
    detail: { projectId: comment.project_id, selector: comment.selector, taskId: comment.task_id },
  });
  return { ...comment, status: 'RESOLVED' };
}