/**
 * CodeConClave — Impact Oracle (blueprint #11).
 * "What breaks if I change this file?" answered with a ranked, evidence-backed
 * blast radius. Builds a file-level import graph from disk truth (never from
 * model output), resolves relative imports deterministically, inverts the
 * graph to imported-by edges, and runs a transitive BFS from the changed
 * file. Dynamic imports, `export ... from`, and `require()` are covered;
 * bare/external specifiers are ignored (with a count). Unreadable files are
 * skipped and counted — never guessed.
 */
import path from 'node:path';
import { listFilePaths, readSlice } from './fs.js';

export const IMPACT_MAX_FILES = 500;
const GRAPH_SLICE_BYTES = 256 * 1024;

const IMPORT_PATTERNS: RegExp[] = [
  /^[ \t]*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^[ \t]*export\s+(?:[^'"]*\s+from\s+)['"]([^'"]+)['"]/gm,
  /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

/** Raw specifiers a file imports (relative + bare, deduped, sorted). */
export function parseImports(content: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) out.add(m[1]!);
    }
  }
  return [...out].sort();
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

/** Resolve a relative specifier to a workspace relPath, or null when unresolvable/external. */
export function resolveImport(fromFile: string, spec: string, knownFiles: Set<string>): string | null {
  if (!isRelative(spec)) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = suffix ? `${base}${suffix}` : base;
    const normalized = candidate.replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (knownFiles.has(normalized)) return normalized;
  }
  return null;
}

export type ImportGraph = Map<string, Set<string>>; // file -> files it imports

/** Forward import graph over workspace relPaths (code-like files only). */
export function buildImportGraph(files: Map<string, string>): { graph: ImportGraph; external: number; unresolved: number } {
  const known = new Set(files.keys());
  const graph: ImportGraph = new Map();
  let external = 0;
  let unresolved = 0;
  for (const [file, content] of files) {
    const deps = new Set<string>();
    for (const spec of parseImports(content)) {
      if (!isRelative(spec)) {
        external += 1;
        continue;
      }
      const resolved = resolveImport(file, spec, known);
      if (resolved) deps.add(resolved);
      else unresolved += 1;
    }
    graph.set(file, deps);
  }
  return { graph, external, unresolved };
}

export interface ImpactEntry {
  file: string;
  depth: number;
  via: string[];
}

/**
 * Transitive blast radius: every file that (transitively) imports `changed`,
 * BFS over inverted edges. Cycles safe via visited set. Sorted by
 * (depth, file). `via` is one evidence chain (importer ← … ← changed).
 */
export function blastRadius(graph: ImportGraph, changed: string, maxFiles = IMPACT_MAX_FILES): ImpactEntry[] {
  const importedBy = new Map<string, Set<string>>();
  for (const [file, deps] of graph) {
    for (const dep of deps) {
      if (!importedBy.has(dep)) importedBy.set(dep, new Set());
      importedBy.get(dep)!.add(file);
    }
  }
  const visited = new Set<string>([changed]);
  const queue: Array<{ file: string; depth: number; via: string[] }> = [{ file: changed, depth: 0, via: [changed] }];
  const out: ImpactEntry[] = [];
  while (queue.length > 0 && out.length < maxFiles) {
    const current = queue.shift()!;
    for (const importer of [...(importedBy.get(current.file) ?? [])].sort()) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      const via = [...current.via, importer];
      out.push({ file: importer, depth: current.depth + 1, via });
      queue.push({ file: importer, depth: current.depth + 1, via });
    }
  }
  return out.sort((a, b) => a.depth - b.depth || (a.file < b.file ? -1 : 1));
}

export interface ImpactReport {
  changed: string;
  impacted: ImpactEntry[];
  scanned: number;
  unreadable: number;
  externalImports: number;
  unresolvedImports: number;
}

/** Full oracle run against a live project workspace on disk. */
export async function computeImpact(projectId: string, relPath: string): Promise<ImpactReport | null> {
  const paths = await listFilePaths(projectId);
  if (!paths) return null;
  const code = paths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));
  const files = new Map<string, string>();
  let unreadable = 0;
  for (const p of code.slice(0, 10000)) {
    try {
      const slice = await readSlice(projectId, p, GRAPH_SLICE_BYTES);
      if (!slice) {
        unreadable += 1;
        continue;
      }
      files.set(p, slice.content);
    } catch {
      unreadable += 1;
    }
  }
  const { graph, external, unresolved } = buildImportGraph(files);
  return {
    changed: relPath,
    impacted: blastRadius(graph, relPath),
    scanned: files.size,
    unreadable,
    externalImports: external,
    unresolvedImports: unresolved,
  };
}
