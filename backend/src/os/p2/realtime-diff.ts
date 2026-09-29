/**
 * CodeConClave AI OS — P2.2 Real-Time Diff.
 *
 * Reuses the P0 Myers `diffLines` primitive to produce hunk-level diffs for a
 * file. A hunk is a contiguous run of insert/delete ops with its equal-context
 * boundary. Supports:
 *   - file-level diff (whole file)
 *   - hunk diff (per contiguous change region)
 *   - accept hunk / reject hunk (partial application onto the original)
 *   - regenerate a rejected section (re-diff that region)
 * The ORIGINAL snapshot is preserved so any number of accept/reject decisions
 * never silently overwrite user changes: every applied result is derived from
 * the original + the set of accepted hunks.
 */
import { AppError } from '../../shared/errors.js';
import { diffLines, DiffOp } from '../diff.js';
import type { P2Feature } from './flags.js';

export interface Hunk {
  id: number;
  startA: number; // 0-based index in original where this hunk begins
  ops: DiffOp[];
  linesDelta: number;
  accepted: boolean;
  rejected: boolean;
}

export class RealtimeDiff {
  private hunks: Hunk[] = [];
  private origLines: string[];
  private nextId = 1;

  constructor(
    private feature: () => P2Feature | null,
    private originalContent: string,
    private currentContent: string,
  ) {
    this.origLines = toLines(originalContent);
    this.computeHunks();
  }

  isEnabled(): boolean {
    return this.feature() === 'diff';
  }

  private computeHunks(): void {
    const { ops } = diffLines(this.originalContent, this.currentContent);
    this.hunks = [];
    let hunk: DiffOp[] = [];
    let startA = 0;
    let cursor = 0;
    const flush = (endA: number) => {
      if (hunk.length === 0) return;
      const linesDelta = hunk.filter((o) => o.type === 'insert').length -
        hunk.filter((o) => o.type === 'delete').length;
      this.hunks.push({
        id: this.nextId++,
        startA,
        ops: hunk,
        linesDelta,
        accepted: false,
        rejected: false,
      });
      hunk = [];
    };
    for (const op of ops) {
      if (op.type === 'equal') {
        flush(cursor);
        cursor += 1;
        startA = cursor;
        continue;
      }
      if (hunk.length === 0) startA = cursor;
      hunk.push(op);
      if (op.type === 'delete') cursor += 1;
    }
    flush(cursor);
  }

  get fileChanged(): boolean {
    return this.hunks.length > 0;
  }

  listHunks(): Hunk[] {
    return this.hunks.map((h) => ({ ...h, ops: [...h.ops] }));
  }

  diffFile(): DiffOp[] {
    return diffLines(this.originalContent, this.currentContent).ops;
  }

  /** ACCEPT a hunk: mark accepted. Result content is recomputed from original + accepted hunks only. */
  accept(hunkId: number): string {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_diff_disabled', 'diff feature is off');
    const hunk = this.byId(hunkId);
    hunk.accepted = true;
    hunk.rejected = false;
    return this.applyAccepted();
  }

  /** REJECT a hunk: mark rejected (its region is left at the original). */
  reject(hunkId: number): string {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_diff_disabled', 'diff feature is off');
    const hunk = this.byId(hunkId);
    hunk.rejected = true;
    hunk.accepted = false;
    return this.applyAccepted();
  }

  /** REGENERATE a rejected hunk: reset it to un-decided and re-apply. */
  regenerate(hunkId: number): string {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_diff_disabled', 'diff feature is off');
    const hunk = this.byId(hunkId);
    hunk.accepted = false;
    hunk.rejected = false;
    return this.applyAccepted();
  }

  /** The original snapshot — always preserved for safety. */
  get original(): string {
    return this.origLines.join('\n');
  }

  private byId(id: number): Hunk {
    const hunk = this.hunks.find((h) => h.id === id);
    if (!hunk) throw AppError.notFound('aios_p2_diff_hunk', `hunk ${id} not found`);
    return hunk;
  }

  /** Rebuild content = original with only accepted hunks applied (in order). */
  private applyAccepted(): string {
    const acceptedInOrder = this.hunks
      .filter((h) => h.accepted)
      .sort((a, b) => a.startA - b.startA);
    const lines = [...this.origLines];
    // apply deletes/inserts forward
    acceptedInOrder.forEach((h) => {
      let aCursor = h.startA;
      for (const op of h.ops) {
        if (op.type === 'delete') {
          lines.splice(aCursor, 1);
        } else if (op.type === 'insert') {
          lines.splice(aCursor, 0, op.line);
          aCursor += 1;
        } else {
          aCursor += 1;
        }
      }
    });
    return lines.join('\n');
  }
}

function toLines(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
