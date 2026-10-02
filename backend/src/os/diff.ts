/**
 * CodeConClave AI OS — Myers diff (text) helper (P0.3).
 * Pure, dependency-free line diff used by the filesystem OS layer. Returns
 * line-level additions/deletions and a simple patch record for rollback.
 */

export interface DiffOp {
  type: 'insert' | 'delete' | 'equal';
  line: string;
  aIndex: number | null; // index in original
  bIndex: number | null; // index in revised
}

export interface DiffResult {
  ops: DiffOp[];
  additions: number;
  deletions: number;
}

/**
 * Classic Myers O(ND) diff over arrays. Returns the edit ops to transform `a`
 * into `b`, in forward order.
 */
function myers(a: string[], b: string[]): Array<{ type: 'ins' | 'del' | 'eq'; aIndex: number; bIndex: number }> {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const v: Record<number, number | undefined> = {};
  const trace: Array<Record<number, number | undefined>> = [];
  let found = false;

  for (let d = 0; d <= max; d++) {
    const snapshot: Record<number, number | undefined> = {};
    for (const k of Object.keys(v)) snapshot[Number(k)] = v[Number(k)]!;
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v[k - 1] ?? -Infinity) < (v[k + 1] ?? -Infinity))) {
        x = v[k + 1] ?? 0;
      } else {
        x = (v[k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }

  // Backtrack to reconstruct ops.
  const ops: Array<{ type: 'ins' | 'del' | 'eq'; aIndex: number; bIndex: number }> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vprev = trace[d];
    if (!vprev) break;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vprev[k - 1] ?? -Infinity) < (vprev[k + 1] ?? -Infinity))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vprev[prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: 'eq', aIndex: x, bIndex: y });
    }
    if (d === 0) break;
    if (x === prevX) {
      y -= 1;
      ops.push({ type: 'ins', aIndex: x, bIndex: y });
    } else {
      x -= 1;
      ops.push({ type: 'del', aIndex: x, bIndex: y });
    }
    if ((vprev as Record<number, number | undefined>)[prevK] === undefined) break;
  }
  ops.reverse();
  return ops;
}

export function diffLines(aContent: string, bContent: string): DiffResult {
  const a = toLines(aContent);
  const b = toLines(bContent);
  const raw = myers(a, b);
  const ops: DiffOp[] = raw.map((o) => {
    const line = o.type === 'ins' ? b[o.bIndex] ?? '' : o.type === 'del' ? a[o.aIndex] ?? '' : a[o.aIndex] ?? '';
    return {
      type: o.type === 'ins' ? 'insert' : o.type === 'del' ? 'delete' : 'equal',
      line,
      aIndex: o.aIndex < 0 ? null : o.aIndex,
      bIndex: o.bIndex < 0 ? null : o.bIndex,
    };
  });
  const additions = ops.filter((o) => o.type === 'insert').length;
  const deletions = ops.filter((o) => o.type === 'delete').length;
  return { ops, additions, deletions };
}

/** Apply a diff back for simple rollback: re-emit original lines. */
export function applyReverseDiff(original: string[], diff: DiffResult): string {
  const out: string[] = [];
  let aIndex = 0;
  for (const op of diff.ops) {
    if (op.type === 'equal') {
      out.push(original[aIndex] ?? '');
      aIndex += 1;
    } else if (op.type === 'delete') {
      // op.line is the line that existed in the original; restore it
      out.push(op.line);
      aIndex += 1;
    }
    // insert in diff means lines added in b; in reverse they are removed -> skip
  }
  return out.join('\n');
}

/** Split content into lines, treating a trailing newline as a terminator. */
function toLines(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
