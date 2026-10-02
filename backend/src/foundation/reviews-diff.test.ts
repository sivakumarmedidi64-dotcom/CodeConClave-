/**
 * CodeConClave — B1 cowork review loop: hunk derivation + applied-content
 * determinism for the canonical diff (os/diff via modules/reviews/diff).
 * These tests pin the reviewable hunk model: stable per-hunk ranges and hashes,
 * context capture, additive-only/deletion-only hunks, multi-region splitting,
 * and the invariant that fully-applied content byte-matches the proposed file
 * (new-file case handled by the service via raw proposed content).
 */
import { describe, it, expect } from 'vitest';
import {
  computeReviewDiff,
  applyAcceptedHunks,
  splitCanonical,
  sha256Of,
} from '../modules/reviews/diff.js';

describe('splitCanonical — exact line model (no phantom trailing line)', () => {
  it('empty content → no lines, no trailing newline', () => {
    expect(splitCanonical('')).toEqual({ lines: [], trailingNewline: false });
  });

  it('carries the trailing-newline flag without a phantom empty line', () => {
    expect(splitCanonical('a\nb\n')).toEqual({ lines: ['a', 'b'], trailingNewline: true });
    expect(splitCanonical('a\nb')).toEqual({ lines: ['a', 'b'], trailingNewline: false });
  });
});

describe('computeReviewDiff — husk model derived from the canonical diff', () => {
  it('produces no hunks for identical content', () => {
    const d = computeReviewDiff('a\nb\nc\n', 'a\nb\nc\n', 'f.txt', 0);
    expect(d.hunks).toEqual([]);
    expect(d.filesChanged).toBe(0);
  });

  it('replacement region yields one hunk with pinned ranges and hashes', () => {
    const d = computeReviewDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt', 0);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;
    expect(h.oldStart).toBe(2);
    expect(h.oldLines).toBe(1);
    expect(h.newStart).toBe(2);
    expect(h.newLines).toBe(1);
    expect(h.additions).toBe(1);
    expect(h.deletions).toBe(1);
    expect(h.insLines).toEqual(['B']);
    expect(h.originalSha).toBe(sha256Of('b'));
    expect(h.proposedSha).toBe(sha256Of('B'));
    expect(h.status).toBe('PENDING');
  });

  it('insertion-only hunk has oldLines 0; deletion-only has newLines 0', () => {
    const ins = computeReviewDiff('a\nb\nc\n', 'a\nb\nx\ny\nc\n', 'f.txt', 0);
    expect(ins.hunks[0]!.oldLines).toBe(0);
    expect(ins.hunks[0]!.newLines).toBe(2);
    expect(ins.hunks[0]!.additions).toBe(2);
    expect(ins.hunks[0]!.deletions).toBe(0);

    const del = computeReviewDiff('a\nb\nc\n', 'a\nc\n', 'f.txt', 0);
    expect(del.hunks[0]!.newLines).toBe(0);
    expect(del.hunks[0]!.oldLines).toBe(1);
    expect(del.hunks[0]!.additions).toBe(0);
    expect(del.hunks[0]!.deletions).toBe(1);
  });

  it('far-apart changes split into independent hunks with stable order', () => {
    const d = computeReviewDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nX\nd\ne\nf\ng\nH\n', 'f.txt', 0);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]!.oldStart).toBe(3);
    expect(d.hunks[1]!.oldStart).toBe(8);
    expect(d.hunks[0]!.oldStart < d.hunks[1]!.oldStart).toBe(true);
  });

  it('captures bounded leading/trailing context', () => {
    const d = computeReviewDiff('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nX\ne\nf\ng\n', 'f.txt', 0);
    const h = d.hunks[0]!;
    expect(h.oldStart).toBe(4);
    expect(h.context.before).toEqual(['a', 'b', 'c']);
    expect(h.context.after).toEqual(['e', 'f', 'g']);
  });

  it('aggregates additions/deletions across hunks', () => {
    const d = computeReviewDiff('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nX\ne\nf\ng\nY\n', 'f.txt', 0);
    expect(d.filesChanged).toBe(1);
    expect(d.additions).toBe(d.hunks.reduce((s, h) => s + h.additions, 0));
    expect(d.deletions).toBe(d.hunks.reduce((s, h) => s + h.deletions, 0));
  });

  it('is deterministic — same inputs produce identical hunks and hashes', () => {
    const a = computeReviewDiff('x\n1\n2\n3\n4\n5\n6\ny\n', 'x\n1\nA\n3\n4\n5\n6\ny\nB\n', 'f.txt', 0);
    const b = computeReviewDiff('x\n1\n2\n3\n4\n5\n6\ny\n', 'x\n1\nA\n3\n4\n5\n6\ny\nB\n', 'f.txt', 0);
    expect(a.hunks.map((h) => [h.oldStart, h.oldLines, h.originalSha, h.proposedSha])).toEqual(
      b.hunks.map((h) => [h.oldStart, h.oldLines, h.originalSha, h.proposedSha]),
    );
  });

  it('new-file diff (empty base) yields an insertion hunk at line 1', () => {
    const d = computeReviewDiff('', 'x\ny\nz\n', 'new.txt', 0);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.oldStart).toBe(1);
    expect(d.hunks[0]!.oldLines).toBe(0);
    expect(d.hunks[0]!.newLines).toBe(3);
  });
});

describe('applyAcceptedHunks — deterministic, hash-verified partial application', () => {
  it('applying every hunk rebuilds byte-identical content (trailing newline kept)', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const proposed = 'a\nb\nX\nd\ne\nf\ng\nH\n';
    const d = computeReviewDiff(base, proposed, 'f.txt', 0);
    const applied = applyAcceptedHunks(
      base,
      d.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, insLines: h.insLines })),
    );
    expect(applied.content).toBe(proposed);
    expect(applied.sha256).toBe(sha256Of(proposed));
  });

  it('rejecting a hunk keeps that region untouched', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const proposed = 'a\nb\nX\nd\ne\nf\ng\nH\n';
    const d = computeReviewDiff(base, proposed, 'f.txt', 0);
    const [first, second] = d.hunks;
    const applied = applyAcceptedHunks(base, [{ oldStart: second!.oldStart, oldLines: second!.oldLines, insLines: second!.insLines }]);
    expect(applied.content).toBe('a\nb\nc\nd\ne\nf\ng\nH\n');
    expect(applied.sha256).toBe(sha256Of('a\nb\nc\nd\ne\nf\ng\nH\n'));
    expect(first!.oldStart).toBe(3);
    expect(applied.content.includes('X')).toBe(false);
  });

  it('applies in descending original order so line indices stay valid', () => {
    const base = '1\n2\n3\n4\n5\n6\n7\n8\n';
    const proposed = '1\n2\nX\n4\n5\n6\n7\nY\n';
    const d = computeReviewDiff(base, proposed, 'f.txt', 0);
    const applied = applyAcceptedHunks(
      base,
      d.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, insLines: h.insLines })),
    );
    expect(applied.content).toBe(proposed);
  });

  it('rejects hunks outside the base content (fail closed)', () => {
    expect(() =>
      applyAcceptedHunks('a\nb\n', [
        { oldStart: 9, oldLines: 1, insLines: ['x'] },
      ]),
    ).toThrow(/hunk range outside base content/);
  });
});