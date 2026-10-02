/**
 * CodeConClave — B1 cowork safety review loop: performance ceilings (Phase L).
 *
 * These are honest upper bounds on the hot paths of the review loop so that a
 * pathological regression (quadratic line handling, runaway hunk explosion)
 * fails the suite. Bounds are deliberately generous (single-digit ms expected
 * on dev hardware → seconds of headroom) so CI never flakes on load.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { splitCanonical, computeReviewDiff, applyAcceptedHunks, sha256Of } from '../modules/reviews/diff.js';

const LINE = (i: number): string => `line-${String(i).padStart(5, '0')} payload data`;

function buildBase(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) out.push(LINE(i));
  return out.join('\n') + '\n';
}

/** Scatter N single-line edits across a base, returning the edited content. */
function scatterEdits(base: string, n: number, stride: number): string {
  const lines = splitCanonical(base).lines.slice();
  for (let k = 0; k < n; k += 1) {
    const idx = Math.min(lines.length - 1, 10 + k * stride);
    lines[idx] = `edited-${k} ${lines[idx]}`;
  }
  return lines.join('\n') + '\n';
}

describe('review loop perf ceilings', () => {
  it('splitCanonical handles a 20k-line payload in well under a second', () => {
    const big = buildBase(20_000);
    const t0 = performance.now();
    const { lines, trailingNewline } = splitCanonical(big);
    const elapsed = performance.now() - t0;
    expect(lines.length).toBe(20_000);
    expect(trailingNewline).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('computeReviewDiff of 40 scattered edits on 10k lines stays linear and bounded', () => {
    const base = buildBase(10_000);
    const proposed = scatterEdits(base, 40, 240);
    const t0 = performance.now();
    const diff = computeReviewDiff(base, proposed, 'src/big.ts', 0);
    const elapsed = performance.now() - t0;
    expect(diff.hunks.length).toBe(40);
    expect(diff.additions).toBe(40);
    expect(diff.deletions).toBe(40);
    expect(elapsed).toBeLessThan(2_500);
  });

  it('applyAcceptedHunks of 40 hunks over 10k lines is bounded and byte-exact vs full apply', () => {
    const base = buildBase(10_000);
    const proposed = scatterEdits(base, 40, 240);
    const diff = computeReviewDiff(base, proposed, 'src/big.ts', 0);
    const accepted = diff.hunks.slice(0, 25).map((h, i) => ({
      id: `rvh_${i}`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      insLines: h.insLines,
    }));
    const t0 = performance.now();
    const partial = applyAcceptedHunks(base, accepted);
    const elapsed = performance.now() - t0;
    expect(partial.sha256).toBe(sha256Of(partial.content));
    expect(partial.content.length).toBeGreaterThan(base.length);
    expect(elapsed).toBeLessThan(1_000);

    const full = applyAcceptedHunks(base, diff.hunks.map((h) => ({ id: h.status, oldStart: h.oldStart, oldLines: h.oldLines, insLines: h.insLines })));
    expect(full.content).toBe(proposed);
  });

  it('identical inputs produce identical diff text (deterministic hashing, no shuffle)', () => {
    const base = buildBase(500);
    const proposed = scatterEdits(base, 8, 60);
    const a = computeReviewDiff(base, proposed, 'a.txt', 0);
    const b = computeReviewDiff(base, proposed, 'a.txt', 0);
    expect(a.hunks).toHaveLength(8);
    for (let i = 0; i < a.hunks.length; i += 1) {
      expect(a.hunks[i]!.diffText).toBe(b.hunks[i]!.diffText);
      expect(a.hunks[i]!.originalSha).toBe(b.hunks[i]!.originalSha);
      expect(a.hunks[i]!.proposedSha).toBe(b.hunks[i]!.proposedSha);
    }
  });
});