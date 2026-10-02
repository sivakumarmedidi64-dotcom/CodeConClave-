/**
 * CodeConClave — B1 cowork safety review loop: hunks from the canonical diff.
 *
 * The diff ENGINE is `os/diff.ts` (Myers, canonical). This module derives the
 * reviewable hunk model from its line ops: each hunk is one maximal contiguous
 * change region with a stable identity (review, file, hunk_order) and pinned
 * original/proposed content hashes so apply + undo are deterministic and
 * divergent states fail closed. This is NOT a second diff engine.
 */
import { sha256Hex } from '../../shared/crypto.js';
import { diffLines } from '../../os/diff.js';
import type { DiffOp } from '../../os/diff.js';
import { HunkStatus } from './types.js';

export interface AcceptedHunkApply {
  oldStart: number;
  oldLines: number;
  insLines: string[];
}

export interface HunkDraft {
  fileOrder: number;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  insLines: string[];
  originalSha: string;
  proposedSha: string;
  additions: number;
  deletions: number;
  context: { before: string[]; after: string[] };
  diffText: string;
  /** Provisional status assigned when the review is created (real status lives in DB). */
  status: HunkStatus;
}

export interface ReviewDiff {
  filesChanged: number;
  additions: number;
  deletions: number;
  hunks: HunkDraft[];
  baseTrailingNewline: boolean;
  proposedTrailingNewline: boolean;
}

const CONTEXT = 3;

/** Canonical line split: content minus a single trailing terminator, kept as a flag. */
export function splitCanonical(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.length > 0 && content.endsWith('\n');
  if (content === '') return { lines: [], trailingNewline: false };
  const parts = content.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return { lines: parts, trailingNewline };
}

function rebuild(lines: string[], trailingNewline: boolean): string {
  return lines.join('\n') + (trailingNewline && lines.length > 0 ? '\n' : '');
}

interface ChangeRun {
  ops: DiffOp[];
  before: DiffOp[];
  after: DiffOp[];
}

/** Walk the canonical ops and split into maximal change regions with context. */
function splitRuns(ops: DiffOp[]): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let i = 0;
  let context: DiffOp[] = [];
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.type === 'equal') {
      context.push(op);
      if (context.length > CONTEXT) context.shift();
      i += 1;
      continue;
    }
    // change run: consume contiguous change ops, capturing leading context
    const before = context.slice(-CONTEXT);
    context = [];
    const runOps: DiffOp[] = [];
    while (i < ops.length && ops[i]!.type !== 'equal') {
      runOps.push(ops[i]!);
      i += 1;
    }
    // trailing context
    const after: DiffOp[] = [];
    let j = i;
    while (j < ops.length && ops[j]!.type === 'equal' && after.length < CONTEXT) {
      after.push(ops[j]!);
      j += 1;
    }
    runs.push({ ops: runOps, before, after });
  }
  return runs;
}

function hunkForRun(
  run: ChangeRun,
  baseLines: string[],
  path: string,
  fileOrder: number,
): HunkDraft {
  const deletes = run.ops.filter((o) => o.type === 'delete');
  const inserts = run.ops.filter((o) => o.type === 'insert');
  const delIndexes = deletes.map((o) => o.aIndex ?? 0);
  const insIndexes = inserts.map((o) => o.aIndex ?? 0);
  const allIndexes = [...delIndexes, ...insIndexes];
  const minA = Math.min(...allIndexes);
  // original span end: only deleted lines consume original lines
  const maxADel = delIndexes.length > 0 ? Math.max(...delIndexes) : null;
  const oldLines = maxADel === null ? 0 : maxADel - minA + 1;
  const oldStart = minA + 1;

  const insB = inserts.map((o) => o.bIndex ?? 0);
  const delB = deletes.map((o) => o.bIndex ?? 0);
  const newIndexes = [...delB, ...insB];
  const minB = newIndexes.length > 0 ? Math.min(...newIndexes) : minA;
  const maxBIns = insB.length > 0 ? Math.max(...insB) : null;
  const newLines = maxBIns === null ? 0 : maxBIns - minB + 1;
  const newStart = minB + 1;

  const insLines = inserts.map((o) => o.line);
  const originalSha = sha256Hex(baseLines.slice(minA, minA + oldLines).join('\n'));
  const proposedSha = sha256Hex(insLines.join('\n'));

  const additions = inserts.length;
  const deletions = deletes.length;

  const context = {
    before: run.before.map((o) => o.line),
    after: run.after.map((o) => o.line),
  };

  const diffText = buildDiffText(hunkDiffHeader(oldStart, oldLines, newStart, newLines), run);

  return {
    fileOrder,
    path,
    oldStart,
    oldLines,
    newStart,
    newLines,
    insLines,
    originalSha,
    proposedSha,
    additions,
    deletions,
    context,
    diffText,
    status: HunkStatus.PENDING,
  };
}

function hunkDiffHeader(oldStart: number, oldLines: number, newStart: number, newLines: number): string[] {
  return [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`];
}

function buildDiffText(header: string[], run: ChangeRun): string {
  const rows = [...header];
  for (const o of run.before) rows.push(` ${o.line}`);
  for (const o of run.ops) {
    if (o.type === 'delete') rows.push(`-${o.line}`);
    else if (o.type === 'insert') rows.push(`+${o.line}`);
  }
  for (const o of run.after) rows.push(` ${o.line}`);
  return rows.join('\n');
}

/**
 * Compute the reviewable diff between base and proposed content.
 * Returns per-file hunks (fileOrder:path "") for one file at a time;
 * callers aggregate across files.
 */
export function computeReviewDiff(
  baseContent: string,
  proposedContent: string,
  path: string,
  fileOrder: number,
): ReviewDiff {
  const base = splitCanonical(baseContent).lines;
  const proposed = splitCanonical(proposedContent).lines;
  const diff = diffLines(baseContent, proposedContent);
  const runs = splitRuns(diff.ops);
  const hunks = runs.map((run) => hunkForRun(run, base, path, fileOrder));
  return {
    filesChanged: hunks.length > 0 ? 1 : 0,
    additions: hunks.reduce((s, h) => s + h.additions, 0),
    deletions: hunks.reduce((s, h) => s + h.deletions, 0),
    hunks,
    baseTrailingNewline: baseContent.length > 0 && baseContent.endsWith('\n'),
    proposedTrailingNewline: proposedContent.length > 0 && proposedContent.endsWith('\n'),
  };
}

/**
 * Deterministically apply ONLY the accepted hunks to the base content.
 * Hunks must be supplied in ascending hunk_order; application order is
 * reversed by original position so earlier indices stay valid.
 */
export function applyAcceptedHunks(
  baseContent: string,
  accepted: AcceptedHunkApply[],
): { content: string; sha256: string } {
  const { lines, trailingNewline } = splitCanonical(baseContent);
  const ordered = [...accepted].sort((a, b) => b.oldStart - a.oldStart);
  for (const h of ordered) {
    const start = h.oldStart - 1;
    if (start < 0 || start + h.oldLines > lines.length) {
      throw new Error('hunk range outside base content');
    }
    lines.splice(start, h.oldLines, ...h.insLines);
  }
  const content = rebuild(lines, trailingNewline);
  return { content, sha256: sha256Hex(content) };
}

export function sha256Of(text: string): string {
  return sha256Hex(text);
}