/**
 * CodeConClave Local Agent — unified diff generation (Section 6.3).
 * Line-based Myers diff producing standard unified diff text plus SHA-256
 * before/after hashes for the edit audit trail.
 */
import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Op {
  type: '+' | '-' | ' ';
  line: string;
}

/** Myers O(ND) diff of two line arrays. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (n === 0) return b.map((line) => ({ type: '+' as const, line }));
  if (m === 0) return a.map((line) => ({ type: '-' as const, line }));
  const offset = max;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];
  let found = false;
  let distance = 0;
  for (let d = 0; d <= max && !found; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!;
      } else {
        x = v[k - 1 + offset]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    trace.push([...v]);
    if (found) distance = d;
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d >= 1; d--) {
    const vPrev = trace[d - 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + offset]! < vPrev[k + 1 + offset]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[prevK + offset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: ' ', line: a[x - 1]! });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ type: '+', line: b[y - 1]! });
      y--;
    } else {
      ops.push({ type: '-', line: a[x - 1]! });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: ' ', line: a[x - 1]! });
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

/** Render ops as standard unified diff text (3 lines of context). */
export function unifiedDiff(before: string, after: string, label = 'file'): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  const ops = diffLines(a, b);
  if (ops.every((o) => o.type === ' ')) return '';
  const header = `--- a/${label}\n+++ b/${label}\n`;
  const body: string[] = [];
  let start = 0;
  let count = 0;
  const flush = () => {
    if (count > 0) {
      body.push(`@@ -${start + 1},${count} +${start + 1},${count} @@`);
      for (let i = start; i < start + count; i++) body.push(`${ops[i]!.type}${ops[i]!.line}`);
    }
  };
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== ' ') {
      if (count === 0) start = i;
      count++;
    } else {
      flush();
      count = 0;
    }
  }
  flush();
  return header + body.join('\n');
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
