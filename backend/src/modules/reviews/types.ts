/**
 * CodeConClave — B1 cowork safety review loop: shared types & statuses.
 *
 * Server-authoritative lifecycle. Every transition is decided+persisted on the
 * server; the frontend never invents states. Stale hunks FAIL CLOSED to
 * INVALIDATED with a deterministic conflict response.
 */

export const ReviewStatus = {
  DRAFT: 'DRAFT',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  PARTIALLY_REVIEWED: 'PARTIALLY_REVIEWED',
  APPLIED: 'APPLIED',
  TESTING: 'TESTING',
  TEST_PASSED: 'TEST_PASSED',
  TEST_FAILED: 'TEST_FAILED',
  COMMITTED: 'COMMITTED',
  UNDONE: 'UNDONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

export const HunkStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  INVALIDATED: 'INVALIDATED',
} as const;
export type HunkStatus = (typeof HunkStatus)[keyof typeof HunkStatus];

export const ReviewTestStatus = {
  NOT_RUN: 'NOT_RUN',
  RUNNING: 'RUNNING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  NOT_RUNNABLE: 'NOT_RUNNABLE',
} as const;
export type ReviewTestStatus = (typeof ReviewTestStatus)[keyof typeof ReviewTestStatus];

export const ReviewCommitStatus = {
  NOT_COMMITTED: 'NOT_COMMITTED',
  COMMITTED: 'COMMITTED',
  FAILED: 'FAILED',
} as const;
export type ReviewCommitStatus = (typeof ReviewCommitStatus)[keyof typeof ReviewCommitStatus];

export type HunkDecision = 'ACCEPTED' | 'REJECTED';

/** Persisted shape of a review file row (cowork_review_files). */
export interface ReviewFileRow {
  id: string;
  review_id: string;
  path: string;
  base_sha256: string;
  base_content: string;
  proposed_sha256: string;
  proposed_content: string;
  applied_sha256: string | null;
  applied_content: string | null;
  status: string;
  file_order: number;
  applied_at: string | null;
}

/** Persisted shape of a review hunk row (cowork_review_hunks). */
export interface ReviewHunkRow {
  id: string;
  review_id: string;
  file_id: string;
  hunk_order: number;
  status: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  original_sha: string;
  proposed_sha: string;
  additions: number;
  deletions: number;
  context_lines: string;
  ins_lines: string;
  diff_text: string;
  decided_at: string | null;
}

/** Persisted shape of a review row (cowork_reviews). */
export interface ReviewRow {
  id: string;
  task_id: string;
  run_id: string | null;
  project_id: string;
  owner_id: string;
  title: string;
  status: string;
  test_status: string;
  commit_status: string;
  diff_text: string;
  files_changed: number;
  additions: number;
  deletions: number;
  test_command: string | null;
  test_exit_code: number | null;
  test_duration_ms: number | null;
  test_output: string | null;
  test_correlation_id: string | null;
  commit_message: string | null;
  commit_hash: string | null;
  branch: string | null;
  apply_error: string | null;
  created_at: string;
  updated_at: string;
}

/** API view of a single hunk (hunk_id is its stable identity within the review). */
export interface ReviewHunkView {
  id: string;
  reviewId: string;
  fileId: string;
  path: string;
  hunkOrder: number;
  status: HunkStatus;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  originalSha: string;
  proposedSha: string;
  additions: number;
  deletions: number;
  context: { before: string[]; after: string[] };
  diffText: string;
  decidedAt: string | null;
}

export interface ReviewFileView {
  id: string;
  reviewId: string;
  path: string;
  baseSha256: string;
  proposedSha256: string;
  appliedSha256: string | null;
  status: string;
  fileOrder: number;
  appliedAt: string | null;
}

/** API view of a review. Statuses are server-authoritative strings. */
export interface ReviewView {
  id: string;
  taskId: string;
  runId: string | null;
  projectId: string;
  ownerId: string;
  title: string;
  status: string;
  testStatus: string;
  commitStatus: string;
  diffText: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  testCommand: string | null;
  testExitCode: number | null;
  testDurationMs: number | null;
  testOutput: string | null;
  testCorrelationId: string | null;
  commitMessage: string | null;
  commitHash: string | null;
  branch: string | null;
  applyError: string | null;
  createdAt: string;
  updatedAt: string;
  files: ReviewFileView[];
  hunks: ReviewHunkView[];
}

export const REVIEW_DEFAULT_TITLE = 'Cowork review';
export const REVIEW_PRESET_COUNT = 40;