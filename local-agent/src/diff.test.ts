/**
 * Unified diff + hashing tests (Section 6.3 audit storage).
 */
import { describe, expect, it } from 'vitest';
import { diffLines, unifiedDiff, diffStat, sha256 } from './diff.js';

describe('sha256', () => {
  it('produces stable 64-char hex hashes', () => {
    const h = sha256('hello');
    expect(h).toHaveLength(64);
    expect(h).toBe(sha256('hello'));
    expect(h).not.toBe(sha256('hellp'));
  });
});

describe('line diff', () => {
  it('detects additions, removals and common lines', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    const types = ops.map((o) => o.type).join('');
    expect(types).toContain('-');
    expect(types).toContain('+');
    expect(ops.filter((o) => o.type === ' ').length).toBe(2);
  });

  it('handles empty inputs', () => {
    expect(diffLines([], ['a'])).toHaveLength(1);
    expect(diffLines(['a'], [])).toHaveLength(1);
  });
});

describe('unified diff rendering', () => {
  it('produces parseable diff with hunks', () => {
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nchanged\nline3\n';
    const d = unifiedDiff(before, after, 'file.txt');
    expect(d).toContain('--- a/file.txt');
    expect(d).toContain('+++ b/file.txt');
    const stat = diffStat(d);
    expect(stat.added).toBe(1);
    expect(stat.removed).toBe(1);
  });

  it('returns empty-stat for identical content', () => {
    const d = unifiedDiff('same\n', 'same\n', 'f');
    const stat = diffStat(d);
    expect(stat.added).toBe(0);
    expect(stat.removed).toBe(0);
  });
});
