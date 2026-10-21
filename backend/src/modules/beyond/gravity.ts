/**
 * CodeConClave — Gravity Map (Beyond agentic #2, from "semantic memory
 * gravitation"). Files that depend on each other pull together. From the
 * REAL import statements of a project (JS/TS and Python), CodeConClave builds
 * the dependency graph and shows:
 *   - constellations: groups of files that belong together (label propagation)
 *   - gravity wells: the files everything else depends on
 *   - drifters: files nothing imports and that import nothing
 *   - misplaced files: files mostly used by another folder (they belong there)
 * Nothing is moved automatically — these are suggestions with the evidence.
 */
import { extOf } from './source.js';

export interface GravityNode {
  path: string;
  folder: string;
  inDegree: number;
  outDegree: number;
  cluster: number;
}

export interface Constellation {
  id: number;
  files: string[];
  mainFolder: string;
  /** Internal edges / all edges touching the cluster (1 = fully self-contained). */
  cohesion: number;
}

export interface GravityMap {
  nodes: GravityNode[];
  edges: { from: string; to: string }[];
  constellations: Constellation[];
  wells: { path: string; dependents: number }[];
  drifters: string[];
  misplaced: { path: string; folder: string; pulledTo: string; share: number }[];
  unresolved: number;
}

const JS_EXT = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
const ENTRY = /(^|\/)(index|main|app|server|cli|setup|vite\.config|webpack\.config|manage)\.[a-z]+$|(\.test|\.spec)\.[a-z]+$|(^|\/)__init__\.py$/i;

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

/** Collapse ./ and ../ in a path. Pure. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Module specifiers a file imports (JS/TS: import/export-from/require/dynamic import; Python: import/from). Pure. */
export function importsOf(path: string, text: string): string[] {
  const ext = extOf(path);
  const specs: string[] = [];
  if (JS_EXT.includes(ext) || ext === 'vue' || ext === 'svelte') {
    const re = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of text.matchAll(re)) specs.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  } else if (ext === 'py') {
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\b/gm)) specs.push(`py:${m[1]}`);
    for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const mod of m[1]!.split(',')) specs.push(`py:${mod.trim()}`);
  }
  return specs;
}

/** Resolve one specifier to a project file, or null (packages, unknown). Pure. */
export function resolveImport(fromPath: string, spec: string, files: Set<string>): string | null {
  if (spec.startsWith('py:')) {
    const mod = spec.slice(3);
    const lead = /^\.+/.exec(mod)?.[0].length ?? 0;
    let base: string;
    if (lead > 0) {
      let dir = folderOf(fromPath);
      for (let i = 1; i < lead; i++) dir = folderOf(dir);
      base = normalizePath(`${dir === '.' ? '' : dir}/${mod.slice(lead).replace(/\./g, '/')}`);
    } else base = mod.replace(/\./g, '/');
    for (const cand of [`${base}.py`, `${base}/__init__.py`]) if (files.has(cand)) return cand;
    // Absolute imports may be rooted at a source folder (e.g. src/pkg/mod.py).
    const tail = `/${base}.py`;
    for (const f of files) if (f.endsWith(tail)) return f;
    return null;
  }
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // a package, not a project file
  const dir = folderOf(fromPath);
  const raw = normalizePath(spec.startsWith('/') ? spec : `${dir === '.' ? '' : dir}/${spec}`);
  const noJs = raw.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [raw, ...JS_EXT.map((e) => `${noJs}.${e}`), ...JS_EXT.map((e) => `${raw}/index.${e}`)];
  for (const c of candidates) if (files.has(c)) return c;
  return null;
}

/** Build the gravity map from files. Pure and deterministic (exported for tests). */
export function buildGravityMap(files: { path: string; text: string }[], maxNodes = 400): GravityMap {
  const code = files.filter((f) => [...JS_EXT, 'vue', 'svelte', 'py'].includes(extOf(f.path))).slice(0, maxNodes);
  const paths = new Set(code.map((f) => f.path));
  const edgesSet = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  let unresolved = 0;
  for (const f of code) {
    for (const spec of importsOf(f.path, f.text)) {
      const to = resolveImport(f.path, spec, paths);
      if (!to) {
        if (spec.startsWith('.')) unresolved += 1;
        continue;
      }
      if (to === f.path) continue;
      const key = `${f.path}\u0000${to}`;
      if (edgesSet.has(key)) continue;
      edgesSet.add(key);
      edges.push({ from: f.path, to });
    }
  }

  const neighbours = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const p of paths) {
    neighbours.set(p, []);
    inDeg.set(p, 0);
    outDeg.set(p, 0);
  }
  for (const e of edges) {
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
    inDeg.set(e.to, inDeg.get(e.to)! + 1);
    outDeg.set(e.from, outDeg.get(e.from)! + 1);
  }

  // Label propagation, deterministic: sorted order, ties → smallest label.
  const sorted = [...paths].sort();
  const label = new Map(sorted.map((p, i) => [p, i]));
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (const p of sorted) {
      const ns = neighbours.get(p)!;
      if (ns.length === 0) continue;
      const counts = new Map<number, number>();
      for (const n of ns) counts.set(label.get(n)!, (counts.get(label.get(n)!) ?? 0) + 1);
      let best = label.get(p)!;
      let bestCount = counts.get(best) ?? 0;
      for (const [l, c] of counts) if (c > bestCount || (c === bestCount && l < best)) {
        best = l;
        bestCount = c;
      }
      if (best !== label.get(p)) {
        label.set(p, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Constellations = labels with 2+ files; renumber by size.
  const groups = new Map<number, string[]>();
  for (const p of sorted) {
    if (neighbours.get(p)!.length === 0) continue;
    const l = label.get(p)!;
    groups.set(l, [...(groups.get(l) ?? []), p]);
  }
  const ordered = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  const clusterOf = new Map<string, number>();
  const constellations: Constellation[] = ordered.map((filesIn, idx) => {
    for (const f of filesIn) clusterOf.set(f, idx + 1);
    const set = new Set(filesIn);
    let internal = 0;
    let external = 0;
    for (const e of edges) {
      const a = set.has(e.from);
      const b = set.has(e.to);
      if (a && b) internal += 1;
      else if (a || b) external += 1;
    }
    const folderCount = new Map<string, number>();
    for (const f of filesIn) folderCount.set(folderOf(f), (folderCount.get(folderOf(f)) ?? 0) + 1);
    const mainFolder = [...folderCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    return { id: idx + 1, files: filesIn, mainFolder, cohesion: internal + external ? Math.round((internal / (internal + external)) * 100) / 100 : 1 };
  });

  const wells = sorted
    .map((p) => ({ path: p, dependents: inDeg.get(p)! }))
    .filter((w) => w.dependents >= 2)
    .sort((a, b) => b.dependents - a.dependents || a.path.localeCompare(b.path))
    .slice(0, 10);

  const drifters = sorted.filter((p) => neighbours.get(p)!.length === 0 && !ENTRY.test(p));

  // Misplaced: a file gravitates toward the files that USE it (not the files it
  // uses — a component importing utilities does not belong in utils). At least
  // 3 dependents, 2/3+ of them in ONE other folder, pulling at least twice as
  // hard as the file's own folder.
  const dependents = new Map<string, string[]>(sorted.map((p) => [p, []]));
  for (const e of edges) dependents.get(e.to)!.push(e.from);
  const misplaced: GravityMap['misplaced'] = [];
  for (const p of sorted) {
    const users = dependents.get(p)!;
    if (users.length < 3 || ENTRY.test(p)) continue;
    const own = folderOf(p);
    const byFolder = new Map<string, number>();
    for (const u of users) byFolder.set(folderOf(u), (byFolder.get(folderOf(u)) ?? 0) + 1);
    const [topFolder, topCount] = [...byFolder.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    if (topFolder !== own && topCount / users.length >= 2 / 3 && topCount >= 2 * (byFolder.get(own) ?? 0)) {
      misplaced.push({ path: p, folder: own, pulledTo: topFolder, share: Math.round((topCount / users.length) * 100) / 100 });
    }
  }

  return {
    nodes: sorted.map((p) => ({ path: p, folder: folderOf(p), inDegree: inDeg.get(p)!, outDegree: outDeg.get(p)!, cluster: clusterOf.get(p) ?? 0 })),
    edges,
    constellations,
    wells,
    drifters,
    misplaced: misplaced.slice(0, 20),
    unresolved,
  };
}
