/**
 * CodeConClave — Deployment Plan Generator (V4E).
 * Generates a step-by-step deployment plan from discovery and readiness data.
 * Each step has service, action, required credentials, safety checks, and verification.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import type { DeploymentProfile, DetectedComponent } from './deploymentDiscovery.js';
import type { DeploymentReadiness, ReadinessItem } from './deploymentReadiness.js';

// ─── Types ─────────────────────────────────────────────────────

export type StepAction =
  | 'PROVISION_SERVICE'
  | 'CONFIGURE_ENV'
  | 'SETUP_DATABASE'
  | 'RUN_MIGRATION'
  | 'BUILD'
  | 'DEPLOY'
  | 'CONFIGURE_DOMAIN'
  | 'ENABLE_TLS'
  | 'SETUP_WORKER'
  | 'SETUP_CRON'
  | 'CONFIGURE_STORAGE'
  | 'CONFIGURE_AI'
  | 'CONFIGURE_PAYMENT'
  | 'CONFIGURE_EMAIL'
  | 'HEALTH_CHECK'
  | 'VERIFY_DEPLOYMENT'
  | 'NOTIFY';

export type SafetyLevel = 'SAFE' | 'REQUIRES_APPROVAL' | 'DESTRUCTIVE' | 'IRREVERSIBLE';

export interface DeploymentStep {
  id: string;
  order: number;
  service: string;
  action: StepAction;
  label: string;
  description: string;
  requiredCredentials: string[];
  safetyLevel: SafetyLevel;
  verificationCommand?: string;
  verificationEndpoint?: string;
  estimatedDurationSec: number;
  rollbackAction?: StepAction;
  rollbackAvailable: boolean;
  dependsOn: string[];
  metadata: Record<string, unknown>;
}

export interface DeploymentPlan {
  id: string;
  profileId: string;
  readinessId: string;
  projectId: string;
  createdAt: Date;
  strategy: DeploymentStrategy;
  steps: DeploymentStep[];
  estimatedTotalDurationSec: number;
  requiredApprovals: string[];
  rollbackPlan: RollbackPlan;
  metadata: Record<string, unknown>;
}

export type DeploymentStrategy = 'standard' | 'rollback' | 'preview' | 'canary';

export interface RollbackPlan {
  available: boolean;
  steps: string[];
  lastKnownGoodCommit?: string;
  backupRequired: boolean;
  estimatedRollbackTimeSec: number;
}

export interface PlanInput {
  profile: DeploymentProfile;
  readiness: DeploymentReadiness;
  strategy?: DeploymentStrategy;
  targetCommit?: string;
  previousCommit?: string;
}

// ─── Step Generators ───────────────────────────────────────────

function generateProvisionSteps(profile: DeploymentProfile, readiness: DeploymentReadiness): DeploymentStep[] {
  const steps: DeploymentStep[] = [];
  let order = 1;

  const blockedItems = readiness.items.filter(i => i.status === 'BLOCKED');

  for (const item of blockedItems) {
    if (item.requiredCredential) {
      steps.push({
        id: newId(PREFIX.DEPLOY_STEP),
        order: order++,
        service: item.targetService || 'platform',
        action: 'CONFIGURE_ENV',
        label: `Set ${item.requiredCredential}`,
        description: `Configure ${item.requiredCredential} for ${item.label}.`,
        requiredCredentials: [item.requiredCredential],
        safetyLevel: 'SAFE',
        estimatedDurationSec: 30,
        rollbackAvailable: false,
        dependsOn: [],
        metadata: { readinessCategory: item.category },
      });
    }
  }

  const hasDatabase = profile.components.some(c => c.type === 'DATABASE');
  if (hasDatabase) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'database',
      action: 'PROVISION_SERVICE',
      label: 'Provision PostgreSQL',
      description: 'Create or connect to a PostgreSQL database instance.',
      requiredCredentials: ['DATABASE_URL'],
      safetyLevel: 'REQUIRES_APPROVAL',
      verificationEndpoint: '/health',
      estimatedDurationSec: 120,
      rollbackAvailable: false,
      dependsOn: [],
      metadata: { engine: 'postgresql' },
    });

    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'database',
      action: 'RUN_MIGRATION',
      label: 'Run Database Migrations',
      description: 'Apply pending database migrations to bring schema to latest.',
      requiredCredentials: ['DATABASE_URL'],
      safetyLevel: 'REQUIRES_APPROVAL',
      verificationCommand: 'SELECT count(*) FROM information_schema.tables',
      estimatedDurationSec: 60,
      rollbackAction: 'RUN_MIGRATION',
      rollbackAvailable: true,
      dependsOn: steps.length > 0 ? [steps.at(-1)!.id] : [],
      metadata: { destructive: false },
    });
  }

  const hasRedis = profile.components.some(c => c.type === 'REDIS');
  if (hasRedis) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'redis',
      action: 'PROVISION_SERVICE',
      label: 'Provision Redis',
      description: 'Create or connect to a Redis instance.',
      requiredCredentials: ['REDIS_URL'],
      safetyLevel: 'SAFE',
      verificationEndpoint: '/ping',
      estimatedDurationSec: 60,
      rollbackAvailable: false,
      dependsOn: [],
      metadata: {},
    });
  }

  return steps;
}

function generateComponentDeploySteps(profile: DeploymentProfile): DeploymentStep[] {
  const steps: DeploymentStep[] = [];
  let order = 1;

  const backend = profile.components.find(c => c.type === 'BACKEND');
  if (backend) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'backend',
      action: 'BUILD',
      label: 'Build Backend',
      description: `Build backend service (${backend.framework || 'Node.js'}).`,
      requiredCredentials: [],
      safetyLevel: 'SAFE',
      verificationCommand: backend.buildCommand || 'npm run build',
      estimatedDurationSec: 120,
      rollbackAvailable: false,
      dependsOn: [],
      metadata: { framework: backend.framework },
    });

    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'backend',
      action: 'DEPLOY',
      label: 'Deploy Backend Service',
      description: `Deploy backend to ${detectTargetService(profile)}.`,
      requiredCredentials: ['PORT'],
      safetyLevel: 'REQUIRES_APPROVAL',
      verificationEndpoint: backend.healthEndpoint || '/health',
      estimatedDurationSec: 180,
      rollbackAvailable: true,
      rollbackAction: 'DEPLOY',
      dependsOn: steps.length > 0 ? [steps.at(-1)!.id] : [],
      metadata: { target: detectTargetService(profile) },
    });
  }

  const frontend = profile.components.find(c => c.type === 'FRONTEND');
  if (frontend) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'frontend',
      action: 'BUILD',
      label: 'Build Frontend',
      description: `Build frontend (${frontend.framework || 'static'}).`,
      requiredCredentials: [],
      safetyLevel: 'SAFE',
      verificationCommand: frontend.buildCommand || 'npm run build',
      estimatedDurationSec: 90,
      rollbackAvailable: false,
      dependsOn: [],
      metadata: { framework: frontend.framework },
    });

    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'frontend',
      action: 'DEPLOY',
      label: 'Deploy Frontend',
      description: `Deploy frontend to ${detectFrontendTarget(profile)}.`,
      requiredCredentials: ['VITE_API_URL'],
      safetyLevel: 'SAFE',
      verificationEndpoint: frontend.healthEndpoint || '/',
      estimatedDurationSec: 120,
      rollbackAvailable: true,
      rollbackAction: 'DEPLOY',
      dependsOn: steps.length > 0 ? [steps.at(-1)!.id] : [],
      metadata: { target: detectFrontendTarget(profile) },
    });
  }

  const worker = profile.components.find(c => c.type === 'WORKER');
  if (worker) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'worker',
      action: 'SETUP_WORKER',
      label: 'Configure Background Worker',
      description: 'Set up background job processing.',
      requiredCredentials: ['REDIS_URL'],
      safetyLevel: 'SAFE',
      estimatedDurationSec: 60,
      rollbackAvailable: true,
      rollbackAction: 'DEPLOY',
      dependsOn: [],
      metadata: {},
    });
  }

  return steps;
}

function generatePostDeploySteps(profile: DeploymentProfile, readiness: DeploymentReadiness): DeploymentStep[] {
  const steps: DeploymentStep[] = [];
  let order = 1;

  for (const check of profile.healthChecks) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: check.component,
      action: 'HEALTH_CHECK',
      label: `Health Check: ${check.component}`,
      description: `Verify ${check.component} health via ${check.type}.`,
      requiredCredentials: [],
      safetyLevel: 'SAFE',
      verificationEndpoint: check.endpoint,
      verificationCommand: check.command,
      estimatedDurationSec: Math.ceil(check.timeoutMs / 1000),
      rollbackAvailable: false,
      dependsOn: [],
      metadata: { checkType: check.type, timeout: check.timeoutMs },
    });
  }

  steps.push({
    id: newId(PREFIX.DEPLOY_STEP),
    order: order++,
    service: 'monitoring',
    action: 'VERIFY_DEPLOYMENT',
    label: 'Final Verification',
    description: 'Run comprehensive post-deployment verification.',
    requiredCredentials: [],
    safetyLevel: 'SAFE',
    verificationEndpoint: '/health',
    estimatedDurationSec: 30,
    rollbackAvailable: false,
    dependsOn: [],
    metadata: {},
  });

  const hasDangerous = readiness.items.some(i => i.status === 'DANGEROUS');
  if (hasDangerous) {
    steps.push({
      id: newId(PREFIX.DEPLOY_STEP),
      order: order++,
      service: 'notification',
      action: 'NOTIFY',
      label: 'Post-Deploy Notification',
      description: 'Send deployment success notification with warnings about dangerous items.',
      requiredCredentials: [],
      safetyLevel: 'SAFE',
      estimatedDurationSec: 10,
      rollbackAvailable: false,
      dependsOn: [],
      metadata: { warnings: readiness.items.filter(i => i.status === 'DANGEROUS').map(i => i.label) },
    });
  }

  return steps;
}

function detectTargetService(profile: DeploymentProfile): string {
  if (profile.deploymentConfigs.railway) return 'railway';
  if (profile.deploymentConfigs.render) return 'render';
  if (profile.deploymentConfigs.fly) return 'fly.io';
  if (profile.deploymentConfigs.kubernetes) return 'kubernetes';
  if (profile.deploymentConfigs.docker) return 'docker';
  return 'generic';
}

function detectFrontendTarget(profile: DeploymentProfile): string {
  if (profile.deploymentConfigs.vercel) return 'vercel';
  if (profile.deploymentConfigs.cloudflare) return 'cloudflare pages';
  if (profile.deploymentConfigs.netlify) return 'netlify';
  return 'static hosting';
}

function generateRollbackPlan(profile: DeploymentProfile, steps: DeploymentStep[]): RollbackPlan {
  const rollbackSteps: string[] = [];
  let estimatedTime = 0;

  const deploySteps = steps.filter(s => s.rollbackAvailable);
  for (const step of deploySteps.reverse()) {
    rollbackSteps.push(`Rollback ${step.label} via ${step.rollbackAction || step.action}`);
    estimatedTime += step.estimatedDurationSec;
  }

  return {
    available: rollbackSteps.length > 0,
    steps: rollbackSteps,
    backupRequired: steps.some(s => s.safetyLevel === 'DESTRUCTIVE' || s.action === 'RUN_MIGRATION'),
    estimatedRollbackTimeSec: estimatedTime,
  };
}

// ─── Main Function ─────────────────────────────────────────────

export async function generateDeploymentPlan(
  userId: string,
  projectId: string,
  input: PlanInput
): Promise<DeploymentPlan> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const planId = newId(PREFIX.DEPLOY_PLAN);
  const strategy = input.strategy || 'standard';

  const provisionSteps = generateProvisionSteps(input.profile, input.readiness);
  const deploySteps = generateComponentDeploySteps(input.profile);
  const postSteps = generatePostDeploySteps(input.profile, input.readiness);

  const allSteps = [...provisionSteps, ...deploySteps, ...postSteps];
  allSteps.forEach((s, i) => { s.order = i + 1; });

  const totalDuration = allSteps.reduce((sum, s) => sum + s.estimatedDurationSec, 0);

  const requiredApprovals: string[] = [];
  for (const step of allSteps) {
    if (step.safetyLevel === 'REQUIRES_APPROVAL' || step.safetyLevel === 'DESTRUCTIVE' || step.safetyLevel === 'IRREVERSIBLE') {
      requiredApprovals.push(`${step.service}/${step.action}`);
    }
  }

  const rollbackPlan = generateRollbackPlan(input.profile, allSteps);

  const plan: DeploymentPlan = {
    id: planId,
    profileId: input.profile.id,
    readinessId: input.readiness.id,
    projectId,
    createdAt: new Date(),
    strategy,
    steps: allSteps,
    estimatedTotalDurationSec: totalDuration,
    requiredApprovals,
    rollbackPlan,
    metadata: {
      componentCount: input.profile.components.length,
      targetCommit: input.targetCommit,
      previousCommit: input.previousCommit,
    },
  };

  await pool.query(
    `INSERT INTO deployment_plans (id, profile_id, readiness_id, project_id, strategy, steps, estimated_duration_sec, required_approvals, rollback_plan, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      planId, input.profile.id, input.readiness.id, projectId,
      strategy, JSON.stringify(allSteps), totalDuration,
      JSON.stringify(requiredApprovals), JSON.stringify(rollbackPlan),
    ],
  );

  await recordAudit({
    action: 'deployment_plan_generated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'deployment_plan',
    resourceId: planId,
    detail: { stepCount: allSteps.length, strategy, estimatedDuration: totalDuration },
  });

  return plan;
}
