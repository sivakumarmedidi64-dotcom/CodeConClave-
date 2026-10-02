/**
 * CodeConClave — PKG-21 — Release diff / change summary.
 * Evidence-based ONLY. No invented impact metrics: files, commits, lines and
 * findings are taken from supplied evidence (Git + quality/security/test sources).
 */
import type { ChangeItem, DeploymentRecord, ReleaseDiff } from './types.js';

export interface DiffEvidence {
  files?: { path: string; linesAdded?: number; linesRemoved?: number }[];
  commits?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  qualityFindingsCount?: number;
  securityFindingsCount?: number;
  testChanges?: string[];
}

export function buildReleaseDiff(
  record: Pick<DeploymentRecord, 'id' | 'version' | 'git' | 'predecessorId'>,
  evidence: DiffEvidence = {},
): ReleaseDiff {
  const files = evidence.files ?? [];
  const commits = evidence.commits ?? [];
  const testChanges = evidence.testChanges ?? [];

  const changes: ChangeItem[] = [];
  for (const f of files.slice(0, 200)) {
    changes.push({
      kind: 'file',
      label: f.path,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
    });
  }
  for (const c of commits.slice(0, 200)) {
    changes.push({ kind: 'commit', label: c });
  }
  for (const t of testChanges.slice(0, 200)) {
    changes.push({ kind: 'test', label: t });
  }

  const linesAdded = evidence.linesAdded ?? files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
  const linesRemoved = evidence.linesRemoved ?? files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
  const qualityFindings = Math.max(0, evidence.qualityFindingsCount ?? 0);
  const securityFindings = Math.max(0, evidence.securityFindingsCount ?? 0);

  if (qualityFindings > 0) {
    changes.push({ kind: 'finding', label: `${qualityFindings} quality finding(s) from quality intelligence` });
  }
  if (securityFindings > 0) {
    changes.push({ kind: 'finding', label: `${securityFindings} security finding(s) from security intelligence` });
  }

  const summary = `Release ${record.version}${record.git.commitSha ? ` (commit ${record.git.commitSha.slice(0, 7)})` : ''}: ` +
    `${files.length} file(s), ${commits.length} commit(s), +${linesAdded}/-${linesRemoved} line(s)` +
    (qualityFindings + securityFindings > 0 ? `, ${qualityFindings + securityFindings} finding(s)` : '');

  return {
    deploymentId: record.id,
    vsDeploymentId: record.predecessorId,
    version: record.version,
    commit: record.git.commitSha ?? null,
    changes: changes.slice(0, 500),
    filesChanged: files.length,
    commits: commits.length,
    linesAdded,
    linesRemoved,
    qualityFindings,
    securityFindings,
    testChanges: testChanges.length,
    summary,
  };
}
