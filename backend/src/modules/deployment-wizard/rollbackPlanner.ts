/**
 * CodeConClave — Rollback Planner (V4E).
 * Prepares rollback information before deployment.
 * Does NOT claim rollback is available if it is not.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import type { DeploymentPlan, DeploymentStep } from './deploymentPlan.js';

// ─── Types ─────────────────────────────────────────────────────

export interface RollbackInfo {
  id: string;
  projectId: string;
  planId: string;
  createdAt: Date;
  available: boolean;
  reason: string;
  currentCommit?: string;
  previousCommit?: string;
  steps: RollbackStep[];
  estimatedTimeSec: number;
  databaseBackupRequired: boolean;
  manualInterventionRequired: boolean;
  manualInterventionSteps: string[];
}

export interface RollbackStep {
  order: number;
  service: string;
  action: string;
  command?: string;
  description: string;
  estimatedDurationSec: number;
  automatic: boolean;
}

export interface RollbackInput {
  projectId: string;
  plan: DeploymentPlan;
  currentCommit?: string;
  previousCommit?: string;
}

// ─── Helpers ───────────────────────────────────────────────────

function analyzeRollbackFeasibility(plan: DeploymentPlan): { available: boolean; reason: string; manualSteps: string[] } {
  const rollbackSteps = plan.steps.filter(s => s.rollbackAvailable);
  const manualSteps: string[] = [];

  if (rollbackSteps.length === 0) {
    return {
      available: false,
      reason: 'No steps have rollback available.',
      manualSteps: [],
    };
  }

  const hasMigration = plan.steps.some(s => s.action === 'RUN_MIGRATION');
  if (hasMigration) {
    manualSteps.push('Database migration rollback requires manual review — migrations may have data dependencies');
  }

  const hasDestructive = plan.steps.some(s => s.safetyLevel === 'DESTRUCTIVE' || s.safetyLevel === 'IRREVERSIBLE');
  if (hasDestructive) {
    manualSteps.push('Destructive actions cannot be automatically rolled back');
  }

  const hasDomainChange = plan.steps.some(s => s.action === 'CONFIGURE_DOMAIN');
  if (hasDomainChange) {
    manualSteps.push('DNS changes may take up to 48 hours to propagate — rollback is not instant');
  }

  const hasPayment = plan.steps.some(s => s.action === 'CONFIGURE_PAYMENT');
  if (hasPayment) {
    manualSteps.push('Payment configuration changes require manual verification of webhook endpoints');
  }

  return {
    available: rollbackSteps.length > 0,
    reason: rollbackSteps.length > 0
      ? `${rollbackSteps.length} steps can be automatically rolled back. ${manualSteps.length} steps require manual intervention.`
      : 'No steps support automatic rollback.',
    manualSteps,
  };
}

function generateRollbackSteps(plan: DeploymentPlan): RollbackStep[] {
  const steps: RollbackStep[] = [];
  let order = 1;

  const rollbackable = plan.steps.filter(s => s.rollbackAvailable).reverse();

  for (const step of rollbackable) {
    steps.push({
      order: order++,
      service: step.service,
      action: step.rollbackAction || step.action,
      command: step.rollbackAction ? `rollback-${step.service}` : undefined,
      description: `Rollback ${step.label}`,
      estimatedDurationSec: step.estimatedDurationSec,
      automatic: true,
    });
  }

  return steps;
}

// ─── Main Function ─────────────────────────────────────────────

export async function prepareRollbackPlan(
  userId: string,
  input: RollbackInput
): Promise<RollbackInfo> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [input.projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const rollbackId = newId(PREFIX.DEPLOY_ROLLBACK);

  const feasibility = analyzeRollbackFeasibility(input.plan);
  const steps = generateRollbackSteps(input.plan);
  const estimatedTime = steps.reduce((sum, s) => sum + s.estimatedDurationSec, 0);

  const databaseBackupRequired = input.plan.steps.some(s => s.action === 'RUN_MIGRATION');

  const rollbackInfo: RollbackInfo = {
    id: rollbackId,
    projectId: input.projectId,
    planId: input.plan.id,
    createdAt: new Date(),
    available: feasibility.available,
    reason: feasibility.reason,
    currentCommit: input.currentCommit,
    previousCommit: input.previousCommit,
    steps,
    estimatedTimeSec: estimatedTime,
    databaseBackupRequired,
    manualInterventionRequired: feasibility.manualSteps.length > 0,
    manualInterventionSteps: feasibility.manualSteps,
  };

  await pool.query(
    `INSERT INTO rollback_plans (id, project_id, plan_id, available, reason, steps, estimated_time_sec, database_backup_required, manual_intervention_required, manual_steps, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      rollbackId, input.projectId, input.plan.id,
      feasibility.available, feasibility.reason,
      JSON.stringify(steps), estimatedTime,
      databaseBackupRequired, feasibility.manualSteps.length > 0,
      JSON.stringify(feasibility.manualSteps),
    ],
  );

  await recordAudit({
    action: 'rollback_plan_prepared',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'rollback_plan',
    resourceId: rollbackId,
    detail: { available: feasibility.available, stepCount: steps.length },
  });

  return rollbackInfo;
}
