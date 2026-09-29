/**
 * CodeConClave — repository secret-surface scanner (SecretGuard patterns).
 *
 * Usage:  npm run secret:scan              (scans the repo from the root)
 *         npm run secret:scan -- --root <dir>   (scan a specific directory)
 *
 * Scans the repository source surface for the known secret patterns (the same
 * SECRET_PATTERNS used by SecretGuard). It NEVER prints a discovered value —
 * findings are reported as PATH + KIND + COUNT only.
 *
 * Exit codes:
 *   0  repository is clean (no findings)
 *   1  findings detected (e.g. a planted fake secret)
 *   2  operational error (root missing, unreadable)
 *
 * Exclusions (by design):
 *   - gitignored env sources (.env, .env.<suffix>*) — the legitimate
 *     non-committed environment mechanism; never scanned or reported
 *   - dependency/build/IDE directories (node_modules, dist, build, coverage,
 *     .git, .vite, .cache)
 *   - paths allowlisted in <repoRoot>/.secret-scan-allowlist.json (intentional
 *     test fixtures, documented per file with a reason)
 *   - binary/media archives (never contain text secret patterns)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS, scanContentForSecrets } from '../modules/secretGuard/service.js';

const __dirname = pathDirname();
function pathDirname(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

const repoRootDefault = resolve(__dirname, '..', '..', '..');
const ALLOWLIST_FILE = '.secret-scan-allowlist.json';

// The scanned surface: workspace source trees + CI metadata. Docs, lockfiles,
// gitignored env files and scratch notes are intentionally outside this surface
// (the CB2 inventory covers the whole tree separately).
const DEFAULT_SCAN_ROOTS = [
  'backend/src',
  'frontend/src',
  'shared/src',
  'local-agent/src',
  'desktop/src',
  '.github',
  'scripts',
];

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.vite', '.cache']);
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'avif', 'bmp', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'tgz', '7z', 'rar',
  'node', 'mp3', 'mp4', 'mov', 'mkv', 'wasm',
  'lock', 'map', 'dll', 'so', 'dylib', 'exe', 'bin', 'pak',
]);

interface AllowlistEntry {
  path: string;
  reason: string;
  kinds?: string[];
}

interface AllowlistRule {
  path: string;
  reason: string;
  kinds: Set<string> | null;
}

/** Relative paths of source-surface roots (posix). Empty when root is not a repo. */
function resolveScanRoots(repoRoot: string): string[] {
  const roots: string[] = [];
  for (const rel of DEFAULT_SCAN_ROOTS) {
    const abs = join(repoRoot, ...rel.split('/'));
    if (existsSync(abs)) roots.push(resolve(abs));
  }
  return roots;
}

function loadAllowlist(repoRoot: string): Map<string, AllowlistRule> {
  const allow = new Map<string, AllowlistRule>();
  const file = join(repoRoot, ALLOWLIST_FILE);
  if (!existsSync(file)) return allow;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { files?: AllowlistEntry[] };
    for (const entry of parsed.files ?? []) {
      const rel = entry.path.replace(/\\/g, '/');
      allow.set(rel, {
        path: rel,
        reason: entry.reason,
        kinds: entry.kinds ? new Set(entry.kinds) : null,
      });
    }
  } catch (err) {
    process.stderr.write(`[secret-scan] warning: unreadable ${ALLOWLIST_FILE}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return allow;
}

function isExcludedDir(entryName: string): boolean {
  return EXCLUDED_DIRS.has(entryName);
}

function isExcludedFile(baseName: string): boolean {
  if (baseName === '.env' || baseName.startsWith('.env.') || baseName === ALLOWLIST_FILE) return true;
  return false;
}

function isBinary(relPath: string, baseName: string): boolean {
  const ext = extname(baseName).replace(/^\./, '').toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  // Heuristic: contain a NUL byte anywhere in the first chunk.
  return false;
}

interface FileFinding {
  path: string;
  kinds: Map<string, number>;
  total: number;
}

export function collectFindings(root: string, allowlist: Map<string, AllowlistRule>, prefixRel = ''): { findings: FileFinding[]; scannedFiles: number; skipped: number } {
  const findings: FileFinding[] = [];
  let scannedFiles = 0;
  let skipped = 0;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, '/');
      const allowRel = prefixRel ? `${prefixRel}/${rel}` : rel;
      if (entry.isDirectory()) {
        if (!isExcludedDir(entry.name)) walk(full);
        else skipped++;
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedFile(entry.name)) {
        skipped++;
        continue;
      }
      if (isBinary(rel, entry.name)) {
        skipped++;
        continue;
      }
      const rule = allowlist.get(allowRel);
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      if (content.length > 10 * 1024 * 1024) {
        skipped++;
        continue;
      }
      let hits = scanContentForSecrets(content);
      if (hits.length > 0) {
        if (rule && rule.kinds) {
          // Suppress only the allowlisted kinds; other kinds still count.
          hits = hits.filter((h) => !rule.kinds!.has(h.kind));
        }
      }
      if (hits.length > 0) {
        scannedFiles++;
        const kinds = new Map<string, number>();
        for (const h of hits) kinds.set(h.kind, (kinds.get(h.kind) ?? 0) + 1);
        findings.push({
          path: allowRel,
          kinds,
          total: hits.length,
        });
      } else {
        scannedFiles++;
      }
    }
  };

  walk(root);
  return { findings, scannedFiles, skipped };
}

export function renderFindings(findings: FileFinding[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    const kinds = [...f.kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`)
      .join(' ');
    lines.push(`FINDING ${f.path} :: ${kinds}`);
  }
  return lines.join('\n');
}

export async function runSecretScan(cwd: string, singleDir = false): Promise<number> {
  const root = resolve(cwd);
  if (!existsSync(root)) {
    process.stderr.write(`[secret-scan] root directory not found: ${root}\n`);
    return 2;
  }
  const allowlist = loadAllowlist(root);
  const roots = singleDir ? [root] : resolveScanRoots(root);
  if (roots.length === 0) {
    process.stderr.write('[secret-scan] no scan roots found under the given root\n');
    return 2;
  }
  let totalFiles = 0;
  let totalSkipped = 0;
  const findings: FileFinding[] = [];
  for (const scanRoot of roots) {
    const rel = singleDir ? '' : (relative(root, scanRoot).replace(/\\/g, '/') || '<root>');
    const { findings: partFindings, scannedFiles, skipped } = collectFindings(scanRoot, allowlist, rel);
    for (const f of partFindings) {
      findings.push({ path: f.path, kinds: f.kinds, total: f.total });
    }
    totalFiles += scannedFiles;
    totalSkipped += skipped;
  }
  const totalFindings = findings.reduce((a, f) => a + f.total, 0);

  // Values are NEVER printed: only path + kind-count.
  if (findings.length > 0) {
    process.stdout.write(renderFindings(findings) + '\n');
  }
  process.stdout.write(
    `secret-scan: files=${totalFiles} skipped=${totalSkipped} findings=${totalFindings}\n`,
  );
  return totalFindings > 0 ? 1 : 0;
}

// eslint-disable-next-line no-console
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const dirIdx = process.argv.indexOf('--dir');
  if (dirIdx >= 0 && process.argv[dirIdx + 1]) {
    const dir = resolve(process.argv[dirIdx + 1]!);
    runSecretScan(dir, true)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        process.stderr.write(`[secret-scan] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      });
  } else {
    const rootIdx = process.argv.indexOf('--root');
    const cwd = rootIdx >= 0 && process.argv[rootIdx + 1] ? resolve(process.argv[rootIdx + 1]!) : repoRootDefault;
    runSecretScan(cwd)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        process.stderr.write(`[secret-scan] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
      });
  }
}