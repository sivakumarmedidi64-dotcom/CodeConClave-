/**
 * CodeConClave Local Agent — real project scanner (structural understanding).
 *
 * Deterministic, dependency-free source analysis inside a granted workspace:
 * walk real files → extract real imports (JS/TS + Python) → resolve them to
 * repo-relative targets → build the adjacency graph → report cycles and dead
 * files. No LLM, no network, no guessing: an edge exists only when the import
 * text resolves to a file that actually exists. External packages are listed
 * as external dependencies, never as phantom edges.
 *
 * Safety: the walker never leaves the workspace root (symlinked dirs are not
 * followed), skips dependency/build/output dirs, and is bounded by file count
 * and per-file bytes so one pathological tree cannot stall the agent.
 */
import { readdirSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep, basename, extname, posix } from 'node:path';
import { resolveWorkspacePath } from './policy.js';

export const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.codeconclave-backups', '__pycache__', '.venv', 'venv']);
const TEST_BASENAME = /(\.test|\.spec)$/;
const ENTRY_BASENAMES = new Set(['index', 'main', 'app', 'server', '__main__', '__init__']);

export interface ScannedFile {
  /** Workspace-relative path with forward slashes. */
  path: string;
  content: string;
}

export interface ProjectGraph {
  /** Repo-relative file ids. */
  nodes: string[];
  /** [from, to] repo-relative file ids (local imports only). */
  edges: Array<[string, string]>;
  /** Distinct dependency cycles (each a list of file ids). */
  cycles: string[][];
  /** Files with no inbound edges that are not entries or tests. */
  deadFiles: string[];
  /** Distinct external (third-party/bare) imports observed. */
  externalDeps: string[];
  truncated: boolean;
}

const IMPORT_PATTERNS: RegExp[] = [
  /(?:import|export)[^'"]*?['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /from\s+['"]([^'"]+)['"]/g,
];

/** Raw import specifiers found in source text (JS/TS-style). */
export function extractJsImports(content: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1]) out.push(match[1]);
    }
  }
  return out;
}

const PY_PATTERNS: RegExp[] = [/^\s*from\s+([\w.]+)\s+import\s+/gm, /^\s*import\s+([\w][\w., ]*)/gm];

/** Raw import specifiers found in Python source text. */
export function extractPyImports(content: string): string[] {
  const out: string[] = [];
  for (const re of PY_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1]) {
        for (const part of match[1].split(',')) {
          const name = part.trim().split(/\s+/)[0] ?? '';
          if (name) out.push(name);
        }
      }
    }
  }
  return out;
}

/** A specifier is local when it is explicitly relative (./ ../ or . leading dotted python). */
export function isLocalSpecifier(spec: string, ext: string): boolean {
  if (ext === '.py') return spec.startsWith('.');
  return spec.startsWith('.');
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Resolve a relative specifier against the importing file to a repo-relative
 * id, probing real extensions. Returns null when the target does not exist
 * (never a phantom edge) or when it escapes the scanned set.
 */
function resolveLocalTarget(fromId: string, spec: string, ext: string, known: Set<string>): string | null {
  const fromDir = posix.dirname(fromId);
  if (ext === '.py') {
    // Dotted relative: leading dots climb, remainder is path/module.
    const dots = spec.match(/^\.+/)?.[0].length ?? 0;
    const rest = spec.slice(dots).split('.').filter(Boolean).join('/');
    const base = posix.normalize(posix.join(fromDir, ...Array(dots > 1 ? dots - 1 : 0).fill('..'), rest));
    if (base.startsWith('..')) return null;
    const candidates = [base, `${base}.py`, `${base}/__init__.py`];
    for (const c of candidates) {
      if (known.has(c)) return c;
    }
    return null;
  }
  // Repo-relative ids are posix-style: join with posix semantics so the math
  // never touches the host drive or CWD (path.resolve would do both).
  const base = posix.normalize(posix.join(fromDir, spec));
  if (base === '.' || base.startsWith('..')) return null;
  const candidates = [base];
  const knownExts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
  if (!extname(base)) {
    for (const e of knownExts) candidates.push(base + e);
    for (const e of knownExts) candidates.push(`${base}/index${e}`);
  } else if (extname(base) === '.js' || extname(base) === '.mjs' || extname(base) === '.cjs') {
    // TS sources importing compiled names (./x.js for ./x.ts).
    candidates.push(base.replace(/\.(js|mjs|cjs)$/, '.ts'), base.replace(/\.(js|mjs|cjs)$/, '.tsx'));
  }
  for (const c of candidates) {
    if (known.has(c)) return c;
  }
  return null;
}

/** Pure graph build over in-memory files (no fs — unit-testable). */
export function buildGraph(files: ScannedFile[]): ProjectGraph {
  const known = new Set(files.map((f) => f.path));
  const edges: Array<[string, string]> = [];
  const external = new Set<string>();
  for (const file of files) {
    const ext = extname(file.path);
    const specs = ext === '.py' ? extractPyImports(file.content) : extractJsImports(file.content);
    const seen = new Set<string>();
    for (const spec of specs) {
      if (!isLocalSpecifier(spec, ext)) {
        external.add(spec.split('/')[0] ?? spec);
        continue;
      }
      const target = resolveLocalTarget(file.path, spec, ext, known);
      if (target && target !== file.path && !seen.has(target)) {
        seen.add(target);
        edges.push([file.path, target]);
      }
    }
  }
  const nodes = [...known].sort();
  return {
    nodes,
    edges,
    cycles: findCycles(nodes, edges),
    deadFiles: findDeadFiles(nodes, edges),
    externalDeps: [...external].sort(),
    truncated: false,
  };
}

/** Distinct elementary cycles via iterative DFS (bounded, deterministic order). */
export function findCycles(nodes: string[], edges: Array<[string, string]>): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [from, to] of edges) adj.get(from)?.push(to);
  for (const list of adj.values()) list.sort();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (node: string): void => {
    stack.push(node);
    onStack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (onStack.has(next)) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!done.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    onStack.delete(node);
    done.add(node);
  };
  const done = new Set<string>();
  for (const n of [...nodes].sort()) {
    if (!done.has(n)) visit(n);
  }
  return cycles;
}

/** Files nobody imports that are not entries and not tests. */
export function findDeadFiles(nodes: string[], edges: Array<[string, string]>): string[] {
  const inbound = new Set(edges.map(([, to]) => to));
  return nodes
    .filter((n) => !inbound.has(n))
    .filter((n) => {
      const base = basename(n, extname(n));
      if (ENTRY_BASENAMES.has(base)) return false;
      if (TEST_BASENAME.test(base)) return false;
      return true;
    })
    .sort();
}

export interface ScanOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
}

/** Walk a real workspace dir (no symlink following, bounded) into ScannedFiles. */
export function collectScannableFiles(rootAbs: string, opts: ScanOptions = {}): { files: ScannedFile[]; truncated: boolean } {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = opts.maxBytesPerFile ?? 512 * 1024;
  const files: ScannedFile[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !SCAN_EXTENSIONS.has(extname(entry.name))) continue;
      try {
        const st = statSync(full);
        if (st.size > maxBytes) continue;
        const real = realpathSync(full);
        const rel = relative(rootAbs, real);
        if (!rel || rel.startsWith('..')) continue;
        files.push({ path: toPosix(rel), content: readFileSync(real, 'utf8') });
      } catch {
        /* unreadable — skip honestly */
      }
    }
  };
  walk(rootAbs);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, truncated };
}

/** Full scan of a granted workspace root (containment enforced by the caller via workspaceFor). */
export function scanWorkspace(rootAbs: string, opts: ScanOptions = {}): ProjectGraph & { fileCount: number } {
  const { files, truncated } = collectScannableFiles(rootAbs, opts);
  const graph = buildGraph(files);
  return { ...graph, truncated: graph.truncated || truncated, fileCount: files.length };
}
