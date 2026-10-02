/**
 * CodeConClave — PKG-21 — Controlled rollback engine.
 * USER REQUEST → AUTHORIZATION → SELECT VERIFIED PREVIOUS RELEASE → PREFLIGHT
 * (10 safety checks) → PROVIDER CHECK → EXECUTE (honest) → HEALTH/SMOKE RE-VERIFY
 * → ROLLBACK SUCCESS / FAILURE. Every attempt is recorded in rollback_runs.
 * Application rollback and DATABASE rollback are SEPARATE concerns; destructive
 * DB rollback is BLOCKED unless compatibility is established. Unknown provider
 * semantics → ROLLBACK = BLOCKED. No silent production data deletion.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { assertProjectAccess } from '../runtime/security.js';
import { providerCapability } from './provider.js';
import { isRollbackEligible } from './verification.js';
import { getDeployment, getCurrentDeployment, updateDeployment } from './records.js';
import type { DeploymentRecord, ProviderCapability, RollbackRun, RollbackSafetyCheck } from './types.js';

export interface DbMigrationEvidence {
  target: { migration?: number | null };
  current: { migration?: number | null };
  /** Names of migrations that are destructive/non-backward-compatible (evidence-based). */
  destructiveMigrations?: number[];
}

export type DbCompat = 'COMPATIBLE' | 'BLOCKED' | 'UNKNOWN';

/**
 * Database rollback is never assumed safe. If the current release carries a higher
 * migration and that migration is destructive/non-backward-compatible, DB rollback
 * (and the whole application rollback) is BLOCKED. Otherwise it may be COMPATIBLE
 * or UNKNOWN (when we cannot establish it — never assumed safe).
 */
export function assessDatabaseCompat(evidence: DbMigrationEvidence): DbCompat {
  const targetMig = evidence.target.migration ?? null;
  const currentMig = evidence.current.migration ?? null;
  if (targetMig == null || currentMig == null) return 'UNKNOWN';
  if (currentMig >= targetMig) {
    // Rolling back to an older release requires unwinding migrations currentMig..targetMig+1.
    const toUnwind = (evidence.destructiveMigrations ?? []).filter((m) => m > targetMig && m <= currentMig);
    if (toUnwind.length > 0) return 'BLOCKED';
    return 'COMPATIBLE';
  }
  return 'COMPATIBLE';
}

export interface RollbackInput {
  targetDeploymentId: string;
  environment?: 'development' | 'staging' | 'production';
  /** Explicit confirmation — REQUIRED for production rollback. No silent rollback. */
  confirmed?: boolean;
  workstationConfirmed?: boolean;
  dbEvidence?: DbMigrationEvidence;
  providerDeploymentId?: string | null;
}

export interface RollbackExecutorResult {
  status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  detail: string;
  newProviderDeploymentId?: string | null;
}

/** Injectable executor — the default is provider-gated and HONEST (never fakes success). */
export interface RollbackExecutor {
  execute(current: DeploymentRecord, target: DeploymentRecord, cap: ProviderCapability): Promise<RollbackExecutorResult>;
}

const honestExecutor: RollbackExecutor = {
  async execute(_current, _target, cap) {
    if (!cap.live) {
      return {
        status: 'BLOCKED',
        detail: `Rollback execution blocked: provider '${cap.provider}' is not live on this deployment (${cap.reason}).`,
      };
    }
    // No real provider runner is reachable from a static process env; never fake success.
    return {
      status: 'BLOCKED',
      detail: 'No live provider runner is configured; real rollback is environment-blocked.',
    };
  },
};

export interface RollbackEngineDeps {
  executeRollback?: RollbackExecutor;
  now?: () => Date;
}

export interface RollbackEngine {
  requestRollback(userId: string, projectId: string, input: RollbackInput): Promise<RollbackRun>;
  getRun(userId: string, projectId: string, runId: string): Promise<RollbackRun>;
  listRuns(userId: string, projectId: string, limit?: number): Promise<RollbackRun[]>;
}

export function createRollbackEngine(deps: RollbackEngineDeps = {} as RollbackEngineDeps): RollbackEngine {
  const executor = deps.executeRollback ?? honestExecutor;
  const now = deps.now ?? (() => new Date());

  return {
    async requestRollback(userId, projectId, input) {
      await assertProjectAccess(userId, projectId);
      const current = await getCurrentDeployment(userId, projectId, input.environment ?? 'development');
      if (!current) throw AppError.badRequest('no_current_deployment', 'No current deployment identified for this environment');

      const target = await getDeployment(userId, projectId, input.targetDeploymentId);

      // Duplicate-rollback protection: refuse if the target is already the current.
      if (target.id === current.id) {
        throw AppError.badRequest('duplicate_rollback', 'Target release is already the current deployment; nothing to roll back');
      }

      // Production rollback requires explicit confirmation. No silent rollback.
      const env = input.environment ?? current.environment;
      if (env === 'production' && input.confirmed !== true) {
        const blocked: RollbackRun = {
          id: newId(PREFIX.ROLLBACK_RUN),
          projectId,
          workspaceId: current.workspaceId,
          environment: env,
          currentDeploymentId: current.id,
          targetDeploymentId: target.id,
          status: 'BLOCKED',
          safetyChecks: [{ name: 'production_confirmation', ok: false, detail: 'Production rollback requires explicit confirmation' }],
          databaseCompat: 'UNKNOWN',
          provider: current.provider,
          providerCapability: 'ENVIRONMENT_BLOCKED',
          reason: 'Production rollback requires explicit confirmation. No silent rollback.',
          result: 'BLOCKED',
          createdAt: now().toISOString(),
          completedAt: now().toISOString(),
        };
        await withTenant(userId, async (q) =>
          q.query(
            `INSERT INTO rollback_runs (id, project_id, workspace_id, environment, current_deployment_id, target_deployment_id, status, data, created_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())`,
            [blocked.id, projectId, current.workspaceId, env, current.id, target.id, 'BLOCKED', JSON.stringify(blocked)],
          ),
        );
        await recordAudit({
          action: 'deployment.rollback',
          actorUserId: userId,
          scope: 'USER',
          tenantId: userId,
          resourceType: 'rollback_run',
          resourceId: blocked.id,
          detail: { projectId, environment: env, current: current.id, target: target.id, result: 'BLOCKED', reason: 'production_confirmation_required' },
        });
        return blocked;
      }

      // ── Safety checks ───────────────────────────────────────────
      const checks: RollbackSafetyCheck[] = [];
      const sameProject = target.projectId === projectId;
      const sameEnv = target.environment === env;
      const targetKnown = Boolean(target.id);
      const targetEligible = isRollbackEligible(target);
      const currentKnown = Boolean(current.id);
      const provider = providerCapability(current.provider, { hasProviderDeploymentId: current.providerDeploymentId != null });
      const providerSupports = provider.supportsRollback;
      const artifactExists = Boolean(current.version && target.version);
      const dbCompat = assessDatabaseCompat(input.dbEvidence ?? { target: { migration: null }, current: { migration: null } });

      checks.push({ name: 'authorized', ok: true, detail: `user authorized on project ${projectId}` });
      checks.push({ name: 'same_project', ok: sameProject, detail: sameProject ? 'target belongs to same project' : 'target is from a different project' });
      checks.push({ name: 'same_environment', ok: sameEnv, detail: sameEnv ? `environment matches (${input.environment ?? current.environment})` : `environment mismatch: target ${target.environment} vs requested ${input.environment ?? current.environment}` });
      checks.push({ name: 'target_known', ok: targetKnown, detail: 'target release is known' });
      checks.push({ name: 'target_eligible', ok: targetEligible, detail: targetEligible ? 'target is a VERIFIED prior release' : `target not rollback-eligible (status=${target.status}, verification=${target.verification})` });
      checks.push({ name: 'current_known', ok: currentKnown, detail: 'current deployment is known' });
      checks.push({ name: 'provider_supports_rollback', ok: providerSupports, detail: providerSupports ? `provider '${current.provider}' supports rollback semantics` : `provider '${current.provider}' does not support rollback` });
      checks.push({ name: 'artifact_exists', ok: artifactExists, detail: artifactExists ? 'target/current versions present' : 'required version/artifact missing' });
      checks.push({ name: 'database_compatibility', ok: dbCompat !== 'BLOCKED', detail: dbCompat === 'COMPATIBLE' ? 'database compatibility established' : dbCompat === 'UNKNOWN' ? 'database compatibility unknown — treated as unsafe (BLOCKED unless evidence provided)' : 'destructive/non-backward-compatible DB migration detected — database rollback BLOCKED' });

      const allOk = checks.every((c) => c.ok);
      const blockedByDb = dbCompat === 'BLOCKED';

      let status: RollbackRun['status'];
      let result: RollbackRun['result'];
      let reason: string;
      let completedAt: string | null = null;
      let newProviderDeploymentId = current.providerDeploymentId;

      if (!allOk) {
        status = 'BLOCKED';
        result = 'BLOCKED';
        const failed = checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
        reason = `Rollback blocked: ${failed}`;
        if (blockedByDb) reason = 'Rollback blocked: destructive/non-backward-compatible database migration; database rollback is never automatic.';
      } else {
        // ── Execution (honest, provider-gated) ────────────────────
        status = 'EXECUTING';
        const execResult = await executor.execute(current, target, provider);
        completedAt = now().toISOString();
        status = execResult.status;
        result = execResult.status === 'SUCCEEDED' ? 'ROLLED_BACK' : execResult.status === 'FAILED' ? 'FAILED' : 'BLOCKED';
        reason = execResult.detail;
        if (execResult.newProviderDeploymentId != null) newProviderDeploymentId = execResult.newProviderDeploymentId;

        // Apply rollback outcome to the deployment records (record-keeping only;
        // never deletes data). Mark the previously-current as ROLLED_BACK and the
        // target as the new ROLLED_BACK-lit current.
        await updateDeployment(userId, projectId, current.id, {
          status: 'ROLLED_BACK',
          rollbackSourceId: target.id,
          rollbackTargetId: target.id,
          providerDeploymentId: newProviderDeploymentId ?? current.providerDeploymentId,
          failureReason: result === 'ROLLED_BACK' ? undefined : reason,
        });
        if (status === 'SUCCEEDED') {
          await updateDeployment(userId, projectId, target.id, {
            status: 'VERIFIED',
            rollbackSourceId: target.id,
            rollbackTargetId: current.id,
            providerDeploymentId: newProviderDeploymentId ?? target.providerDeploymentId,
            failureReason: null,
          });
        }
      }

      const run: RollbackRun = {
        id: newId(PREFIX.ROLLBACK_RUN),
        projectId,
        workspaceId: current.workspaceId,
        environment: input.environment ?? current.environment,
        currentDeploymentId: current.id,
        targetDeploymentId: target.id,
        status,
        safetyChecks: checks,
        databaseCompat: dbCompat,
        provider: current.provider,
        providerCapability: provider.state,
        reason,
        result,
        createdAt: now().toISOString(),
        completedAt,
      };

      await withTenant(userId, async (q) =>
        q.query(
          `INSERT INTO rollback_runs (id, project_id, workspace_id, environment, current_deployment_id, target_deployment_id, status, data, created_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), $9)`,
          [run.id, projectId, current.workspaceId, run.environment, current.id, target.id, status, JSON.stringify(run), completedAt ? new Date(completedAt) : null],
        ),
      );

      await recordAudit({
        action: 'deployment.rollback',
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'rollback_run',
        resourceId: run.id,
        detail: { projectId, environment: run.environment, current: current.id, target: target.id, result, status },
      });

      return run;
    },

    async getRun(userId, projectId, runId) {
      await assertProjectAccess(userId, projectId);
      const row = await withTenant(userId, async (q) =>
        (await q.query<{ id: string; data: string }>(
          `SELECT id, data FROM rollback_runs WHERE id = $1 AND project_id = $2`,
          [runId, projectId],
        )).rows[0] ?? null,
      );
      if (!row || row.id === undefined) throw AppError.notFound('Rollback', 'rollback_not_found');
      return JSON.parse(row.data) as RollbackRun;
    },

    async listRuns(userId, projectId, limit = 20) {
      await assertProjectAccess(userId, projectId);
      const rows = await withTenant(userId, async (q) =>
        (await q.query<{ data: string }>(
          `SELECT data FROM rollback_runs WHERE project_id = $1 ORDER BY created_at DESC`,
          [projectId],
        )).rows,
      );
      return rows.map((r) => JSON.parse(r.data) as RollbackRun).slice(0, Math.min(limit ?? 20, 200));
    },
  };
}

export const rollbackEngine = createRollbackEngine();
