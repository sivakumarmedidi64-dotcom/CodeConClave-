/**
 * CodeConClave — PKG-22 Advanced Code Workspace — safe edit pipeline.
 * proposed(new content) → canonical diff → review (accept/reject hunks) → apply
 * (version-conflict safe) → record workspace_edits. No silent overwrite.
 * Multi-file changes MUST go through review; single-file direct saves
 * still require baseSha256 conflict check.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/crypto.js';
import { diffLines } from '../../os/diff.js';
import { readFileEntry, writeFileEntry } from './fs.js';
import { getWorkspace, setTabUnsaved } from './state.js';
import { workspaceEnabled } from './config.js';
import { assertProjectAccess } from '../runtime/security.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ReviewDiffFile {
  path: string;
  baseContent: string;
  proposedContent: string;
}

export interface WorkspaceReview {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string | null;
  status: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  diffText: string | null;
  files: Array<{ id: string; path: string; baseSha256: string; proposedSha256: string; accepted: boolean; applied: boolean; fileOrder: number }>;
  createdAt: Date;
}

export interface EditRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  path: string;
  baseSha256: string;
  newSha256: string;
  source: string;
  createdAt: Date;
}

// ---------------------------------------------------------------- create review (multi-file)
export async function createReview(userId: string, projectId: string, files: ReviewDiffFile[], title?: string): Promise<WorkspaceReview> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  await assertProjectAccess(userId, projectId);
  if (!files.length) throw AppError.badRequest('review_no_files', 'at least one file is required');
  if (files.length > 200) throw AppError.badRequest('review_too_many_files', 'max 200 files');

  const ws = await getWorkspace(userId, projectId);
  let totalAdditions = 0;
  let totalDeletions = 0;
  const diffParts: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const diff = diffLines(f.baseContent, f.proposedContent);
    totalAdditions += diff.additions;
    totalDeletions += diff.deletions;
    diffParts.push(`diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}`);
    for (const op of diff.ops) {
      if (op.type === 'insert') diffParts.push(`+${op.line}`);
      else if (op.type === 'delete') diffParts.push(`-${op.line}`);
      else diffParts.push(` ${op.line}`);
    }
  }

  const id = newId(PREFIX.WORKSPACE_REVIEW);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO workspace_reviews (id, workspace_id, project_id, title, status, files_changed, additions, deletions, diff_text, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, ws.workspaceId, projectId, title ?? 'Workspace change review', 'READY_FOR_REVIEW', files.length, totalAdditions, totalDeletions, diffParts.join('\n'), userId],
    ),
  );

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const baseSha = sha256Hex(f.baseContent);
    const propSha = sha256Hex(f.proposedContent);
    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO workspace_review_files (id, review_id, path, base_sha256, base_content, proposed_sha256, proposed_content, accepted, applied, file_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [newId(PREFIX.WORKSPACE_REVIEW_FILE), id, f.path, baseSha, f.baseContent, propSha, f.proposedContent, false, false, i],
      ),
    );
  }

  await recordAudit({
    action: AuditAction.COWORK_REVIEW_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'workspace_review',
    resourceId: id,
    detail: { projectId, filesChanged: files.length, additions: totalAdditions, deletions: totalDeletions },
  });

  return getReview(userId, projectId, id);
}

// ---------------------------------------------------------------- accept / reject files in a review
export async function decideFile(userId: string, projectId: string, reviewId: string, relPath: string, accepted: boolean): Promise<WorkspaceReview> {
  const ws = await getWorkspace(userId, projectId);
  await withTenant(userId, (q) =>
    q.query(
      'UPDATE workspace_review_files SET accepted = $3 WHERE review_id = $1 AND path = $2 AND review_id IN (SELECT id FROM workspace_reviews WHERE workspace_id = $4)',
      [reviewId, relPath, accepted, ws.workspaceId],
    ),
  );
  return getReview(userId, projectId, reviewId);
}

export async function acceptAll(userId: string, projectId: string, reviewId: string): Promise<WorkspaceReview> {
  const ws = await getWorkspace(userId, projectId);
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE workspace_review_files SET accepted = true WHERE review_id = $1 AND review_id IN (SELECT id FROM workspace_reviews WHERE workspace_id = $2)`,
      [reviewId, ws.workspaceId],
    ),
  );
  return getReview(userId, projectId, reviewId);
}

export async function rejectAll(userId: string, projectId: string, reviewId: string): Promise<WorkspaceReview> {
  const ws = await getWorkspace(userId, projectId);
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE workspace_review_files SET accepted = false WHERE review_id = $1 AND review_id IN (SELECT id FROM workspace_reviews WHERE workspace_id = $2)`,
      [reviewId, ws.workspaceId],
    ),
  );
  await withTenant(userId, (q) => q.query(`UPDATE workspace_reviews SET status = 'CANCELLED' WHERE id = $1 AND workspace_id = $2`, [reviewId, ws.workspaceId]));
  return getReview(userId, projectId, reviewId);
}

// ---------------------------------------------------------------- apply review (only ACCEPTED files, version-conflict safe)
export async function applyReview(userId: string, projectId: string, reviewId: string): Promise<WorkspaceReview> {
  const ws = await getWorkspace(userId, projectId);
  const files = await withTenant<{ rows: { path: string; base_sha256: string; proposed_sha256: string; proposed_content: string }[] }>(userId, (q) =>
    q.query<{ path: string; base_sha256: string; proposed_sha256: string; proposed_content: string }>(
      `SELECT path, base_sha256, proposed_sha256, proposed_content FROM workspace_review_files WHERE review_id = $1 AND accepted = true`,
      [reviewId],
    ),
  );
  const fileList = files.rows;
  if (!fileList.length) throw AppError.conflict('review_no_accepted', 'no accepted files to apply');

  const wsId = ws.workspaceId;
  let failures = 0;
  for (const f of fileList) {
    try {
      // Version-conflict check: re-read base to ensure no drift
      const current = await readFileEntry(projectId, f.path);
      if (current && current.sha256 !== f.base_sha256) {
        await withTenant(userId, (q) => q.query('UPDATE workspace_review_files SET applied = false WHERE review_id = $1 AND path = $2', [reviewId, f.path]));
        failures++;
        continue;
      }
      const newSha = await writeFileEntry(projectId, f.path, f.proposed_content);
      // Record immutable edit history
      const editId = newId(PREFIX.WORKSPACE_EDIT);
      await withTenant(userId, (q) =>
        q.query(
          `INSERT INTO workspace_edits (id, workspace_id, project_id, path, base_sha256, new_sha256, source, change_reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [editId, wsId, projectId, f.path, f.base_sha256, newSha, 'review_apply', `review:${reviewId}`, userId],
        ),
      );
      await withTenant(userId, (q) => q.query('UPDATE workspace_review_files SET applied = true WHERE review_id = $1 AND path = $2', [reviewId, f.path]));
      await setTabUnsaved(userId, projectId, f.path, false, newSha);
    } catch {
      failures++;
    }
  }

  const status = failures > 0 ? 'PARTIAL_APPLIED' : 'APPLIED';
  await withTenant(userId, (q) => q.query('UPDATE workspace_reviews SET status = $2, updated_at = now() WHERE id = $1', [reviewId, status]));

  await recordAudit({
    action: AuditAction.COWORK_REVIEW_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'workspace_review',
    resourceId: reviewId,
    detail: { failures, accepted: fileList.length },
  });

  return getReview(userId, projectId, reviewId);
}

// ---------------------------------------------------------------- read review
export async function getReview(userId: string, projectId: string, reviewId: string): Promise<WorkspaceReview> {
  const reviewRows = await withTenant<{ rows: Array<{
    id: string; workspace_id: string; project_id: string; title: string | null; status: string; files_changed: number; additions: number; deletions: number; diff_text: string | null; created_at: Date;
  }> }>(userId, (q) => q.query('SELECT * FROM workspace_reviews WHERE id = $1', [reviewId]));
  const row = reviewRows.rows[0] ?? null;
  if (!row) throw AppError.notFound('WorkspaceReview');
  const fileRows = await withTenant<{ rows: Array<{ id: string; path: string; base_sha256: string; proposed_sha256: string; accepted: boolean; applied: boolean; file_order: number }> }>(userId, (q) =>
    q.query('SELECT id, path, base_sha256, proposed_sha256, accepted, applied, file_order FROM workspace_review_files WHERE review_id = $1 ORDER BY file_order', [reviewId]),
  );
  const mappedFiles = fileRows.rows.map((f) => ({
    id: f.id, path: f.path, baseSha256: f.base_sha256, proposedSha256: f.proposed_sha256, accepted: f.accepted, applied: f.applied, fileOrder: Number(f.file_order),
  }));
  return {
    id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, title: row.title, status: row.status,
    filesChanged: Number(row.files_changed), additions: Number(row.additions), deletions: Number(row.deletions),
    diffText: row.diff_text, files: mappedFiles, createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------- list reviews
export async function listReviews(userId: string, projectId: string): Promise<WorkspaceReview[]> {
  const ws = await getWorkspace(userId, projectId);
  const rows = await withTenant<{ rows: Array<{ id: string }> }>(userId, (q) =>
    q.query<{ id: string }>(
      'SELECT id FROM workspace_reviews WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50', [ws.workspaceId],
    ),
  );
  return Promise.all(rows.rows.map((r) => getReview(userId, projectId, r.id)));
}

// ---------------------------------------------------------------- record a direct save (single-file, no review needed)
export async function recordDirectEdit(userId: string, projectId: string, relPath: string, baseSha256: string, newContent: string): Promise<EditRecord> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  await assertProjectAccess(userId, projectId);
  const ws = await getWorkspace(userId, projectId);
  const newSha = sha256Hex(newContent);
  const editId = newId(PREFIX.WORKSPACE_EDIT);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO workspace_edits (id, workspace_id, project_id, path, base_sha256, new_sha256, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [editId, ws.workspaceId, projectId, relPath, baseSha256, newSha, 'manual', userId],
    ),
  );
  return { id: editId, workspaceId: ws.workspaceId, projectId, path: relPath, baseSha256, newSha256: newSha, source: 'manual', createdAt: new Date() };
}

// ---------------------------------------------------------------- list edit history
export async function listEditHistory(userId: string, projectId: string, relPath?: string, limit = 50): Promise<EditRecord[]> {
  const ws = await getWorkspace(userId, projectId);
  const params: unknown[] = [ws.workspaceId, limit];
  const where = relPath ? 'AND path = $3' : '';
  if (relPath) params.push(relPath);
  const rows = await withTenant<{ rows: Array<{ id: string; workspace_id: string; project_id: string; path: string; base_sha256: string; new_sha256: string; source: string; created_at: Date }> }>(userId, (q) =>
    q.query<{ id: string; workspace_id: string; project_id: string; path: string; base_sha256: string; new_sha256: string; source: string; created_at: Date }>(
      `SELECT * FROM workspace_edits WHERE workspace_id = $1 ${where} ORDER BY created_at DESC LIMIT $2`,
      params,
    ),
  );
  return rows.rows.map((r) => ({
    id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, path: r.path,
    baseSha256: r.base_sha256, newSha256: r.new_sha256, source: r.source, createdAt: r.created_at,
  }));
}