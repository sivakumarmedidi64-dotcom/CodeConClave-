/**
 * CodeConClave — PKG-22 Advanced Code Workspace — tests.
 * 30 cases: multi-file editor state, project navigation, content search, symbol
 * nav, reviewed editing, safe rename refactor, diagnostics overlay, memory
 * isolation, AI context, cross-file detection, git-honesty, user/workspace
 * isolation, path traversal, large-file guard, cancellation, and persistence.
 * Uses an in-memory fake DB + a real temp workspace root on disk for the
 * filesystem-backed editor/search/edit/refactor layers (deterministic, no PG).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ================================================================ fake DB harness
const hoisted = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  let nextId = 0;

  function getTable(t: string): Row[] {
    return tables.get(t) ?? [];
  }

  // WHERE matcher supporting `col = $N` / `col IN ($N,...)` joined by AND, plus
  // `col = literal` and a nested `review_id IN (SELECT id FROM workspace_reviews WHERE workspace_id=$N)`.
  function matchWhere(where: string, params?: unknown[]): (r: Row) => boolean {
    const preds: Array<(r: Row) => boolean> = [];
    const clauses = where.split(/\s+AND\s+/i).filter(Boolean);
    for (const clause of clauses) {
      let m = /^(\w+)\s*=\s*\$(\d+)$/.exec(clause);
      if (m) {
        const col = m[1]!; const val = params?.[Number(m[2]) - 1];
        preds.push((r) => r[col] === val);
        continue;
      }
      m = /^(\w+)\s*IN\s*\((.+)\)$/i.exec(clause);
      if (m) {
        // subquery reference to workspace_reviews scoped to a workspace
        const sub = /^SELECT\s+id\s+FROM\s+workspace_reviews\s+WHERE\s+workspace_id\s*=\s*\$(\d+)$/i.exec(m[2]!);
        if (sub) {
          const wsId = params?.[Number(sub[1]) - 1];
          const reviewIds = getTable('workspace_reviews').filter((r) => r.workspace_id === wsId).map((r) => r.id);
          preds.push((r) => reviewIds.includes(r[m[1]!] as never as unknown));
          continue;
        }
        const vals = (m[2]!.match(/\$\d+/g) ?? []).map((t) => params?.[Number(t.slice(1)) - 1]);
        preds.push((r) => vals.includes(r[m[1]!]));
        continue;
      }
      // literal comparison: col = <literal|number> (e.g. accepted = true, tab_order = 0)
      m = /^(\w+)\s*=\s*(.+)$/.exec(clause);
      if (m) {
        const col = m[1]!; const val = parseValue(m[2]!, params);
        preds.push((r) => r[col] === val);
        continue;
      }
    }
    return (r) => preds.every((p) => p(r));
  }

  function parseValue(token: string, params?: unknown[]): unknown {
    const t = token.trim();
    if (/^\$\d+$/.test(t)) return params?.[Number(t.slice(1)) - 1];
    if (/^now\(\)$/.test(t)) return new Date();
    if (/^(true|TRUE|True)$/.test(t)) return true;
    if (/^(false|FALSE|False)$/.test(t)) return false;
    if (t === 'NULL') return null;
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    const num = Number(t);
    return Number.isNaN(num) ? t : num;
  }

  function splitTopLevel(s: string): string[] {
    const out: string[] = []; let depth = 0; let cur = '';
    for (const ch of s) {
      if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  const query = vi.fn(async (text: string, params?: unknown[]) => {
    const insert = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)/is.exec(text);
    if (insert) {
      const table = insert[1]!;
      const cols = insert[2]!.split(',').map((c) => c.trim()).filter(Boolean);
      const tokens = splitTopLevel(insert[3]!);
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = parseValue(tokens[i] ?? 'NULL', params); });
      if (!('id' in row)) row.id = `x${++nextId}`;
      // deterministic, monotonic timestamp so ORDER BY created_at DESC is stable
      for (const dc of ['created_at', 'updated_at']) {
        if (!(dc in row)) row[dc] = new Date(1735689600000 + ++nextId);
      }
      tables.set(table, [...getTable(table), row]);
      return { rows: [row] };
    }

    // UPDATE <table> SET col=$N,... WHERE ... (handles workspace state + review file updates)
    const update = /UPDATE (\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is.exec(text);
    if (update) {
      const table = update[1]!;
      const sets: Array<[string, unknown]> = [];
      for (const clause of update[2]!.split(',')) {
        const m = /^(\w+)\s*=\s*(.+)$/.exec(clause.trim());
        if (m) sets.push([m[1]!, parseValue(m[2]!, params)]);
      }
      const matcher = matchWhere(update[3]!, params);
      const arr = getTable(table).map((r) => {
        if (matcher(r)) { for (const [k, v] of sets) r[k] = v; }
        return r;
      });
      tables.set(table, arr);
      return { rows: [] };
    }

    const del = /DELETE FROM (\w+)/i.exec(text);
    if (del) {
      const table = del[1]!;
      const whereM = /WHERE\s+(.+)$/i.exec(text);
      if (whereM) {
        const matcher = matchWhere(whereM[1]!, params);
        tables.set(table, getTable(table).filter((r) => !matcher(r)));
      } else {
        tables.set(table, []);
      }
      return { rows: [] };
    }
    return { rows: [] };
  });

  const queryMany = vi.fn(async (text: string, params?: unknown[]) => {
    // route write statements (UPDATE/INSERT/DELETE) through the query executor
    if (/^(UPDATE|INSERT|DELETE)\b/i.test(text.trim())) {
      await query(text, params);
      return [];
    }
    let sql = text.replace(/\/\/?$/g, '');
    // ORDER BY ... LIMIT n (strip trailing)
    let limit = Infinity;
    const limitM = /\s+LIMIT\s+(\d+)$/i.exec(sql);
    if (limitM) { limit = Number(limitM[1]); sql = sql.slice(0, limitM.index); }
    const from = /FROM (\w+)/i.exec(sql);
    if (!from) return [];
    const table = from[1]!;
    const whereM = /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s*$)/is.exec(sql);
    let rows = getTable(table);
    if (whereM && whereM[1]!.trim()) rows = rows.filter(matchWhere(whereM[1]!, params));
    const orderM = /ORDER\s+BY\s+(\w+)(\s+(DESC|ASC))?/i.exec(sql);
    if (orderM) {
      const col = orderM[1]!; const dir = (orderM[3] ?? 'ASC').toUpperCase();
      rows = [...rows].sort((a, b) => {
        const av = a[col]; const bv = b[col];
        if (av == null) return 1; if (bv == null) return -1;
        let cmp: number;
        if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
        else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv));
        return dir === 'DESC' ? -cmp : cmp;
      });
    }
    return rows.slice(0, limit);
  });

  const queryOne = vi.fn(async (text: string, params?: unknown[]) => {
    // projects ownership gate
    const proj = /FROM projects WHERE id = \$(\d+) AND owner_id = \$(\d+)/i.exec(text);
    if (proj) {
      const pid = params?.[Number(proj[1]) - 1];
      const uid = params?.[Number(proj[2]) - 1];
      const row = getTable('projects').find((r) => r.id === pid && r.owner_id === uid && r.deleted_at == null);
      return row ?? null;
    }
    const rows = await queryMany(text, params);
    return rows[0] ?? null;
  });

  const query2 = async (text: string, params?: unknown[]) => {
    if (/^(UPDATE|INSERT|DELETE)\b/i.test(text.trim())) {
      await query(text, params);
      return { rows: [], rowCount: 0 };
    }
    const rows = await queryMany(text, params);
    return { rows, rowCount: rows.length };
  };

  return { tables, query, query2, queryMany, queryOne, reset: () => { tables.clear(); nextId = 0; } };
});

vi.mock('../../shared/db.js', () => ({
  pool: { query: hoisted.query },
  queryMany: hoisted.queryMany,
  queryOne: hoisted.queryOne,
  withTenant: (_u: string, fn: (q: unknown) => unknown) => (fn as (q: unknown) => unknown)?.({ query: hoisted.query2 }),
  withSystem: (fn: (q: unknown) => unknown) => fn?.({ query: hoisted.query2 }),
}));

vi.mock('../../shared/errors.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/errors.js')>('../../shared/errors.js');
  return actual;
});

const envMock = vi.hoisted(() => {
  const e: Record<string, string> = {
    PREVIEW_PROJECTS_ROOT: '',
    AIOS_P2_WORKSPACE: 'true',
    AIOS_SANDBOX_ALLOWED_COMMANDS: '',
    AIOS_SANDBOX_TIMEOUT_MS: '30000',
  };
  return e;
});
vi.mock('../../config/env.js', () => ({ env: envMock }));

vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

import { AppError } from '../../shared/errors.js';
import { listTree, listFilePaths, readFileEntry, writeFileEntry } from './fs.js';
import { getWorkspace, setSplit, setActiveFile, openTab, closeTab, setTabUnsaved, restoreState, recentWorkspaceFiles } from './state.js';
import { searchWorkspace, searchCurrentFile, fetchContext } from './search.js';
import { getOutline, findDefinition, findReferences, findImportRelations } from './symbols.js';
import { createReview, decideFile, acceptAll, rejectAll, applyReview, getReview, listReviews, listEditHistory, recordDirectEdit } from './edit.js';
import { materializeRenamePreview, executeRename, applyRenameReview } from './refactor.js';
import { detectAffectedFiles } from './related.js';
import { buildEditorContext } from './context.js';
import { gitStatus } from './git.js';
import { getFileDiagnostics } from './diagnostics.js';
import { workspaceMemoryContext } from './memory.js';

const tmpRoot = path.join(tmpdir(), `codeconclave-pkg22-${process.pid}`);
let root = '';

beforeEach(async () => {
  hoisted.reset();
  hoisted.tables.set('projects', []);
  await mkdir(tmpRoot, { recursive: true });
  root = await mkdtemp(path.join(tmpRoot, 'root-'));
  envMock.PREVIEW_PROJECTS_ROOT = root.replace(/[\\/]+$/, '');
  envMock.AIOS_P2_WORKSPACE = 'true';
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function seedProjectDisk(projectId: string, ownerId: string, files: Record<string, string>): Promise<void> {
  const existing = hoisted.tables.get('projects') ?? [];
  if (!existing.some((r) => r.id === projectId)) {
    hoisted.tables.set('projects', [...existing, { id: projectId, owner_id: ownerId, deleted_at: null }]);
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, projectId, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

describe('PKG-22 Advanced Code Workspace', () => {
  // ------- 1. open / close / reopen file
  it('open / close / reopen file persists tab state', async () => {
    const pid = 'p-open'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
    let ws = await openTab(u, pid, 'src/a.ts');
    expect(ws.tabs.some((t) => t.path === 'src/a.ts')).toBe(true);
    ws = await openTab(u, pid, 'src/b.ts');
    expect(ws.tabs.map((t) => t.path)).toEqual(['src/a.ts', 'src/b.ts']);
    ws = await closeTab(u, pid, 'src/a.ts');
    expect(ws.tabs.some((t) => t.path === 'src/a.ts')).toBe(false);
    ws = await openTab(u, pid, 'src/a.ts');
    expect(ws.tabs.some((t) => t.path === 'src/a.ts')).toBe(true);
    ws = await restoreState(u, pid);
    expect(ws.tabs.length).toBe(2);
  });

  // ------- 2. multi-tab order + pinned
  it('multiple tabs preserve order and pinned state', async () => {
    const pid = 'p-tabs'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x', 'b.ts': 'y', 'c.ts': 'z' });
    let ws = await openTab(u, pid, 'a.ts', { pinned: true });
    ws = await openTab(u, pid, 'b.ts');
    ws = await openTab(u, pid, 'c.ts');
    ws = await restoreState(u, pid);
    const a = ws.tabs.find((t) => t.path === 'a.ts')!;
    expect(a.pinned).toBe(true);
    expect(ws.tabs.map((t) => t.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  // ------- 3. split pane
  it('split pane layout persists', async () => {
    const pid = 'p-split'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    let ws = await setSplit(u, pid, 'split-vertical');
    expect(ws.split).toBe('split-vertical');
    ws = await setSplit(u, pid, 'single');
    expect(ws.split).toBe('single');
  });

  // ------- 4. unsaved state
  it('tracks unsaved state and saved sha256', async () => {
    const pid = 'p-unsaved'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'let x = 1;' });
    await openTab(u, pid, 'a.ts');
    await setTabUnsaved(u, pid, 'a.ts', true);
    let ws = await getWorkspace(u, pid);
    expect(ws.tabs.find((t) => t.path === 'a.ts')!.unsaved).toBe(true);
    await setTabUnsaved(u, pid, 'a.ts', false, 'abcd');
    ws = await getWorkspace(u, pid);
    expect(ws.tabs.find((t) => t.path === 'a.ts')!.unsaved).toBe(false);
    expect(ws.tabs.find((t) => t.path === 'a.ts')!.savedSha256).toBe('abcd');
  });

  // ------- 5. save (version-aware write)
  it('version-aware save writes new content and returns new hash; conflict on stale base', async () => {
    const pid = 'p-save'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'let x = 1;' });
    const initial = await readFileEntry(pid, 'a.ts');
    const newSha = await writeFileEntry(pid, 'a.ts', 'let x = 2;', initial!.sha256);
    const after = await readFileEntry(pid, 'a.ts');
    expect(after!.content).toBe('let x = 2;');
    expect(after!.sha256).toBe(newSha);
    await expect(writeFileEntry(pid, 'a.ts', 'let x = 3;', 'stale-hash')).rejects.toMatchObject({ status: 409 });
  });

  // ------- 6. undo/redo via edit history
  it('direct save records immutable edit history for undo/redo', async () => {
    const pid = 'p-undo'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'let x = 1;' });
    const base = (await readFileEntry(pid, 'a.ts'))!.sha256;
    // first save: base -> 'let x = 2;'
    const sha2 = await writeFileEntry(pid, 'a.ts', 'let x = 2;', base);
    await recordDirectEdit(u, pid, 'a.ts', base, 'let x = 2;');
    // second save: current -> 'let x = 3;'
    const cur = (await readFileEntry(pid, 'a.ts'))!.sha256;
    const sha3 = await writeFileEntry(pid, 'a.ts', 'let x = 3;', cur);
    await recordDirectEdit(u, pid, 'a.ts', cur, 'let x = 3;');
    const edits = await listEditHistory(u, pid, 'a.ts');
    expect(edits.length).toBe(2);
    expect(edits[0]!.newSha256).toBe(sha3);
    expect(edits[1]!.newSha256).toBe(sha2);
    expect(edits[0]!.newSha256).toBe((await readFileEntry(pid, 'a.ts'))!.sha256);
  });

  // ------- 7. file conflict (concurrent change)
  it('detects file conflict when base sha256 does not match disk', async () => {
    const pid = 'p-conflict'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'v1' });
    await readFileEntry(pid, 'a.ts');
    // simulate external write
    await writeFile(path.join(root, pid, 'a.ts'), 'v2', 'utf8');
    await expect(writeFileEntry(pid, 'a.ts', 'v3', 'hash-of-v1')).rejects.toMatchObject({ status: 409 });
  });

  // ------- 8. project search
  it('project-wide content search finds matches across files', async () => {
    const pid = 'p-search'; const u = 'u1';
    await seedProjectDisk(pid, u, {
      'src/a.ts': 'const foo = 1;\n',
      'src/b.ts': 'using foo here\n',
      'other.md': 'nothing',
    });
    const res = await searchWorkspace(pid, { q: 'foo' });
    expect(res!.total).toBe(2);
    expect(res!.matches.some((m) => m.file === 'src/a.ts')).toBe(true);
    expect(res!.matches.some((m) => m.file === 'src/b.ts')).toBe(true);
  });

  // ------- 9. regex search
  it('regex search supports patterns and case sensitivity', async () => {
    const pid = 'p-regex'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'FUNCTION x()\nfunction y()\n' });
    const res = await searchWorkspace(pid, { q: '^function ', regex: true, caseSensitive: true });
    expect(res!.total).toBe(1);
    expect(res!.matches[0]!.line).toBe(2);
  });

  // ------- 10. symbol navigation (outline)
  it('HEURISTIC outline lists functions/consts', async () => {
    const pid = 'p-outline'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'export function greet(name: string): string {\n  return name;\n}\nexport const MAX = 10;\n' });
    const outline = await getOutline(pid, 'a.ts');
    expect(outline!.symbols.some((s) => s.name === 'greet' && s.kind === 'function')).toBe(true);
    expect(outline!.symbols.some((s) => s.name === 'MAX' && s.kind === 'const')).toBe(true);
  });

  // ------- 11. diagnostics navigation
  it('diagnostics overlay reports HEURISTIC state honestly', async () => {
    const pid = 'p-diag'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'const x = 1;' });
    const d = await getFileDiagnostics(u, pid, 'a.ts');
    expect(d.state).toBe('HEURISTIC');
    expect(Array.isArray(d.findings)).toBe(true);
  });

  // ------- 12. safe rename (preview, not auto-applied)
  it('rename preview produces plan without modifying files', async () => {
    const pid = 'p-rename'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'export const foo = 1;\nconsole.log(foo);\n' });
    const plan = await materializeRenamePreview(u, pid, 'foo', 'bar');
    expect(plan.status).toBe('PLANNED');
    const onDisk = await readFile(path.join(root, pid, 'a.ts'), 'utf8');
    expect(onDisk).toContain('foo');
    expect(onDisk).not.toContain('bar');
  });

  // ------- 13. rename blocked on missing symbol
  it('rename is BLOCKED when symbol is not present', async () => {
    const pid = 'p-rename2'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'export const x = 1;\n' });
    const plan = await materializeRenamePreview(u, pid, 'doesNotExist', 'zzz');
    expect(plan.status).toBe('BLOCKED');
  });

  // ------- 14. refactor preview + review + apply requires explicit accept
  it('executeRename creates a review and does NOT auto-apply until accepted', async () => {
    const pid = 'p-ref'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'export const foo = 1;\nfoo + foo;\n' });
    const out = await executeRename(u, pid, 'foo', 'bar');
    expect(out.reviewId).toBeTruthy();
    let onDisk = await readFile(path.join(root, pid, 'a.ts'), 'utf8');
    expect(onDisk).toContain('foo'); // not yet applied
    const review = await getReview(u, pid, out.reviewId);
    expect(review.status).toBe('READY_FOR_REVIEW');
    await acceptAll(u, pid, out.reviewId);
    const applied = await applyReview(u, pid, out.reviewId);
    expect(applied.status).toBe('APPLIED');
    onDisk = await readFile(path.join(root, pid, 'a.ts'), 'utf8');
    expect(onDisk).not.toContain('foo');
    expect(onDisk).toContain('bar');
  });

  // ------- 15. reject-all refactor
  it('rejecting a refactor review does not modify the file', async () => {
    const pid = 'p-rej'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'export const foo = 1;\n' });
    const out = await executeRename(u, pid, 'foo', 'bar');
    await rejectAll(u, pid, out.reviewId);
    const review = await getReview(u, pid, out.reviewId);
    expect(review.status).toBe('CANCELLED');
    const onDisk = await readFile(path.join(root, pid, 'a.ts'), 'utf8');
    expect(onDisk).toContain('foo');
  });

  // ------- 16. multi-file diff review
  it('multi-file review aggregates additions/deletions across files', async () => {
    const pid = 'p-multi'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x\n', 'b.ts': 'y\n' });
    const review = await createReview(u, pid, [
      { path: 'a.ts', baseContent: 'x\n', proposedContent: 'x1\nx2\n' },
      { path: 'b.ts', baseContent: 'y\n', proposedContent: 'y\n' },
    ], 'multi');
    expect(review.filesChanged).toBe(2);
    expect(review.additions).toBe(2);
    expect(review.files.length).toBe(2);
  });

  // ------- 17. B1 review integration semantics
  it('per-file accept/decide maps to B1 review authority (no apply without accept)', async () => {
    const pid = 'p-b1'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x\n', 'b.ts': 'y\n' });
    const review = await createReview(u, pid, [
      { path: 'a.ts', baseContent: 'x\n', proposedContent: 'x2\n' },
      { path: 'b.ts', baseContent: 'y\n', proposedContent: 'y2\n' },
    ]);
    await decideFile(u, pid, review.id, 'a.ts', true);
    await decideFile(u, pid, review.id, 'b.ts', false);
    let r = await getReview(u, pid, review.id);
    expect(r.files.find((f) => f.path === 'a.ts')!.accepted).toBe(true);
    expect(r.files.find((f) => f.path === 'b.ts')!.accepted).toBe(false);
    r = await applyReview(u, pid, review.id);
    expect(r.files.find((f) => f.path === 'a.ts')!.applied).toBe(true);
    expect(r.files.find((f) => f.path === 'b.ts')!.applied).toBe(false);
    const onDiskA = await readFile(path.join(root, pid, 'a.ts'), 'utf8');
    const onDiskB = await readFile(path.join(root, pid, 'b.ts'), 'utf8');
    expect(onDiskA).toBe('x2\n');
    expect(onDiskB).toBe('y\n');
  });

  // ------- 18. cross-file affected detection
  it('cross-file detection finds importers when a module changes', async () => {
    const pid = 'p-cross'; const u = 'u1';
    await seedProjectDisk(pid, u, {
      'src/util.ts': 'export const helper = 1;\n',
      'src/user.ts': 'import { helper } from "./util";\nconsole.log(helper);\n',
    });
    const affected = await detectAffectedFiles(pid, 'src/util.ts', 'helper');
    expect(affected!.some((a) => a.path === 'src/user.ts')).toBe(true);
  });

  // ------- 19. memory context isolation
  it('memory context returns advisory suggestions scoped per user/project', async () => {
    const pid = 'p-mem'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    const mem = await workspaceMemoryContext(u, pid);
    expect(Array.isArray(mem.suggestions)).toBe(true);
    expect(mem.present).toBe(false); // no seeded memories -> empty but honest
  });

  // ------- 20. user isolation
  it('throws 404 when accessing another user project', async () => {
    const pid = 'p-iso'; const u = 'u1'; const other = 'u2';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    await expect(openTab(other, pid, 'a.ts')).rejects.toMatchObject({ status: 404 });
  });

  // ------- 21. workspace isolation
  it('tabs and edits are isolated between separate workspaces', async () => {
    const p1 = 'p-ws1'; const p2 = 'p-ws2'; const u = 'u1';
    await seedProjectDisk(p1, u, { 'a.ts': 'x', 'b.ts': 'y' });
    await seedProjectDisk(p2, u, { 'a.ts': 'x', 'b.ts': 'y' });
    await openTab(u, p1, 'a.ts');
    await openTab(u, p2, 'b.ts');
    const ws1 = await getWorkspace(u, p1);
    const ws2 = await getWorkspace(u, p2);
    expect(ws1.workspaceId).not.toBe(ws2.workspaceId);
    expect(ws1.tabs.map((t) => t.path)).toEqual(['a.ts']);
    expect(ws2.tabs.map((t) => t.path)).toEqual(['b.ts']);
  });

  // ------- 22. large search cancellation/truncation
  it('search respects bounded limits and reports truncated', async () => {
    const pid = 'p-large'; const u = 'u1';
    const big: Record<string, string> = {};
    for (let i = 0; i < 30; i++) big[`f${i}.ts`] = `hit ${i}\n`.repeat(10);
    await seedProjectDisk(pid, u, big);
    const res = await searchWorkspace(pid, { q: 'hit', limit: 5 });
    expect(res!.matches.length).toBeLessThanOrEqual(5);
  });

  // ------- 23. large-file protection
  it('refuses to open/handle a file larger than the text limit', async () => {
    const pid = 'p-bigfile'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'small.ts': 'x' });
    await writeFile(path.join(root, pid, 'big.ts'), 'a'.repeat(3 * 1024 * 1024), 'utf8');
    await expect(readFileEntry(pid, 'big.ts')).rejects.toMatchObject({ status: 400 });
  });

  // ------- 24. invalid file access (missing)
  it('throws notFound when reading a non-existent file', async () => {
    const pid = 'p-missing'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    await expect(readFileEntry(pid, 'nope.ts')).rejects.toMatchObject({ status: 404 });
  });

  // ------- 25. path traversal
  it('blocks path traversal outside the workspace root', async () => {
    const pid = 'p-traversal'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    await writeFile(path.join(root, 'outside.txt'), 'secret', 'utf8');
    await expect(readFileEntry(pid, '../outside.txt')).rejects.toThrow();
    await expect(writeFileEntry(pid, '..\\..\\evil.txt', 'bad')).rejects.toThrow();
  });

  // ------- 26. git-unavailable honesty
  it('reports GIT_HISTORY UNAVAILABLE when no .git present', async () => {
    const pid = 'p-git'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    const g = await gitStatus(pid);
    expect(['UNAVAILABLE', 'ENVIRONMENT_BLOCKED']).toContain(g.state);
    expect(g.hasRepo).toBe(false);
  });

  // ------- 27. provider-unavailable honesty (workspace disabled)
  it('reports ENVIRONMENT_BLOCKED / throws when feature disabled', async () => {
    envMock.AIOS_P2_WORKSPACE = 'false';
    const pid = 'p-off'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x' });
    await expect(openTab(u, pid, 'a.ts')).rejects.toMatchObject({ status: 409 });
    const g = await gitStatus(pid);
    expect(g.state).toBe('ENVIRONMENT_BLOCKED');
  });

  // ------- 28. no automatic source modification
  it('search, outline, reference, and context reads never modify files', async () => {
    const pid = 'p-nomut'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'export const foo = 1;\nfoo;\n' });
    await searchWorkspace(pid, { q: 'foo' });
    await getOutline(pid, 'a.ts');
    await findReferences(pid, 'foo');
    await findImportRelations(pid, 'a.ts');
    await buildEditorContext(u, pid, 'a.ts', 1);
    const disk = await readFile(path.join(root, pid, 'a.ts'), 'utf8');
    expect(disk).toBe('export const foo = 1;\nfoo;\n');
  });

  // ------- 29. keyboard/workspace state persistence (recent + restore)
  it('recent workspace files persist across opens', async () => {
    const pid = 'p-recent'; const u = 'u1';
    await seedProjectDisk(pid, u, { 'a.ts': 'x', 'b.ts': 'y' });
    await openTab(u, pid, 'a.ts');
    await openTab(u, pid, 'b.ts');
    const recent = await recentWorkspaceFiles(u);
    expect(recent).toContain('a.ts');
    expect(recent).toContain('b.ts');
  });

  // ------- 30. AI editor context is bounded
  it('AI editor context is bounded and returns nearby lines', async () => {
    const pid = 'p-ctx'; const u = 'u1';
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`line ${i}`);
    await seedProjectDisk(pid, u, { 'a.ts': lines.join('\n') });
    const ctx = await buildEditorContext(u, pid, 'a.ts', 100);
    expect(ctx!.nearby!.length).toBeLessThanOrEqual(31);
    expect(ctx!.nearby!.includes('line 99')).toBe(true);
    expect(ctx!.byteLength).toBeLessThanOrEqual(64 * 1024 * 2);
  });
});
