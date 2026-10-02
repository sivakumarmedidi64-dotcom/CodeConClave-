/**
 * CodeConClave — PKG-22 Advanced Code Workspace — cross-file change intelligence.
 * When a change touches a file, detect POTENTIALLY AFFECTED FILES from actual
 * import/usage/reference evidence. Only DETECT → PROPOSE (never auto-modify).
 */
import { listFilePaths, readFileEntry } from './fs.js';
import { findImportRelations } from './symbols.js';
import { workspaceEnabled } from './config.js';
import { AppError } from '../../shared/errors.js';

const IMPORT_RE = /^import\s+(?:(\{[^}]+\}|\w+|\*\s+as\s+\w+)\s+from\s+)?['"](.+?)['"]/gm;

export interface AffectedFile {
  path: string;
  relation: 'imports' | 'imported-by' | 'uses-symbol';
  evidence: string;
}

export async function detectAffectedFiles(projectId: string, relPath: string, symbolHint?: string): Promise<AffectedFile[] | null> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');
  const paths = await listFilePaths(projectId);
  if (!paths) return null;

  const affected: AffectedFile[] = [];
  const baseDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
  const baseStem = relPath.split('/').pop()?.replace(/\.[^.]+$/, '');

  // 1) Files that import this module (imported-by)
  for (const p of paths) {
    if (p === relPath) continue;
    const file = await readFileEntry(projectId, p);
    if (!file || file.binary) continue;
    const imports = findImportRelations(projectId, p) instanceof Promise ? [] : [];
    // scan imports directly
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      IMPORT_RE.lastIndex = 0;
      const m = IMPORT_RE.exec(lines[i]!);
      if (m) {
        const target = normalizeImport(m[2]!, baseDir, baseStem ?? '');
        if (target === relPath || m[2]!.includes(baseStem ?? '') || target === baseStem) {
          if (!affected.some((a) => a.path === p)) {
            affected.push({ path: p, relation: 'imported-by', evidence: lines[i]!.trim().slice(0, 200) });
          }
        }
      }
    }
  }

  // 2) Symbol usage hint across files (uses-symbol)
  if (symbolHint) {
    const re = new RegExp(`\\b${symbolHint}\\b`, 'g');
    for (const p of paths) {
      if (p === relPath || affected.some((a) => a.path === p)) continue;
      const file = await readFileEntry(projectId, p);
      if (!file || file.binary) continue;
      re.lastIndex = 0;
      if (re.test(file.content) && !affected.some((a) => a.path === p)) {
        affected.push({ path: p, relation: 'uses-symbol', evidence: `${symbolHint} referenced` });
      }
    }
  }

  return affected.slice(0, 100);
}

function normalizeImport(importPath: string, baseDir: string, _baseStem: string): string {
  if (importPath.startsWith('.')) {
    const parts = importPath.replace(/^\.\//, '').replace(/^\.\.\//, '../');
    const joined = baseDir === '.' ? parts : `${baseDir}/${parts}`;
    return joined.replace(/\/+/g, '/');
  }
  return importPath;
}