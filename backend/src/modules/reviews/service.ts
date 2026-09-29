/**
 * CodeConClave — B1 cowork safety review loop: service.
 *
 * Server-authoritative review lifecycle + persistence. All mutating operations:
 *   1. authenticate (route)
 *   2. ownership/workspace check (owner_id + project membership)
 *   3. stop-rule + resource-governor checks where a real action occurs
 *   4. persistence + audit + events
 * Stale hunks fail closed (INVALIDATED + deterministic conflict).
 * Apply/undo write through the CANONICAL file service (versioned, hash-verified);
 * tests run through the CANONICAL policy sandbox; commits go through the
 * CANONICAL git engine. No parallel engines, stores or permission systems.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { withTenant, type DbQueryable } from '../../shared/db.js';
import type { PoolClient } from 'pg';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { getFileContent, uploadFile } from '../files/service.js';
import { getProject } from '../projects/service.js';
import { looksLikeSecretPath } from '../execution/policy.js';
import { AuditAction } from '@codeconclave/shared';
import {
  computeReviewDiff,
  applyAcceptedHunks,
  splitCanonical,
  sha256Of,
} from './diff.js';
import { getRuntime, materializeWorktree, reviewCapabilities } from './runtime.js';
import {
  REVIEW_DEFAULT_TITLE,
  HunkStatus,
  ReviewStatus,
  ReviewFileView,
  ReviewHunkRow,
  ReviewHunkView,
  ReviewRow,
  ReviewView,
} from './types.js';

const MAX_REVIEW_FILES = 200;
const MAX_REVIEW_FILE_BYTES = 1024 * 1024;
const MAX_REVIEW_HUNKS = 10000;
const TEST_OUTPUT_CAP = 8192;

/**
 * P0-2 Path 1: every query against the review tables runs on a tenant-scoped
 * client (`q`) obtained from `withTenant(userId, ...)`. The authenticated
 * principal's id sets `app.current_user_id` (RLS key) and verifies owner
 * equality in the same transaction, so ownership can never be lost between
 * statement groups. No query here ever takes a user id from client input.
 */
type Q = PoolClient | DbQueryable;

export interface CreateReviewFileInput {
  fileId?: string;
  path: string;
  baseContent?: string;
  proposedContent: string;
}

export interface CreateReviewInput {
  taskId: string;
  runId?: string | null;
  title?: string;
  files: CreateReviewFileInput[];
  testCommand?: string | null;
}

export interface ReviewListEntry {
  review: ReviewView;
  totalHunks: number;
  acceptedHunks: number;
  rejectedHunks: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validStatusValue(status: string, allowed: string[]): boolean {
  return allowed.includes(status);
}

function ensureNonApplied(status: string): void {
  if (validStatusValue(status, [ReviewStatus.COMMITTED, ReviewStatus.CANCELLED, ReviewStatus.FAILED])) {
    throw AppError.conflict('review_not_decidable', 'review is not open for decisions');
  }
  if (validStatusValue(status, [
    ReviewStatus.APPLIED,
    ReviewStatus.TESTING,
    ReviewStatus.TEST_PASSED,
    ReviewStatus.TEST_FAILED,
  ])) {
    throw AppError.conflict('review_not_decidable', 'review is applied; undo it before re-deciding');
  }
}

async function requireReview(q: Q, userId: string, reviewId: string): Promise<ReviewRow> {
  const res = await q.query<ReviewRow>('SELECT * FROM cowork_reviews WHERE id = $1', [reviewId]);
  const row = res.rows[0] ?? null;
  if (!row || row.owner_id !== userId) throw AppError.notFound('Review');
  return row;
}

function parseContext(raw: string | null): { before: string[]; after: string[] } {
  if (!raw) return { before: [], after: [] };
  try {
    const parsed = JSON.parse(raw) as { before?: string[]; after?: string[] };
    return { before: parsed.before ?? [], after: parsed.after ?? [] };
  } catch {
    return { before: [], after: [] };
  }
}

function toHunkView(hunk: ReviewHunkRow, pathOf: Record<string, string>): ReviewHunkView {
  return {
    id: hunk.id,
    reviewId: hunk.review_id,
    fileId: hunk.file_id,
    path: pathOf[hunk.file_id] ?? hunk.file_id,
    hunkOrder: Number(hunk.hunk_order),
    status: (hunk.status as ReviewHunkView['status']) ?? HunkStatus.PENDING,
    oldStart: Number(hunk.old_start),
    oldLines: Number(hunk.old_lines),
    newStart: Number(hunk.new_start),
    newLines: Number(hunk.new_lines),
    originalSha: hunk.original_sha,
    proposedSha: hunk.proposed_sha,
    additions: Number(hunk.additions),
    deletions: Number(hunk.deletions),
    context: parseContext(hunk.context_lines),
    diffText: hunk.diff_text,
    decidedAt: hunk.decided_at,
  };
}

async function toReviewView(q: Q, row: ReviewRow, includeDeep: boolean): Promise<ReviewView> {
  const fileRes = await q.query<{ id: string; path: string; base_sha256: string; proposed_sha256: string; applied_sha256: string | null; status: string; file_order: number; applied_at: string | null }>(
    `SELECT id, path, base_sha256, proposed_sha256, applied_sha256, status, file_order, applied_at
       FROM cowork_review_files WHERE review_id = $1 ORDER BY file_order`,
    [row.id],
  );
  const files = fileRes.rows;
  const pathOf: Record<string, string> = {};
  for (const f of files) pathOf[f.id] = f.path;
  const hunks = includeDeep
    ? (
        await q.query<ReviewHunkRow>(
          'SELECT * FROM cowork_review_hunks WHERE review_id = $1 ORDER BY hunk_order',
          [row.id],
        )
      ).rows
    : [];
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    title: row.title,
    status: row.status,
    testStatus: row.test_status,
    commitStatus: row.commit_status,
    diffText: row.diff_text,
    filesChanged: Number(row.files_changed),
    additions: Number(row.additions),
    deletions: Number(row.deletions),
    testCommand: row.test_command,
    testExitCode: row.test_exit_code === null ? null : Number(row.test_exit_code),
    testDurationMs: row.test_duration_ms === null ? null : Number(row.test_duration_ms),
    testOutput: row.test_output,
    testCorrelationId: row.test_correlation_id,
    commitMessage: row.commit_message,
    commitHash: row.commit_hash,
    branch: row.branch,
    applyError: row.apply_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files: files.map((f): ReviewFileView => ({
      id: f.id,
      reviewId: row.id,
      path: f.path,
      baseSha256: f.base_sha256,
      proposedSha256: f.proposed_sha256,
      appliedSha256: f.applied_sha256,
      status: f.status,
      fileOrder: Number(f.file_order),
      appliedAt: f.applied_at,
    })),
    hunks: hunks.map((h) => toHunkView(h, pathOf)),
  };
}

// ---------------------------------------------------------------------------
// create / read
// ---------------------------------------------------------------------------

/** CREATE REVIEW: snapshot base + proposed, compute hunks, persist. */
export async function createReview(userId: string, projectId: string, input: CreateReviewInput): Promise<ReviewView> {
  await getProject(userId, projectId);

  // Tenant-scoped read of the task/run/file context. The project membership was
  // already verified by getProject; these reads inherit the same tenant key.
  await withTenant(userId, async (q) => {
    const taskRes = await q.query<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = $1', [input.taskId]);
    const task = taskRes.rows[0] ?? null;
    if (!task) throw AppError.notFound('Task');
    if (task.project_id !== projectId) throw AppError.forbidden('review_task_mismatch', 'task does not belong to this project');
    if (input.runId) {
      const runRes = await q.query<{ id: string }>('SELECT id FROM coworker_runs WHERE id = $1', [input.runId]);
      if (!runRes.rows[0]) throw AppError.notFound('Coworker run');
    }
  });

  if (!input.files || input.files.length === 0) throw AppError.badRequest('invalid_input', 'at least one file is required');
  if (input.files.length > MAX_REVIEW_FILES) {
    throw AppError.badRequest('review_too_many_files', `max ${MAX_REVIEW_FILES} files`);
  }

  // Resolve file rows (tenant-scoped) BEFORE the pure-CPU diff phase so no DB
  // connection is held while computing diffs for up to 200 files.
  const resolvedPaths = await withTenant(userId, async (q) => {
    const out: Array<{ path: string } | null> = [];
    for (const f of input.files) {
      if (f.fileId) {
        const fileRes = await q.query<{ path: string }>(
          'SELECT path FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
          [f.fileId, projectId],
        );
        const fileRow = fileRes.rows[0] ?? null;
        if (!fileRow) throw AppError.notFound('File');
        out.push({ path: fileRow.path });
      } else {
        out.push(null);
      }
    }
    return out;
  });
  const baseContents = new Map<string, string>();
  for (let i = 0; i < input.files.length; i += 1) {
    const f = input.files[i]!;
    if (f.fileId) {
      const current = await getFileContent(userId, projectId, f.fileId);
      baseContents.set(f.fileId, current.buffer.toString('utf8'));
    }
  }

  const reviewId = newId(PREFIX.COWORK_REVIEW);
  let totalHunks = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let filesChanged = 0;
  const diffParts: string[] = [];
  const fileInserts: Array<{
    fileId: string;
    path: string;
    baseContent: string;
    proposedContent: string;
    order: number;
  }> = [];
  const hunkInserts: Array<{
    fileId: string;
    reviewId: string;
    hunks: Array<ReturnType<typeof computeReviewDiff>['hunks'][number] & { order: number }>;
  }> = [];

  let order = 0;
  for (let i = 0; i < input.files.length; i += 1) {
    const f = input.files[i]!;
    const pathRow = resolvedPaths[i];
    let pathText = String(f.path ?? '');
    let baseContent: string;
    if (f.fileId) {
      pathText = pathText || (pathRow?.path ?? '');
      baseContent = baseContents.get(f.fileId) ?? '';
    } else {
      baseContent = f.baseContent ?? '';
      if (baseContent.length > MAX_REVIEW_FILE_BYTES) {
        throw AppError.badRequest('review_file_too_large', 'base content exceeds 1MB');
      }
    }
    if (!pathText || pathText.includes('\u0000') || /[\u0000-\u001f]/.test(pathText)) {
      throw AppError.badRequest('review_path_invalid', 'invalid path');
    }
    if (looksLikeSecretPath(pathText)) {
      throw AppError.forbidden('review_secret_denied', 'protected/secrets path cannot be reviewed');
    }
    const proposedContent = String(f.proposedContent ?? '');
    if (proposedContent.length > MAX_REVIEW_FILE_BYTES) {
      throw AppError.badRequest('review_file_too_large', 'proposed content exceeds 1MB');
    }
    const diff = computeReviewDiff(baseContent, proposedContent, pathText, order);
    if (diff.hunks.length === 0) continue;
    if (totalHunks + diff.hunks.length > MAX_REVIEW_HUNKS) {
      throw AppError.badRequest('review_too_many_hunks', `max ${MAX_REVIEW_HUNKS} hunks`);
    }
    const fileId = newId(PREFIX.COWORK_REVIEW_FILE);
    filesChanged += 1;
    totalHunks += diff.hunks.length;
    totalAdditions += diff.additions;
    totalDeletions += diff.deletions;
    fileInserts.push({ fileId, path: pathText, baseContent, proposedContent, order });
    hunkInserts.push({ fileId, reviewId, hunks: diff.hunks.map((h, idx) => ({ ...h, order: idx })) });
    diffParts.push(
      [`diff --git a/${pathText} b/${pathText}`,
       `--- a/${pathText}`,
       `+++ b/${pathText}`]
        .concat(diff.hunks.map((h) => h.diffText))
        .join('\n'),
    );
    order += 1;
  }

  if (filesChanged === 0) throw AppError.badRequest('review_no_changes', 'no changes to review');

  const body = [
    reviewId,
    input.taskId,
    input.runId ?? null,
    projectId,
    userId,
    input.title?.trim() ? input.title.trim().slice(0, 200) : REVIEW_DEFAULT_TITLE,
    ReviewStatus.READY_FOR_REVIEW,
    'NOT_RUN',
    'NOT_COMMITTED',
    diffParts.join('\n---\n'),
    filesChanged,
    totalAdditions,
    totalDeletions,
    input.testCommand?.trim() ? input.testCommand.trim().slice(0, 500) : null,
  ] as const;

  // One transaction for the whole review persist (subject, files, hunks): a
  // failure rolls back everything instead of the old autocommit DELETE dance.
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO cowork_reviews
         (id, task_id, run_id, project_id, owner_id, title, status, test_status, commit_status,
          diff_text, files_changed, additions, deletions, test_command)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [...body],
    );
    for (const file of fileInserts) {
      await q.query(
        `INSERT INTO cowork_review_files
           (id, review_id, path, base_sha256, base_content, proposed_sha256, proposed_content, status, file_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)`,
        [
          file.fileId, reviewId, file.path,
          sha256Of(file.baseContent), file.baseContent,
          sha256Of(file.proposedContent), file.proposedContent,
          file.order,
        ],
      );
      for (const hunks of hunkInserts) {
        if (hunks.fileId !== file.fileId) continue;
        for (const h of hunks.hunks) {
          await q.query(
            `INSERT INTO cowork_review_hunks
               (id, review_id, file_id, hunk_order, status, old_start, old_lines, new_start, new_lines,
                original_sha, proposed_sha, additions, deletions, context_lines, ins_lines, diff_text)
             VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              newId(PREFIX.COWORK_REVIEW_HUNK), reviewId, file.fileId, h.order,
              h.oldStart, h.oldLines, h.newStart, h.newLines,
              h.originalSha, h.proposedSha, h.additions, h.deletions,
              JSON.stringify(h.context), JSON.stringify(h.insLines), h.diffText,
            ],
          );
        }
      }
    }
  });

  const rt = getRuntime();
  rt.events.publish('aios.review.created', { reviewId, projectId, hunks: totalHunks });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
    detail: { taskId: input.taskId, projectId, filesChanged, hunks: totalHunks, additions: totalAdditions, deletions: totalDeletions },
  });

  return withTenant(userId, async (q) => toReviewView(q, await requireReview(q, userId, reviewId), true));
}

export async function getReview(userId: string, reviewId: string): Promise<ReviewView> {
  return withTenant(userId, async (q) => toReviewView(q, await requireReview(q, userId, reviewId), true));
}

export async function getReviewStatus(userId: string, reviewId: string): Promise<ReviewView> {
  return getReview(userId, reviewId);
}

export async function listReviews(userId: string, projectId: string): Promise<ReviewListEntry[]> {
  await getProject(userId, projectId);
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<ReviewRow & { total_hunks: number; accepted_hunks: number; rejected_hunks: number }>(
        `SELECT r.*,
                (SELECT COUNT(*) FROM cowork_review_hunks h WHERE h.review_id = r.id) AS total_hunks,
                (SELECT COUNT(*) FROM cowork_review_hunks h WHERE h.review_id = r.id AND h.status = 'ACCEPTED') AS accepted_hunks,
                (SELECT COUNT(*) FROM cowork_review_hunks h WHERE h.review_id = r.id AND h.status = 'REJECTED') AS rejected_hunks
           FROM cowork_reviews r
          WHERE r.project_id = $1
          ORDER BY r.created_at DESC LIMIT 100`,
        [projectId],
      )
    ).rows,
  );
  return rows.map((row) => ({
    review: {
      ...baseReviewView(row),
      files: [],
      hunks: [],
    },
    totalHunks: Number(row.total_hunks),
    acceptedHunks: Number(row.accepted_hunks),
    rejectedHunks: Number(row.rejected_hunks),
  }));
}

function baseReviewView(row: ReviewRow): ReviewView {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    title: row.title,
    status: row.status,
    testStatus: row.test_status,
    commitStatus: row.commit_status,
    diffText: row.diff_text,
    filesChanged: Number(row.files_changed),
    additions: Number(row.additions),
    deletions: Number(row.deletions),
    testCommand: row.test_command,
    testExitCode: row.test_exit_code === null ? null : Number(row.test_exit_code),
    testDurationMs: row.test_duration_ms === null ? null : Number(row.test_duration_ms),
    testOutput: row.test_output,
    testCorrelationId: row.test_correlation_id,
    commitMessage: row.commit_message,
    commitHash: row.commit_hash,
    branch: row.branch,
    applyError: row.apply_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files: [],
    hunks: [],
  };
}

// ---------------------------------------------------------------------------
// decide hunks
// ---------------------------------------------------------------------------

function recomputeReviewStatus(total: number, accepted: number, rejected: number): string {
  if (total === 0) return ReviewStatus.READY_FOR_REVIEW;
  if (accepted > 0 && rejected > 0) return ReviewStatus.PARTIALLY_REVIEWED;
  if (rejected === total) return ReviewStatus.PARTIALLY_REVIEWED;
  if (accepted === total) return ReviewStatus.READY_FOR_REVIEW;
  return ReviewStatus.PARTIALLY_REVIEWED;
}

async function hunkDecisionGuard(q: Q, reviewId: string, hunkId: string, userId: string): Promise<ReviewRow> {
  const review = await requireReview(q, userId, reviewId);
  ensureNonApplied(review.status);
  const hunkRes = await q.query<ReviewHunkRow>('SELECT * FROM cowork_review_hunks WHERE id = $1 AND review_id = $2', [hunkId, reviewId]);
  const hunk = hunkRes.rows[0] ?? null;
  if (!hunk) throw AppError.notFound('Hunk');
  if (hunk.status === HunkStatus.INVALIDATED) {
    throw AppError.conflict('review_hunk_stale', 'hunk is stale (workspace changed); re-review is required');
  }
  if (hunk.status === HunkStatus.APPLIED || hunk.status === HunkStatus.FAILED) {
    throw AppError.conflict('review_hunk_locked', 'hunk is locked after apply');
  }
  return review;
}

async function persistReviewStatus(q: Q, reviewId: string, status: string): Promise<void> {
  await q.query('UPDATE cowork_reviews SET status = $2, updated_at = now() WHERE id = $1', [reviewId, status]);
}

async function decideAllGuard(q: Q, reviewId: string, userId: string): Promise<ReviewRow> {
  const review = await requireReview(q, userId, reviewId);
  ensureNonApplied(review.status);
  const staleRes = await q.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM cowork_review_hunks WHERE review_id = $1 AND status = 'INVALIDATED'`,
    [reviewId],
  );
  const stale = staleRes.rows[0] ?? null;
  if (Number(stale?.n ?? 0) > 0) {
    throw AppError.conflict('review_stale_conflict', 'review contains stale hunks; re-review is required');
  }
  return review;
}

/** ACCEPT / REJECT a single hunk (toggleable until applied). */
export async function decideHunk(
  userId: string,
  reviewId: string,
  hunkId: string,
  decision: 'ACCEPTED' | 'REJECTED',
): Promise<ReviewView> {
  const { status, view } = await withTenant(userId, async (q) => {
    await hunkDecisionGuard(q, reviewId, hunkId, userId);
    await q.query(
      'UPDATE cowork_review_hunks SET status = $3, decided_at = now() WHERE id = $1 AND review_id = $2',
      [hunkId, reviewId, decision],
    );
    const counts = await hunkCounts(q, reviewId);
    const nextStatus = recomputeReviewStatus(counts.total, counts.accepted, counts.rejected);
    await persistReviewStatus(q, reviewId, nextStatus);
    const review = await requireReview(q, userId, reviewId);
    return { status: nextStatus, view: await toReviewView(q, review, true) };
  });
  const rt = getRuntime();
  rt.events.publish(decision === 'ACCEPTED' ? 'aios.review.hunk.accepted' : 'aios.review.hunk.rejected', { reviewId, hunkId });
  await recordAudit({
    action: decision === 'ACCEPTED' ? AuditAction.COWORK_REVIEW_HUNK_ACCEPTED : AuditAction.COWORK_REVIEW_HUNK_REJECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
    detail: { hunkId, status },
  });
  return view;
}

async function hunkCounts(q: Q, reviewId: string): Promise<{ total: number; accepted: number; rejected: number }> {
  const rows = (
    await q.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM cowork_review_hunks WHERE review_id = $1 GROUP BY status`,
      [reviewId],
    )
  ).rows;
  let total = 0;
  let accepted = 0;
  let rejected = 0;
  for (const r of rows) {
    total += Number(r.n);
    if (r.status === HunkStatus.ACCEPTED) accepted = Number(r.n);
    if (r.status === HunkStatus.REJECTED) rejected = Number(r.n);
  }
  return { total, accepted, rejected };
}

/** ACCEPT ALL: set every decidable hunk to ACCEPTED → READY_FOR_REVIEW. */
export async function acceptAllHunks(userId: string, reviewId: string): Promise<ReviewView> {
  const view = await withTenant(userId, async (q) => {
    await decideAllGuard(q, reviewId, userId);
    await q.query(
      `UPDATE cowork_review_hunks SET status = 'ACCEPTED', decided_at = now()
        WHERE review_id = $1 AND status IN ('PENDING','ACCEPTED','REJECTED')`,
      [reviewId],
    );
    await persistReviewStatus(q, reviewId, ReviewStatus.READY_FOR_REVIEW);
    return toReviewView(q, await requireReview(q, userId, reviewId), true);
  });
  const rt = getRuntime();
  rt.events.publish('aios.review.accept_all', { reviewId });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_ACCEPTS_ALL,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
  });
  return view;
}

/** REJECT ALL: reject every hunk → review CANCELLED (nothing to apply). */
export async function rejectAllHunks(userId: string, reviewId: string): Promise<ReviewView> {
  const view = await withTenant(userId, async (q) => {
    await decideAllGuard(q, reviewId, userId);
    await q.query(
      `UPDATE cowork_review_hunks SET status = 'REJECTED', decided_at = now()
        WHERE review_id = $1 AND status IN ('PENDING','ACCEPTED','REJECTED')`,
      [reviewId],
    );
    await persistReviewStatus(q, reviewId, ReviewStatus.CANCELLED);
    return toReviewView(q, await requireReview(q, userId, reviewId), true);
  });
  const rt = getRuntime();
  rt.events.publish('aios.review.reject_all', { reviewId });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_REJECTS_ALL,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
  });
  return view;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function fileRowsFor(q: Q, reviewId: string): Promise<
  Array<{
    id: string;
    path: string;
    base_sha256: string;
    base_content: string;
    proposed_sha256: string;
    proposed_content: string;
    file_order: number;
  }>
> {
  return (
    await q.query(
      'SELECT id, path, base_sha256, base_content, proposed_sha256, proposed_content, file_order FROM cowork_review_files WHERE review_id = $1 ORDER BY file_order',
      [reviewId],
    )
  ).rows;
}

async function hunksForFile(q: Q, reviewId: string, fileId: string): Promise<ReviewHunkRow[]> {
  return (
    await q.query(
      'SELECT * FROM cowork_review_hunks WHERE review_id = $1 AND file_id = $2 ORDER BY hunk_order',
      [reviewId, fileId],
    )
  ).rows;
}

function parseInsLines(hunk: Pick<ReviewHunkRow, 'ins_lines'>): string[] {
  try {
    const parsed = JSON.parse(hunk.ins_lines) as string[];
    return Array.isArray(parsed) ? parsed.map((l) => String(l)) : [];
  } catch {
    return [];
  }
}

async function currentContentHash(q: Q, projectId: string, pathText: string): Promise<string | null> {
  const res = await q.query<{ sha256: string }>(
    'SELECT sha256 FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL',
    [projectId, pathText],
  );
  return res.rows[0]?.sha256 ?? null;
}

/** APPLY REVIEWED HUNKS: verify staleness, apply through canonical file service. */
export async function applyReview(userId: string, reviewId: string): Promise<ReviewView> {
  // Read phase: ownership + full snapshot in one tenant-scoped read tx.
  const { review, files, accepted } = await withTenant(userId, async (q) => {
    const review = await requireReview(q, userId, reviewId);
    if (!validStatusValue(review.status, [
      ReviewStatus.READY_FOR_REVIEW,
      ReviewStatus.PARTIALLY_REVIEWED,
      ReviewStatus.UNDONE,
    ])) {
      throw AppError.conflict('review_not_appliable', 'review is not in an appliable state');
    }
    const files = await fileRowsFor(q, reviewId);
    const allHunks = (
      await q.query<ReviewHunkRow>('SELECT * FROM cowork_review_hunks WHERE review_id = $1', [reviewId])
    ).rows;
    if (allHunks.some((h) => h.status === HunkStatus.INVALIDATED)) {
      throw AppError.conflict('review_stale_conflict', 'review contains stale hunks; re-review is required');
    }
    if (allHunks.some((h) => h.status === HunkStatus.FAILED)) {
      throw AppError.conflict('review_apply_conflict', 'review contains failed hunks');
    }
    const accepted = allHunks.filter((h) => h.status === HunkStatus.ACCEPTED);
    if (accepted.length === 0) {
      throw AppError.conflict('review_nothing_to_apply', 'no accepted hunks to apply');
    }
    return { review, files, accepted };
  });

  // Stop-rule + cap checks (canonical enforcement; fail closed on deny).
  const rt = getRuntime();
  const caps = reviewCapabilities(review.project_id);
  const denied: AppError[] = [];
  for (const f of files) {
    const fileAccepted = accepted.filter((h) => h.file_id === f.id);
    if (fileAccepted.length === 0) continue;
    if (looksLikeSecretPath(f.path)) {
      denied.push(AppError.forbidden('review_secret_denied', `protected path: ${f.path}`));
      continue;
    }
    const outcome = await rt.stopRules.evaluate({
      operation: 'edit',
      target: f.path,
      ev: { userId, workspaceId: review.project_id, coworkId: review.run_id, processId: review.id, capabilities: caps },
    });
    if (!outcome.allowed) {
      denied.push(AppError.forbidden('aios_stoprule_denied', outcome.reason));
    }
  }
  if (denied.length > 0) {
    const msg = denied.map((d) => (d as AppError).message).join('; ');
    throw AppError.forbidden('aios_stoprule_denied', msg);
  }

  let failures = 0;
  let firstError: string | null = null;
  let staleConflict = false;
  const slot = await rt.governor.acquire();
  try {
    for (const f of files) {
      const fileAccepted = accepted.filter((h) => h.file_id === f.id);
      if (fileAccepted.length === 0) continue;
      try {
        const { fileHunks, currentHash } = await withTenant(userId, async (q) => ({
          fileHunks: await hunksForFile(q, reviewId, f.id),
          currentHash: await currentContentHash(q, review.project_id, f.path),
        }));
        const isNewFile = f.base_content === '';
        if (isNewFile) {
          // Reviewed as a brand-new file: no prior file is expected (missing is
          // fine); only a file that appeared AND differs from the reviewed base
          // is stale.
          if (currentHash !== null && currentHash !== f.base_sha256) {
            await withTenant(userId, async (q) => invalidateFileHunks(q, reviewId, f.id));
            staleConflict = true;
            throw AppError.conflict('review_stale_conflict', `workspace file '${f.path}' changed since the review; re-review required`);
          }
        } else if (currentHash === null) {
          await withTenant(userId, async (q) => invalidateFileHunks(q, reviewId, f.id));
          staleConflict = true;
          throw AppError.conflict('review_stale_missing', `workspace file '${f.path}' no longer exists; re-review required`);
        } else if (currentHash !== f.base_sha256) {
          await withTenant(userId, async (q) => invalidateFileHunks(q, reviewId, f.id));
          staleConflict = true;
          throw AppError.conflict('review_stale_conflict', `workspace file '${f.path}' changed since the review; re-review required`);
        }
        const allFileAccepted = fileAccepted.length === fileHunks.length;
        // Full acceptance applies the raw proposed content (byte-exact,
        // trailing-newline preserved); partial acceptance applies only the
        // accepted hunks deterministically. Both are hash-verified.
        const applied = allFileAccepted
          ? { content: f.proposed_content, sha256: f.proposed_sha256 }
          : applyAcceptedHunks(
              f.base_content,
              fileAccepted.map((h) => ({
                oldStart: Number(h.old_start),
                oldLines: Number(h.old_lines),
                insLines: parseInsLines(h),
              })),
            );
        // Internal invariant: a fully accepted file MUST equal the proposed
        // content (fail closed on hunk/diff drift).
        if (allFileAccepted && applied.sha256 !== f.proposed_sha256) {
          throw AppError.conflict('review_apply_invariant', `applied content of '${f.path}' does not match proposed content`);
        }
        await uploadFile(userId, review.project_id, f.path, Buffer.from(applied.content, 'utf8'));
        await withTenant(userId, async (q) => {
          await q.query(
            `UPDATE cowork_review_files SET applied_sha256 = $3, applied_content = $4, status = 'APPLIED', applied_at = now()
              WHERE id = $1 AND review_id = $2`,
            [f.id, reviewId, applied.sha256, applied.content],
          );
          await q.query(
            `UPDATE cowork_review_hunks SET status = 'APPLIED' WHERE review_id = $1 AND file_id = $2 AND status = 'ACCEPTED'`,
            [reviewId, f.id],
          );
        });
      } catch (err) {
        failures += 1;
        firstError ??= err instanceof Error ? err.message : String(err);
        if (staleConflict) {
          // hunks already invalidated; do not clobber with FAILED
        } else {
          await withTenant(userId, async (q) => markFileFailed(q, reviewId, f.id));
        }
      }
    }
  } finally {
    slot.release();
  }

  if (failures > 0) {
    await withTenant(userId, async (q) => {
      await persistReviewStatus(q, reviewId, ReviewStatus.FAILED);
      await q.query('UPDATE cowork_reviews SET apply_error = $2, updated_at = now() WHERE id = $1', [
        reviewId,
        stextOf(firstError),
      ]);
    });
    const cleanError = firstError?.split(':').pop()?.trim() ?? firstError;
    rt.events.publish('aios.review.apply_failed', { reviewId, error: cleanError, stale: staleConflict });
    await recordAudit({
      action: staleConflict ? AuditAction.COWORK_REVIEW_STALE : AuditAction.COWORK_REVIEW_APPLY_FAILED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'cowork_review',
      resourceId: reviewId,
      detail: { error: cleanError },
    });
    return getReview(userId, reviewId);
  }

  await withTenant(userId, async (q) => persistReviewStatus(q, reviewId, ReviewStatus.APPLIED));
  rt.events.publish('aios.review.applied', { reviewId });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
    detail: { accepted: accepted.length, files: files.length },
  });
  return getReview(userId, reviewId);
}

function stextOf(value: string | null): string | null {
  return value ? value.slice(0, 2000) : null;
}

async function invalidateFileHunks(q: Q, reviewId: string, fileId: string): Promise<void> {
  await q.query(
    'UPDATE cowork_review_hunks SET status = $3 WHERE review_id = $1 AND file_id = $2',
    [reviewId, fileId, HunkStatus.INVALIDATED],
  );
  const rt = getRuntime();
  rt.events.publish('aios.review.stale', { reviewId, fileId });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_STALE,
    scope: 'USER',
    tenantId: null,
    resourceType: 'cowork_review',
    resourceId: reviewId,
    detail: { fileId },
  });
}

async function markFileFailed(q: Q, reviewId: string, fileId: string): Promise<void> {
  await q.query(
    'UPDATE cowork_review_hunks SET status = $3 WHERE review_id = $1 AND file_id = $2',
    [reviewId, fileId, HunkStatus.FAILED],
  );
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

export interface TestRunResult {
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
  correlationId: string;
}

/** RUN REVIEW TESTS through the canonical policy sandbox on a materialized worktree. */
export async function runReviewTests(userId: string, reviewId: string, command?: string): Promise<ReviewView> {
  const review = await withTenant(userId, async (q) => {
    const r = await requireReview(q, userId, reviewId);
    if (!validStatusValue(r.status, [ReviewStatus.APPLIED, ReviewStatus.TEST_PASSED, ReviewStatus.TEST_FAILED])) {
      throw AppError.conflict('review_not_testable', 'review must be applied before testing');
    }
    return r;
  });
  const testCommand = (command ?? '').trim() || (review.test_command ?? '').trim();
  if (!testCommand) throw AppError.badRequest('review_test_command_required', 'a test command is required');
  const tokens = testCommand.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 32) throw AppError.badRequest('review_test_command_invalid', 'invalid test command');

  const rt = getRuntime();
  const correlationId = randomUUID();
  await withTenant(userId, async (q) => {
    await q.query(
      'UPDATE cowork_reviews SET status = $2, test_status = $3, test_command = $4, test_correlation_id = $5, test_exit_code = NULL, test_duration_ms = NULL, test_output = NULL, updated_at = now() WHERE id = $1',
      [reviewId, ReviewStatus.TESTING, 'RUNNING', testCommand.slice(0, 500), correlationId],
    );
  });
  rt.events.publish('aios.review.test_started', { reviewId, correlationId, command: testCommand });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_TEST_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
    detail: { command: testCommand },
  });

  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<{ path: string; applied_content: string | null; base_content: string }>(
        'SELECT path, applied_content, base_content FROM cowork_review_files WHERE review_id = $1',
        [reviewId],
      )
    ).rows,
  );
  const worktree = materializeWorktree(reviewId, rows.map((r) => ({ path: r.path, content: r.applied_content ?? r.base_content })));

  let result: TestRunResult;
  try {
    const outcome = await rt.supervisor.supervised<unknown>({
      name: `review:${reviewId}:tests`,
      capabilities: reviewCapabilities(review.project_id),
      budget: {
        maxRuntimeMs: env.AIOS_SANDBOX_TIMEOUT_MS + 5000,
        maxConcurrency: 1,
        maxCostUsd: 0,
      },
      maxRestarts: 1,
      restartPolicy: 'none',
      run: async () =>
        rt.executor.execute({
          args: tokens,
          allowedCommands: ['node', 'npm', 'npx'],
          cwd: worktree,
          timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
          authorized: true,
        }),
    });
    const res = outcome.ok && outcome.result !== null ? (outcome.result as { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }) : null;
    if (!res) {
      await withTenant(userId, async (q) => persistTestResult(q, reviewId, correlationId, false, null, 0, `test runner failed: ${outcome.errorCode ?? 'unknown'}`, false));
      result = { exitCode: null, durationMs: 0, output: `test runner failed: ${outcome.errorCode ?? 'unknown'}`, timedOut: false, correlationId };
    } else {
      const output = `${res.stdout ?? ''}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''}`.slice(0, TEST_OUTPUT_CAP);
      const passed = res.exitCode === 0 && !res.timedOut;
      await withTenant(userId, async (q) => persistTestResult(q, reviewId, correlationId, passed, res.exitCode ?? null, res.durationMs ?? 0, output, Boolean(res.timedOut)));
      result = { exitCode: res.exitCode, durationMs: res.durationMs, output, timedOut: Boolean(res.timedOut), correlationId };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(userId, async (q) => persistTestResult(q, reviewId, correlationId, false, null, 0, message.slice(0, TEST_OUTPUT_CAP), false));
    result = { exitCode: null, durationMs: 0, output: message.slice(0, TEST_OUTPUT_CAP), timedOut: false, correlationId };
  }

  if (result.exitCode !== null && result.exitCode === 0 && !result.timedOut) {
    rt.events.publish('aios.review.test_passed', { reviewId, correlationId });
    await recordAudit({
      action: AuditAction.COWORK_REVIEW_TEST_PASSED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'cowork_review',
      resourceId: reviewId,
      detail: { correlationId, durationMs: result.durationMs },
    });
  } else {
    rt.events.publish('aios.review.test_failed', { reviewId, correlationId, timedOut: result.timedOut });
    await recordAudit({
      action: AuditAction.COWORK_REVIEW_TEST_FAILED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'cowork_review',
      resourceId: reviewId,
      detail: { correlationId, exitCode: result.exitCode, timedOut: result.timedOut },
    });
  }
  return getReview(userId, reviewId);
}

async function persistTestResult(
  q: Q,
  reviewId: string,
  correlationId: string,
  passed: boolean,
  exitCode: number | null,
  durationMs: number,
  output: string,
  timedOut: boolean,
): Promise<void> {
  const status = passed ? ReviewStatus.TEST_PASSED : ReviewStatus.TEST_FAILED;
  const testStatus = passed ? 'PASSED' : timedOut ? 'FAILED' : 'FAILED';
  await q.query(
    `UPDATE cowork_reviews
        SET status = $2, test_status = $3, test_exit_code = $4, test_duration_ms = $5,
            test_output = $6, updated_at = now()
      WHERE id = $1`,
    [reviewId, status, testStatus, exitCode, durationMs, output.slice(0, TEST_OUTPUT_CAP)],
  );
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

/** UNDO: verify applied state still matches, then revert exactly to base. */
export async function undoReview(userId: string, reviewId: string): Promise<ReviewView> {
  const { review, files } = await withTenant(userId, async (q) => {
    const r = await requireReview(q, userId, reviewId);
    if (!validStatusValue(r.status, [
      ReviewStatus.APPLIED,
      ReviewStatus.TEST_PASSED,
      ReviewStatus.TEST_FAILED,
    ])) {
      throw AppError.conflict('review_not_undoable', 'review is not in an undoable state');
    }
    if (r.status === ReviewStatus.UNDONE) {
      throw AppError.conflict('review_already_undone', 'review is already undone');
    }
    const files = await fileRowsFor(q, reviewId);
    const acceptedApplied = (
      await q.query<ReviewHunkRow>(
        `SELECT * FROM cowork_review_hunks WHERE review_id = $1 AND status IN ('APPLIED','FAILED')`,
        [reviewId],
      )
    ).rows;
    if (acceptedApplied.some((h) => h.status === HunkStatus.FAILED)) {
      throw AppError.conflict('review_undo_conflict', 'review contains failed hunks; cannot undo cleanly');
    }
    return { review: r, files };
  });

  await recordAudit({
    action: AuditAction.COWORK_REVIEW_UNDO_REQUESTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
  });

  // Per-file divergence check + revert + status reset in ONE tenant-scoped
  // transaction, so the divergence verdict and the mutation cannot interleave
  // with another concurrent writer.
  await withTenant(userId, async (q) => {
    const fileStates = (
      await q.query<{ id: string; path: string; applied_sha256: string | null }>(
        'SELECT id, path, applied_sha256 FROM cowork_review_files WHERE review_id = $1',
        [reviewId],
      )
    ).rows;
    for (const f of fileStates) {
      if (!f.applied_sha256) continue;
      const currentHash = await currentContentHash(q, review.project_id, f.path);
      if (currentHash !== f.applied_sha256) {
        throw AppError.conflict('review_diverged', `cannot undo '${f.path}': workspace diverged since apply; manual restore needed`);
      }
    }

    for (const f of files) {
      const currentHash = await currentContentHash(q, review.project_id, f.path);
      if (currentHash === null) continue;
      if (currentHash !== f.base_sha256) {
        await uploadFile(userId, review.project_id, f.path, Buffer.from(f.base_content, 'utf8'));
      }
    }

    await q.query(
      `UPDATE cowork_review_hunks SET status = 'PENDING', decided_at = NULL WHERE review_id = $1`,
      [reviewId],
    );
    await q.query(
      `UPDATE cowork_review_files SET applied_sha256 = NULL, applied_content = NULL, status = 'PENDING', applied_at = NULL WHERE review_id = $1`,
      [reviewId],
    );
    await q.query(
      `UPDATE cowork_reviews SET status = $2, test_status = 'NOT_RUN', commit_status = 'NOT_COMMITTED',
         test_exit_code = NULL, test_duration_ms = NULL, test_output = NULL, test_correlation_id = NULL,
         commit_message = NULL, commit_hash = NULL, branch = NULL, updated_at = now()
       WHERE id = $1`,
      [reviewId, ReviewStatus.UNDONE],
    );
  });

  const rt = getRuntime();
  rt.events.publish('aios.review.undone', { reviewId });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_UNDO_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
  });
  return getReview(userId, reviewId);
}

// ---------------------------------------------------------------------------
// commit / cancel
// ---------------------------------------------------------------------------

/** COMMIT REVIEW: explicit user action only; lands in a private server worktree. */
export async function commitReview(userId: string, reviewId: string, message: string): Promise<ReviewView> {
  const review = await withTenant(userId, async (q) => {
    const r = await requireReview(q, userId, reviewId);
    if (!validStatusValue(r.status, [ReviewStatus.APPLIED, ReviewStatus.TEST_PASSED, ReviewStatus.TEST_FAILED])) {
      throw AppError.conflict('review_not_committable', 'review must be applied before commit');
    }
    return r;
  });
  const msg = String(message ?? '').trim();
  if (!msg) throw AppError.badRequest('review_commit_message_required', 'a commit message is required');
  if (msg.length > 2000) throw AppError.badRequest('review_commit_message_too_long', 'commit message is too long');

  const rt = getRuntime();
  const outcome = await rt.stopRules.evaluate({
    operation: 'git.commit',
    ev: { userId, workspaceId: review.project_id, coworkId: review.run_id, processId: review.id, capabilities: reviewCapabilities(review.project_id) },
  });
  if (!outcome.allowed) {
    throw AppError.forbidden('aios_stoprule_denied', outcome.reason);
  }
  if (!rt.git.enabled()) {
    throw AppError.conflict('aios_git_denied', 'git capability is not enabled for this deployment');
  }

  // Divergence guard + applied snapshot in one tenant-scoped read tx. The git
  // work happens AFTER the tx so no DB connection is held during git spawns.
  const { appliedFiles } = await withTenant(userId, async (q) => {
    const rows = (
      await q.query<{ path: string; applied_sha256: string | null; base_content: string }>(
        'SELECT path, applied_sha256, base_content FROM cowork_review_files WHERE review_id = $1',
        [reviewId],
      )
    ).rows;
    for (const r of rows) {
      if (!r.applied_sha256) continue;
      const currentHash = await currentContentHash(q, review.project_id, r.path);
      if (currentHash !== r.applied_sha256) {
        throw AppError.conflict('review_diverged', `cannot commit '${r.path}': workspace diverged since apply`);
      }
    }
    const appliedFiles = (
      await q.query<{ path: string; applied_content: string | null; base_content: string }>(
        'SELECT path, applied_content, base_content FROM cowork_review_files WHERE review_id = $1',
        [reviewId],
      )
    ).rows;
    return { appliedFiles };
  });
  const worktree = materializeWorktree(reviewId, appliedFiles.map((f) => ({ path: f.path, content: f.applied_content ?? f.base_content })));

  try {
    const engine = rt.git.engine(worktree);
    const initRes = await rt.git.init(worktree);
    if (initRes.exitCode !== 0) throw AppError.badRequest('aios_git_failed', `git init failed: ${initRes.stderr.trim() || 'unknown'}`);
    if (!existsSync(path.join(worktree, '.git'))) {
      throw AppError.badRequest('aios_git_failed', 'git init did not produce a repository');
    }
    const addRes = await rt.git.addAll(worktree);
    if (addRes.exitCode !== 0) throw AppError.badRequest('aios_git_failed', `git add failed: ${addRes.stderr.trim() || 'unknown'}`);
    const output = await engine.commit(msg);
    const hashMatch = /\[[^\]]*?([0-9a-f]{7,40})/.exec(output);
    const commitHash = hashMatch ? hashMatch[1]! : output.split('\n').pop()?.slice(0, 40) ?? null;
    await withTenant(userId, async (q) => {
      await q.query(
        `UPDATE cowork_reviews SET status = $2, commit_status = 'COMMITTED', commit_message = $3, commit_hash = $4, updated_at = now() WHERE id = $1`,
        [reviewId, ReviewStatus.COMMITTED, msg, commitHash],
      );
    });
    rt.events.publish('aios.review.committed', { reviewId, commitHash });
    await recordAudit({
      action: AuditAction.COWORK_REVIEW_COMMITTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'cowork_review',
      resourceId: reviewId,
      detail: { commitHash },
    });
  } catch (err) {
    await withTenant(userId, async (q) => {
      await q.query('UPDATE cowork_reviews SET commit_status = $2, updated_at = now() WHERE id = $1', [reviewId, 'FAILED']);
    });
    throw err;
  }
  return getReview(userId, reviewId);
}

/** CANCEL an open review (not applied). */
export async function cancelReview(userId: string, reviewId: string): Promise<ReviewView> {
  const view = await withTenant(userId, async (q) => {
    const review = await requireReview(q, userId, reviewId);
    ensureNonApplied(review.status);
    await persistReviewStatus(q, reviewId, ReviewStatus.CANCELLED);
    const updated = await requireReview(q, userId, reviewId);
    return toReviewView(q, updated, true);
  });
  const rt = getRuntime();
  rt.events.publish('aios.review.cancelled', { reviewId });
  await recordAudit({
    action: AuditAction.COWORK_REVIEW_CANCELLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cowork_review',
    resourceId: reviewId,
  });
  return view;
}

export { splitCanonical };