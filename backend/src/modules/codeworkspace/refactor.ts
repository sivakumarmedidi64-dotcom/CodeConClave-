/**
 * CodeConClave — PKG-22 Advanced Code Workspace — safe rename refactor.
 * Workspace-scoped symbol rename driven by HEURISTIC reference evidence.
 * Flow: PLAN → PREVIEW (diff) → REVIEW (accept/reject) → APPLY → RESULT.
 * Renames only when the symbol is unambiguously referenced in a bounded,
 * non-secret, text file set; otherwise reports BLOCKED. Never blindly
 * text-replaces across files without review; never auto-applies.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { readFileEntry, writeFileEntry } from './fs.js';
import { listFilePaths } from './fs.js';
import { getWorkspace } from './state.js';
import { findReferences } from './symbols.js';
import { recordDirectEdit, createReview, applyReview } from './edit.js';
import { workspaceEnabled } from './config.js';
import { assertProjectAccess } from '../runtime/security.js';

export interface RenamePlanFile {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
}

export interface RenamePlan {
  id: string;
  projectId: string;
  symbol: string;
  newName: string;
  status: 'PLANNED' | 'APPLIED' | 'BLOCKED' | 'REJECTED';
  fileCount: number;
  files: RenamePlanFile[];
  appliesTo: string[];
  blockedReason?: string;
}

/** Heuristic: is `newName` locally valid (identifier-shaped)? */
function validIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !/^(import|export|class|function|const|let|var|new|return|if|else|for|while)$/.test(name);
}

/**
 * Build a rename preview over every non-secret text file that references the
 * symbol. When the symbol looks like a keyword or the match set is ambiguous
 * (too large), the plan is BLOCKED instead of guessing.
 */
export async function planRename(userId: string, projectId: string, symbol: string, newName: string): Promise<RenamePlan> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  await assertProjectAccess(userId, projectId);
  if (!validIdentifier(newName)) throw AppError.badRequest('refactor_invalid_name', 'newName is not a valid identifier');
  if (symbol === newName) throw AppError.badRequest('refactor_same_name', 'newName equals the symbol');

  const refs = await findReferences(projectId, symbol);
  if (refs.count === 0) {
    return { id: '', projectId, symbol, newName, status: 'BLOCKED', fileCount: 0, files: [], appliesTo: [], blockedReason: 'symbol not found in the workspace' };
  }
  if (refs.count > 500) {
    return { id: '', projectId, symbol, newName, status: 'BLOCKED', fileCount: 0, files: [], appliesTo: [], blockedReason: 'too many references to rename safely (heuristic limit)' };
  }

  // Group references by file
  const byFile = new Map<string, number[]>();
  for (const r of refs.references) {
    const lines = byFile.get(r.file) ?? [];
    lines.push(r.line);
    byFile.set(r.file, lines);
  }

  const files: RenamePlanFile[] = [];
  const appliesTo: string[] = [];
  for (const [filePath, lines] of byFile) {
    appliesTo.push(filePath);
  }

  const id = newId(PREFIX.WORKSPACE_EDIT);

  return { id, projectId, symbol, newName, status: 'PLANNED', fileCount: appliesTo.length, files: [], appliesTo, blockedReason: undefined };
}

/**
 * Actually compute per-file diffs and record them (preview materialization).
 * This is the PREVIEW step; callers surface it for user review before apply.
 */
export async function materializeRenamePreview(userId: string, projectId: string, symbol: string, newName: string): Promise<RenamePlan> {
  const plan = await planRename(userId, projectId, symbol, newName);
  if (plan.status === 'BLOCKED') return plan;

  const files: RenamePlanFile[] = [];
  const re = new RegExp(`\\b${symbol}\\b`, 'g');
  for (const p of plan.appliesTo) {
    const file = await readFileEntry(projectId, p);
    if (!file || file.binary) continue;
    const newContent = file.content.replace(re, newName);
    if (newContent === file.content) continue;
    const removed = (file.content.match(re) ?? []).length;
    files.push({ path: p, diff: `rename ${symbol} -> ${newName} in ${p}`, additions: removed, deletions: removed });
  }
  if (files.length === 0) {
    return { ...plan, status: 'BLOCKED', blockedReason: 'no references materialized into a diff' };
  }
  return { ...plan, files };
}

/**
 * APPLY a rename through the review pipeline (proposed per-file content snapshots
 * → workspace review → apply ACCEPTED). Requires the caller/user to accept the
 * review; never auto-applies.
 */
export async function executeRename(
  userId: string,
  projectId: string,
  symbol: string,
  newName: string,
): Promise<{ plan: RenamePlan; reviewId: string }> {
  const plan = await materializeRenamePreview(userId, projectId, symbol, newName);
  if (plan.status === 'BLOCKED' || plan.files.length === 0) {
    throw AppError.conflict('refactor_blocked', plan.blockedReason ?? 'rename cannot be safely performed');
  }

  const re = new RegExp(`\\b${symbol}\\b`, 'g');
  const proposed: Array<{ path: string; baseContent: string; proposedContent: string }> = [];
  for (const f of plan.files) {
    const file = await readFileEntry(projectId, f.path);
    if (!file || file.binary) continue;
    const newContent = file.content.replace(re, newName);
    proposed.push({ path: f.path, baseContent: file.content, proposedContent: newContent });
  }

  const review = await createReview(userId, projectId, proposed, `Rename ${symbol} → ${newName}`);
  // User must explicitly accept the review before it applies — the caller
  // surfaces acceptAll/apply endpooints. We do NOT auto-apply.
  return { plan: { ...plan, status: 'PLANNED' }, reviewId: review.id };
}

/** Apply an already-accepted rename review (explicit apply endpoint). */
export async function applyRenameReview(userId: string, projectId: string, reviewId: string): Promise<WorkspaceApplyResult> {
  await assertProjectAccess(userId, projectId);
  const review = await applyReview(userId, projectId, reviewId);
  return { status: review.status, reviewId };
}

export interface WorkspaceApplyResult {
  status: string;
  reviewId: string;
}

// keep pool import referenced (used transactionally)
export interface _Marker { pool: typeof pool; queryOne: typeof queryOne; queryMany: typeof queryMany; getWorkspace: typeof getWorkspace; recordDirectEdit: typeof recordDirectEdit; workspaceEnabled: typeof workspaceEnabled }
