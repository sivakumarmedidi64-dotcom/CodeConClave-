/**
 * CodeConClave — #34 Documentation Drift Detector (PKG-17).
 * Compare documentation text (Markdown/README/docs) against the workspace's
 * source symbols and file paths to surface drift: referenced symbols/files that
 * no longer exist, and stale references. Deterministic and advisory — no docs
 * are edited.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { DocDriftFinding, DocDriftReport, DocDriftKind, TruthfulnessState } from './types.js';

const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;

function isDocFile(path: string): boolean {
  return DOC_EXT.test(path) || /(^|\/)(readme|contributing|architecture|docs?)(\.|$)/i.test(path);
}

function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  const inline = text.match(/`([a-zA-Z0-9_./\-]+(?:\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|sh|sql|json|md))?)`/g);
  if (inline) {
    for (const r of inline) {
      const cleaned = r.replace(/[`]/g, '').trim();
      if (cleaned && cleaned.length <= 200) refs.add(cleaned);
    }
  }
  const link = text.match(/\[[^\]]+\]\(([^)#]+)\)/g);
  if (link) {
    for (const r of link) {
      const m = /\]\(([^)#]+)\)/.exec(r);
      const grp = m?.[1];
      if (m && grp && /\.(ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|sh|sql|json|md)$/i.test(grp)) refs.add(grp);
    }
  }
  return Array.from(refs);
}

function titleCase(kind: DocDriftKind): string {
  switch (kind) {
    case 'SYMBOL_NOT_FOUND': return 'referenced symbol not found in source';
    case 'FILE_NOT_FOUND': return 'referenced file not found in workspace';
    case 'STALE_REFERENCE': return 'stale/renamed reference';
    case 'MISSING_DOCUMENTATION': return 'undocumented public surface';
    default: return kind;
  }
}

export async function buildDocDriftReport(
  userId: string,
  projectId: string,
): Promise<DocDriftReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const state: TruthfulnessState = 'HEURISTIC';

  const sources = analyzable.filter((f) => !isDocFile(f.path));
  const docs = analyzable.filter((f) => isDocFile(f.path));

  const sourcePaths = new Set(sources.map((f) => f.path));
  const sourceBase = new Set(sources.map((f) => f.path.replace(/^.*[\\/]/, '').toLowerCase()));

  // Symbol index: identifiers defined in source (rough).
  const definedSymbols = new Set<string>();
  for (const s of sources) {
    for (const m of s.text.matchAll(/\b(?:export\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      if (m[1]) definedSymbols.add(m[1]);
    }
  }

  const findings: DocDriftFinding[] = [];
  for (const doc of docs) {
    const refs = extractReferences(doc.text);
    for (const ref of refs) {
      if (findings.length >= 300) break;
      without:
      if (ref.includes('/') || /\.\w+$/.test(ref)) {
        const base = ref.toLowerCase().replace(/^[./]*/, '');
        const fileExists = sourcePaths.has(ref) || sourceBase.has(base.replace(/^.*[\\/]/, ''));
        if (!fileExists) {
          findings.push({
            id: newId(PREFIX.DEVWORKFLOW_DOCDRIFT),
            docFilePath: doc.path,
            kind: 'FILE_NOT_FOUND',
            title: `"${ref}" referenced but no matching source file`,
            referenced: ref,
            evidence: `found in ${doc.path}`,
            severity: 'MEDIUM',
            state,
          });
        }
      } else {
        const symbol = ref;
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol) && !definedSymbols.has(symbol)) {
          findings.push({
            id: newId(PREFIX.DEVWORKFLOW_DOCDRIFT),
            docFilePath: doc.path,
            kind: 'SYMBOL_NOT_FOUND',
            title: `symbol "${symbol}" documented but not defined in source`,
            referenced: symbol,
            evidence: `found in ${doc.path}`,
            severity: 'MEDIUM',
            state,
          });
        }
      }
    }
  }

  const highSeverityCount = findings.filter((f) => f.severity === 'HIGH').length;
  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    docsScanned: docs.length,
    sourceFilesScanned: sources.length,
    findings,
    totalFindings: findings.length,
    highSeverityCount,
    state,
    limitations: [
      'Reference extraction is heuristic (backticks/links); plausible mismatches may be reported.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Advisory only — no documentation is modified.',
    ],
  };
}