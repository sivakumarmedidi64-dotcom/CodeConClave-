/**
 * CodeConClave — PKG-21 — Deployment records & history.
 * One immutable `deployments` record per release (stable identity, never silently
 * re-issued) + chronological, filtered history. Reads/writes the full record as a
 * single `data` jsonb (no secrets). Rows are project/workspace isolated.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { assertProjectAccess } from '../runtime/security.js';
import { redactOutput, redactUrl } from '../runtime/security.js';
import { resolveGitIdentity } from './git.js';
import type {
  DeploymentCreateInput,
  DeploymentRecord,
  DeploymentStatus,
  Environment,
  GateResult,
  ProviderId,
} from './types.js';

function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return redactUrl(url).slice(0, 500);
}

function guardSecrets(record: DeploymentRecord): DeploymentRecord {
  // Defensive: never persist leaked secret material (e.g. an accidental token in a
  // message or URL). Values are never accepted by these types, but redact anyway.
  const clone: DeploymentRecord = {
    ...record,
    failureReason: record.failureReason ? redactOutput(record.failureReason).slice(0, 2000) : null,
    deploymentUrl: record.deploymentUrl ? redactUrl(record.deploymentUrl).slice(0, 500) : null,
    buildResult: redactGate(record.buildResult),
    testResult: redactGate(record.testResult),
    healthResult: redactGate(record.healthResult),
    smokeResult: redactGate(record.smokeResult),
  };
  return clone;
}

function redactGate(g: GateResult | null): GateResult | null {
  if (!g) return null;
  return {
    ...g,
    message: g.message ? redactOutput(g.message).slice(0, 1000) : g.message,
    evidence: g.evidence ? redactOutput(g.evidence).slice(0, 2000) : g.evidence,
  };
}

/** Create a new immutable deployment record. Returns the persisted record. */
export async function createDeployment(
  userId: string,
  input: DeploymentCreateInput,
): Promise<DeploymentRecord> {
  await assertProjectAccess(userId, input.projectId);

  const id = newId(PREFIX.DEPLOYMENT);
  const now = new Date().toISOString();
  const git = resolveGitIdentity({
    branch: input.branch,
    commitSha: input.commitSha,
    commitTimestamp: input.commitTimestamp,
    author: input.author,
  });

  const record: DeploymentRecord = {
    id,
    projectId: input.projectId,
    workspaceId: input.workspaceId ?? null,
    environment: input.environment ?? 'development',
    provider: input.provider ?? 'unknown',
    service: input.service ?? 'backend',
    version: input.version,
    git,
    status: 'PLANNED',
    startedAt: now,
    completedAt: null,
    durationMs: null,
    buildResult: null,
    testResult: null,
    healthResult: null,
    smokeResult: null,
    verification: 'NOT_VERIFIED',
    deploymentUrl: sanitizeUrl(input.deploymentUrl),
    providerDeploymentId: input.providerDeploymentId ?? null,
    failureReason: null,
    predecessorId: input.predecessorId ?? null,
    rollbackSourceId: null,
    rollbackTargetId: null,
    profileId: input.profileId ?? null,
    planId: input.planId ?? null,
    verifyId: null,
    rollbackAvailable: false,
    createdAt: now,
  };

  const safe = guardSecrets(record);
  await withTenant(userId, async (q) =>
    q.query(
      `INSERT INTO deployments (id, project_id, workspace_id, environment, status, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), now())`,
      [id, input.projectId, input.workspaceId ?? null, record.environment, record.status, JSON.stringify(safe)],
    ),
  );
  return safe;
}

export interface DeploymentQuery {
  environment?: Environment;
  status?: DeploymentStatus;
  service?: string;
  limit?: number;
}

/** Chronological history, filtered, project-isolated. */
export async function listDeployments(userId: string, projectId: string, query: DeploymentQuery = {}): Promise<DeploymentRecord[]> {
  await assertProjectAccess(userId, projectId);
  const rows = await withTenant(userId, async (q) =>
    (await q.query<{ data: string }>(
      `SELECT data FROM deployments WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    )).rows,
  );
  let records = rows.map((r) => parseRow(r.data));
  if (query.environment) records = records.filter((d) => d.environment === query.environment);
  if (query.status) records = records.filter((d) => d.status === query.status);
  if (query.service) records = records.filter((d) => d.service === query.service);
  const limit = Math.min(query.limit ?? 100, 1000);
  return records.slice(0, limit);
}

/** Fetch a single deployment by immutable id (project-scoped). */
export async function getDeployment(userId: string, projectId: string, deploymentId: string): Promise<DeploymentRecord> {
  await assertProjectAccess(userId, projectId);
  const row = await withTenant(userId, async (q) =>
    (await q.query<{ id: string; data: string }>(
      `SELECT id, data FROM deployments WHERE id = $1 AND project_id = $2`,
      [deploymentId, projectId],
    )).rows[0] ?? null,
  );
  if (!row || row.id === undefined) throw AppError.notFound('Deployment', 'deployment_not_found');
  return parseRow(row.data);
}

/** The most recent VERIFIED release for an environment (rollback target source). */
export async function getLatestVerified(userId: string, projectId: string, environment: Environment): Promise<DeploymentRecord | null> {
  const records = await listDeployments(userId, projectId, { environment, status: 'VERIFIED', limit: 50 });
  return records.find((d) => d.verification === 'VERIFIED' && d.status === 'VERIFIED') ?? null;
}

/** The most recent deployment (any status) for an environment — "what is running". */
export async function getCurrentDeployment(userId: string, projectId: string, environment: Environment): Promise<DeploymentRecord | null> {
  const records = await listDeployments(userId, projectId, { environment, limit: 50 });
  return records[0] ?? null;
}

function parseRow(data: string): DeploymentRecord {
  const parsed = JSON.parse(data) as DeploymentRecord;
  return guardSecrets(parsed);
}

/** Persist a full record update (immutable id, mutable fields only). */
export async function updateDeployment(
  userId: string,
  projectId: string,
  deploymentId: string,
  patch: Partial<DeploymentRecord>,
): Promise<DeploymentRecord> {
  const existing = await getDeployment(userId, projectId, deploymentId);
  const next = guardSecrets({ ...existing, ...patch, id: existing.id, projectId: existing.projectId });
  await withTenant(userId, async (q) =>
    q.query(
      `UPDATE deployments SET status = $1, data = $2::jsonb, updated_at = now()
       WHERE id = $3 AND project_id = $4`,
      [next.status, JSON.stringify(next), deploymentId, projectId],
    ),
  );
  return next;
}

export function providerId(v: string | null | undefined): ProviderId {
  return (v as ProviderId) ?? 'unknown';
}
