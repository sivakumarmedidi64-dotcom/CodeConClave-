/**
 * CodeConClave — PKG-23 Deployment Memory.
 *
 * Connects deployment → version → commit → health/smoke result → failure →
 * rollback → subsequent fix using ONLY the records actually stored by the
 * release system (deployments + rollback_runs). The "rollback target" and
 * "subsequent fix" chain is derived from existing columns (status, verification,
 * rollbackTargetId, predecessorId) and memorycoding_links where a fix was
 * recorded. Nothing is fabricated: absent fields are reported null.
 */
import { withTenant, queryMany } from '../../shared/db.js';
import type { MemoryLinkRow, MemoryLinkKind } from './codingRecords.js';
import { listMemoryLinks, addMemoryLink } from './codingRecords.js';

interface DeploymentRow {
  id: string;
  project_id: string;
  environment: string;
  status: string;
  data: Record<string, unknown>;
  created_at: Date;
}

interface RollbackRow {
  id: string;
  project_id: string;
  current_deployment_id: string;
  target_deployment_id: string | null;
  status: string;
}

export interface DeploymentMemory {
  environment: string;
  status: string;
  version: string | null;
  commitSha: string | null;
  branch: string | null;
  verification: string | null;
  healthOutcome: string | null;
  smokeOutcome: string | null;
  failureReason: string | null;
  rollbackTarget: string | null;
  rollbackStatus: string | null;
  subsequentFixVersion: string | null;
  at: Date;
}

function parseData(d: Record<string, unknown>): {
  version: string | null;
  commitSha: string | null;
  branch: string | null;
  verification: string | null;
  healthOutcome: string | null;
  smokeOutcome: string | null;
  failureReason: string | null;
  rollbackTargetId: string | null;
} {
  const g = (d.git as Record<string, unknown>) ?? {};
  const health = (d.healthResult as Record<string, unknown>) ?? {};
  const smoke = (d.smokeResult as Record<string, unknown>) ?? {};
  return {
    version: typeof d.version === 'string' ? d.version : null,
    commitSha: typeof g.commitSha === 'string' ? g.commitSha : null,
    branch: typeof g.branch === 'string' ? g.branch : null,
    verification: typeof d.verification === 'string' ? d.verification : null,
    healthOutcome: typeof health.outcome === 'string' ? health.outcome : null,
    smokeOutcome: typeof smoke.outcome === 'string' ? smoke.outcome : null,
    failureReason: typeof d.failureReason === 'string' ? d.failureReason : null,
    rollbackTargetId: typeof d.rollbackTargetId === 'string' ? d.rollbackTargetId : null,
  };
}

export async function deploymentMemory(
  userId: string,
  projectId: string,
): Promise<{ items: DeploymentMemory[]; chain: Array<{ from: string; to: string; kind: MemoryLinkKind }> }> {
  const [deps, rollbacks] = await withTenant<[DeploymentRow[], RollbackRow[]]>(userId, async (q) => {
    const [d, r] = await Promise.all([
      q.query<DeploymentRow>(
        `SELECT id, project_id, environment, status, data, created_at FROM deployments
         WHERE project_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [projectId],
      ),
      q.query<RollbackRow>(
        `SELECT id, project_id, current_deployment_id, target_deployment_id, status FROM rollback_runs
         WHERE project_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [projectId],
      ),
    ]);
    return [d.rows, r.rows];
  });
  const links = await listMemoryLinks(userId, projectId);

  const byId = new Map(deps.map((d) => [d.id, d]));
  const items: DeploymentMemory[] = deps.map((d) => {
    const p = parseData(d.data);
    const rb = rollbacks.find((r) => r.current_deployment_id === d.id);
    // subsequent fix: a later OK deployment that succeeded after this failed one
    let fixVersion: string | null = null;
    if (d.status === 'FAILED' || d.status === 'ROLLED_BACK') {
      const idx = deps.findIndex((x) => x.id === d.id);
      for (let i = idx - 1; i >= 0; i--) {
        if (deps[i]!.status === 'VERIFIED' || deps[i]!.status === 'PARTIAL') {
          fixVersion = typeof deps[i]!.data.version === 'string' ? String(deps[i]!.data.version) : null;
          break;
        }
      }
    }
    return {
      environment: d.environment,
      status: d.status,
      version: p.version,
      commitSha: p.commitSha,
      branch: p.branch,
      verification: p.verification,
      healthOutcome: p.healthOutcome,
      smokeOutcome: p.smokeOutcome,
      failureReason: p.failureReason,
      rollbackTarget: p.rollbackTargetId ?? null,
      rollbackStatus: rb?.status ?? null,
      subsequentFixVersion: fixVersion,
      at: d.created_at,
    };
  });

  // derived evidence chain from actual records (no fabrication)
  const chain: Array<{ from: string; to: string; kind: MemoryLinkKind }> = [];
  for (const d of deps) {
    const rb = rollbacks.find((r) => r.current_deployment_id === d.id);
    if (rb && rb.target_deployment_id) {
      chain.push({ from: d.id, to: rb.target_deployment_id, kind: 'DEPLOYMENT_ROLLBACK' });
      const target = byId.get(rb.target_deployment_id);
      if (target) chain.push({ from: rb.target_deployment_id, to: d.id, kind: 'ROLLBACK_TARGET' });
    }
  }
  for (const l of links) chain.push({ from: l.from_ref, to: l.to_ref, kind: l.kind });

  return { items, chain: chain.slice(0, 60) };
}

export { addMemoryLink as recordDeploymentMemoryLink };
