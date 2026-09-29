/**
 * CodeConClave — Deployment Report (V4E).
 * Generates comprehensive deployment reports as Markdown.
 * Includes plan, dependencies, checks, approvals, execution, result, rollback info.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import type { DeploymentProfile } from './deploymentDiscovery.js';
import type { DeploymentReadiness } from './deploymentReadiness.js';
import type { DeploymentPlan, DeploymentStep } from './deploymentPlan.js';
import type { PreDeployResult } from './preDeployCheck.js';
import type { PostDeployResult } from './postDeployVerify.js';
import type { RollbackInfo } from './rollbackPlanner.js';
import type { SecretInventory } from './secretHandling.js';
import type { StrategySelection } from './deploymentStrategy.js';

// ─── Types ─────────────────────────────────────────────────────

export interface DeploymentReport {
  id: string;
  projectId: string;
  generatedAt: Date;
  profile: DeploymentProfile;
  readiness: DeploymentReadiness;
  plan: DeploymentPlan;
  preDeploy: PreDeployResult;
  postDeploy?: PostDeployResult;
  rollback?: RollbackInfo;
  secrets?: SecretInventory;
  strategy?: StrategySelection;
  markdown: string;
}

export interface ReportInput {
  projectId: string;
  profile: DeploymentProfile;
  readiness: DeploymentReadiness;
  plan: DeploymentPlan;
  preDeploy: PreDeployResult;
  postDeploy?: PostDeployResult;
  rollback?: RollbackInfo;
  secrets?: SecretInventory;
  strategy?: StrategySelection;
}

// ─── Markdown Generation ───────────────────────────────────────

function generateMarkdown(input: ReportInput): string {
  const lines: string[] = [];

  lines.push(`# CodeConClave — Deployment Wizard Report`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Project: ${input.projectId}`);
  lines.push(`Branch: ${input.profile.branch}`);
  lines.push(`Language: ${input.profile.language} | Runtime: ${input.profile.runtime} | Package Manager: ${input.profile.packageManager}`);
  lines.push(``);

  // Readiness
  lines.push(`## Readiness`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Overall Status | **${input.readiness.overallStatus}** |`);
  lines.push(`| Score | ${input.readiness.score}% |`);
  lines.push(`| Ready | ${input.readiness.summary.ready} |`);
  lines.push(`| Missing | ${input.readiness.summary.missing} |`);
  lines.push(`| Blocked | ${input.readiness.summary.blocked} |`);
  lines.push(`| Optional | ${input.readiness.summary.optional} |`);
  lines.push(`| Dangerous | ${input.readiness.summary.dangerous} |`);
  lines.push(`| Est. Deploy Time | ${input.readiness.estimatedDeployTime} |`);
  lines.push(``);

  // Readiness Items
  lines.push(`### Readiness Details`);
  lines.push(``);
  lines.push(`| Category | Status | Label | Detail |`);
  lines.push(`|----------|--------|-------|--------|`);
  for (const item of input.readiness.items) {
    lines.push(`| ${item.category} | ${item.status} | ${item.label} | ${item.detail} |`);
  }
  lines.push(``);

  // Components
  lines.push(`## Discovered Components`);
  lines.push(``);
  lines.push(`| Type | Name | Framework | Build | Start |`);
  lines.push(`|------|------|-----------|-------|-------|`);
  for (const comp of input.profile.components) {
    lines.push(`| ${comp.type} | ${comp.name} | ${comp.framework || '-'} | ${comp.buildCommand || '-'} | ${comp.startCommand || '-'} |`);
  }
  lines.push(``);

  // Deployment Plan
  lines.push(`## Deployment Plan`);
  lines.push(``);
  lines.push(`**Strategy:** ${input.plan.strategy}`);
  lines.push(`**Estimated Duration:** ${Math.round(input.plan.estimatedTotalDurationSec / 60)} minutes`);
  lines.push(`**Steps:** ${input.plan.steps.length}`);
  lines.push(``);
  lines.push(`| Step | Service | Action | Safety | Duration |`);
  lines.push(`|------|---------|--------|--------|----------|`);
  for (const step of input.plan.steps) {
    lines.push(`| ${step.order} | ${step.service} | ${step.label} | ${step.safetyLevel} | ${step.estimatedDurationSec}s |`);
  }
  lines.push(``);

  // Required Approvals
  if (input.plan.requiredApprovals.length > 0) {
    lines.push(`### Required Approvals`);
    lines.push(``);
    for (const approval of input.plan.requiredApprovals) {
      lines.push(`- [ ] ${approval}`);
    }
    lines.push(``);
  }

  // Pre-Deploy
  lines.push(`## Pre-Deploy Checks`);
  lines.push(``);
  lines.push(`**Status:** ${input.preDeploy.passed ? '**PASSED**' : '**FAILED**'}`);
  lines.push(``);
  lines.push(`| Check | Status | Severity | Message |`);
  lines.push(`|-------|--------|----------|---------|`);
  for (const check of input.preDeploy.checks) {
    lines.push(`| ${check.name} | ${check.status} | ${check.severity} | ${check.message} |`);
  }
  lines.push(``);

  if (input.preDeploy.criticalFailures.length > 0) {
    lines.push(`### Critical Failures`);
    lines.push(``);
    for (const failure of input.preDeploy.criticalFailures) {
      lines.push(`- **BLOCKED:** ${failure}`);
    }
    lines.push(``);
  }

  // Secrets
  if (input.secrets) {
    lines.push(`## Secrets`);
    lines.push(``);
    lines.push(`| Variable | Status | Target | Required |`);
    lines.push(`|----------|--------|--------|----------|`);
    for (const secret of input.secrets.secrets) {
      lines.push(`| ${secret.variableName} | ${secret.status} | ${secret.targetService} | ${secret.isRequired ? 'Yes' : 'No'} |`);
    }
    lines.push(``);
  }

  // Strategy
  if (input.strategy) {
    lines.push(`## Strategy`);
    lines.push(``);
    lines.push(`**Selected:** ${input.strategy.strategy}`);
    lines.push(`**Provider:** ${input.strategy.targetProvider}`);
    lines.push(`**Features:** ${input.strategy.config.features.join(', ')}`);
    lines.push(``);
  }

  // Rollback
  if (input.rollback) {
    lines.push(`## Rollback Plan`);
    lines.push(``);
    lines.push(`**Available:** ${input.rollback.available ? 'Yes' : 'No'}`);
    lines.push(`**Reason:** ${input.rollback.reason}`);
    if (input.rollback.databaseBackupRequired) {
      lines.push(`**Database Backup Required:** Yes`);
    }
    if (input.rollback.manualInterventionRequired) {
      lines.push(`**Manual Intervention Required:** Yes`);
      for (const step of input.rollback.manualInterventionSteps) {
        lines.push(`- ${step}`);
      }
    }
    if (input.rollback.steps.length > 0) {
      lines.push(``);
      lines.push(`| Step | Service | Action | Duration |`);
      lines.push(`|------|---------|--------|----------|`);
      for (const step of input.rollback.steps) {
        lines.push(`| ${step.order} | ${step.service} | ${step.description} | ${step.estimatedDurationSec}s |`);
      }
    }
    lines.push(``);
  }

  // Post-Deploy
  if (input.postDeploy) {
    lines.push(`## Post-Deploy Verification`);
    lines.push(``);
    lines.push(`**Overall Status:** ${input.postDeploy.overallStatus}`);
    lines.push(``);
    lines.push(`| Check | Status | Category | Message |`);
    lines.push(`|-------|--------|----------|---------|`);
    for (const check of input.postDeploy.checks) {
      lines.push(`| ${check.name} | ${check.status} | ${check.category} | ${check.message} |`);
    }
    lines.push(``);
  }

  // Dependencies
  lines.push(`## Dependencies`);
  lines.push(``);
  lines.push(`| Component | Env Vars |`);
  lines.push(`|-----------|----------|`);
  for (const comp of input.profile.components) {
    lines.push(`| ${comp.name} | ${comp.envVars.join(', ') || '-'} |`);
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(`*Report generated by CodeConClave Deployment Wizard*`);

  return lines.join('\n');
}

// ─── Main Function ─────────────────────────────────────────────

export async function generateDeploymentReport(
  userId: string,
  input: ReportInput
): Promise<DeploymentReport> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [input.projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const reportId = newId(PREFIX.DEPLOY_REPORT);
  const markdown = generateMarkdown(input);

  const report: DeploymentReport = {
    id: reportId,
    projectId: input.projectId,
    generatedAt: new Date(),
    profile: input.profile,
    readiness: input.readiness,
    plan: input.plan,
    preDeploy: input.preDeploy,
    postDeploy: input.postDeploy,
    rollback: input.rollback,
    secrets: input.secrets,
    strategy: input.strategy,
    markdown,
  };

  await pool.query(
    `INSERT INTO deployment_reports (id, project_id, markdown, created_at)
     VALUES ($1, $2, $3, now())`,
    [reportId, input.projectId, markdown],
  );

  await recordAudit({
    action: 'deployment_report_generated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'deployment_report',
    resourceId: reportId,
    detail: { markdownLength: markdown.length },
  });

  return report;
}
