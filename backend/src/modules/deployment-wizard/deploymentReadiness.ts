/**
 * CodeConClave — Deployment Readiness (V4E).
 * Evaluates deployment readiness across all discovered components.
 * Status: READY | MISSING | BLOCKED | OPTIONAL | DANGEROUS
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import type { DeploymentProfile } from './deploymentDiscovery.js';

// ─── Types ─────────────────────────────────────────────────────

export type ReadinessStatus = 'READY' | 'MISSING' | 'BLOCKED' | 'OPTIONAL' | 'DANGEROUS';

export interface ReadinessItem {
  category: string;
  status: ReadinessStatus;
  label: string;
  detail: string;
  requiredCredential?: string;
  targetService?: string;
  blockReason?: string;
  recommendation?: string;
}

export interface DeploymentReadiness {
  id: string;
  profileId: string;
  projectId: string;
  checkedAt: Date;
  overallStatus: 'READY' | 'NOT_READY' | 'PARTIAL';
  score: number;
  items: ReadinessItem[];
  summary: {
    ready: number;
    missing: number;
    blocked: number;
    optional: number;
    dangerous: number;
  };
  estimatedDeployTime: string;
}

export interface ReadinessInput {
  profile: DeploymentProfile;
  existingServices?: string[];
  targetPlatform?: string;
}

// ─── Readiness Checks ─────────────────────────────────────────

function checkDatabase(profile: DeploymentProfile): ReadinessItem {
  const hasDbComponent = profile.components.some(c => c.type === 'DATABASE');
  const hasDbUrl = profile.requiredEnvVars.includes('DATABASE_URL') ||
    profile.envFile.variables.some(v => v.name === 'DATABASE_URL' && v.hasValue);

  if (hasDbComponent && hasDbUrl) {
    return {
      category: 'database',
      status: 'READY',
      label: 'Database',
      detail: 'Database component detected with DATABASE_URL configured.',
      targetService: 'postgresql',
    };
  }
  if (hasDbComponent && !hasDbUrl) {
    return {
      category: 'database',
      status: 'BLOCKED',
      label: 'Database',
      detail: 'Database component detected but DATABASE_URL is missing.',
      requiredCredential: 'DATABASE_URL',
      targetService: 'postgresql',
      blockReason: 'Database connection string is required for application to function.',
    };
  }
  return {
    category: 'database',
    status: 'MISSING',
    label: 'Database',
    detail: 'No database component detected. Most applications require one.',
    recommendation: 'Add PostgreSQL or your preferred database.',
  };
}

function checkRedis(profile: DeploymentProfile): ReadinessItem {
  const hasRedisComponent = profile.components.some(c => c.type === 'REDIS');
  const hasQueueComponent = profile.components.some(c => c.type === 'QUEUE');
  const hasRedisUrl = profile.requiredEnvVars.includes('REDIS_URL') ||
    profile.envFile.variables.some(v => v.name === 'REDIS_URL' && v.hasValue);

  if (hasRedisComponent && hasRedisUrl) {
    return {
      category: 'redis',
      status: 'READY',
      label: 'Redis',
      detail: 'Redis detected with REDIS_URL configured.',
      targetService: 'redis',
    };
  }
  if (hasQueueComponent && !hasRedisUrl) {
    return {
      category: 'redis',
      status: 'BLOCKED',
      label: 'Redis',
      detail: 'Queue system detected but REDIS_URL is missing.',
      requiredCredential: 'REDIS_URL',
      targetService: 'redis',
      blockReason: 'Queue requires Redis for job processing.',
    };
  }
  if (hasRedisComponent && !hasRedisUrl) {
    return {
      category: 'redis',
      status: 'BLOCKED',
      label: 'Redis',
      detail: 'Redis component detected but REDIS_URL is missing.',
      requiredCredential: 'REDIS_URL',
      targetService: 'redis',
      blockReason: 'Redis connection string required.',
    };
  }
  return {
    category: 'redis',
    status: 'OPTIONAL',
    label: 'Redis',
    detail: 'No Redis dependency detected. Add if you need caching or queues.',
  };
}

function checkEnvironment(profile: DeploymentProfile): ReadinessItem {
  const missingRequired = profile.envFile.missingRequired;
  const totalRequired = profile.requiredEnvVars.length;
  const configured = profile.envFile.variables.filter(v => v.hasValue).length;

  if (missingRequired.length === 0 && totalRequired <= configured) {
    return {
      category: 'environment',
      status: 'READY',
      label: 'Environment Variables',
      detail: `${configured} variables configured, ${totalRequired} required.`,
    };
  }
  if (missingRequired.length > 0) {
    return {
      category: 'environment',
      status: 'BLOCKED',
      label: 'Environment Variables',
      detail: `${missingRequired.length} required variables are missing: ${missingRequired.slice(0, 5).join(', ')}${missingRequired.length > 5 ? '...' : ''}`,
      blockReason: 'Required environment variables must be set before deployment.',
    };
  }
  return {
    category: 'environment',
    status: 'MISSING',
    label: 'Environment Variables',
    detail: `No .env file found. ${totalRequired} required variables needed.`,
    recommendation: 'Create .env file with required variables.',
  };
}

function checkFrontend(profile: DeploymentProfile): ReadinessItem {
  const frontend = profile.components.find(c => c.type === 'FRONTEND');
  if (!frontend) {
    return {
      category: 'frontend',
      status: 'OPTIONAL',
      label: 'Frontend',
      detail: 'No frontend component detected.',
    };
  }

  const issues: string[] = [];
  if (!frontend.buildCommand) issues.push('No build command found');
  if (!frontend.startCommand && !profile.deploymentConfigs.vercel && !profile.deploymentConfigs.cloudflare) {
    issues.push('No start command found');
  }

  if (issues.length === 0) {
    return {
      category: 'frontend',
      status: 'READY',
      label: 'Frontend',
      detail: `${frontend.framework || 'Framework'} frontend ready. Build: ${frontend.buildCommand || 'default'}`,
      targetService: profile.deploymentConfigs.vercel ? 'vercel' : profile.deploymentConfigs.cloudflare ? 'cloudflare' : 'static',
    };
  }
  return {
    category: 'frontend',
    status: 'MISSING',
    label: 'Frontend',
    detail: `Frontend detected but: ${issues.join('; ')}`,
    recommendation: 'Ensure build and start commands are configured.',
  };
}

function checkBackend(profile: DeploymentProfile): ReadinessItem {
  const backend = profile.components.find(c => c.type === 'BACKEND');
  if (!backend) {
    return {
      category: 'backend',
      status: 'BLOCKED',
      label: 'Backend',
      detail: 'No backend component detected.',
      blockReason: 'Deployment requires a backend service.',
    };
  }

  const issues: string[] = [];
  if (!backend.startCommand) issues.push('No start command');
  if (!backend.healthEndpoint) issues.push('No health endpoint');

  if (issues.length === 0) {
    return {
      category: 'backend',
      status: 'READY',
      label: 'Backend',
      detail: `${backend.framework || 'Backend'} service ready. Port: ${backend.port || 'default'}`,
      targetService: profile.deploymentConfigs.railway ? 'railway' : profile.deploymentConfigs.render ? 'render' : 'generic',
    };
  }
  return {
    category: 'backend',
    status: 'MISSING',
    label: 'Backend',
    detail: `Backend detected but: ${issues.join('; ')}`,
    recommendation: issues.includes('No health endpoint') ? 'Add a /health endpoint for reliability checks.' : undefined,
  };
}

function checkWorker(profile: DeploymentProfile): ReadinessItem {
  const worker = profile.components.find(c => c.type === 'WORKER');
  if (!worker) {
    return {
      category: 'worker',
      status: 'OPTIONAL',
      label: 'Worker',
      detail: 'No background worker detected.',
    };
  }
  return {
    category: 'worker',
    status: 'READY',
    label: 'Worker',
    detail: `Worker service with start command: ${worker.startCommand || 'default'}`,
    targetService: 'same-service',
  };
}

function checkDomain(profile: DeploymentProfile): ReadinessItem {
  if (profile.deploymentConfigs.vercel || profile.deploymentConfigs.cloudflare) {
    return {
      category: 'domain',
      status: 'OPTIONAL',
      label: 'Domain',
      detail: 'Platform provides default domain. Custom domain is optional.',
      recommendation: 'Configure custom domain after deployment.',
    };
  }
  return {
    category: 'domain',
    status: 'MISSING',
    label: 'Domain',
    detail: 'No domain configured. A custom domain is needed for production.',
    recommendation: 'Configure DNS after deployment.',
  };
}

function checkTls(profile: DeploymentProfile): ReadinessItem {
  if (profile.deploymentConfigs.vercel || profile.deploymentConfigs.cloudflare || profile.deploymentConfigs.railway || profile.deploymentConfigs.render) {
    return {
      category: 'tls',
      status: 'READY',
      label: 'TLS/SSL',
      detail: 'Platform provides automatic TLS.',
    };
  }
  return {
    category: 'tls',
    status: 'MISSING',
    label: 'TLS/SSL',
    detail: 'TLS termination not configured.',
    recommendation: 'Ensure HTTPS is enabled at the hosting provider.',
  };
}

function checkStorage(profile: DeploymentProfile): ReadinessItem {
  const hasStorage = profile.components.some(c => c.type === 'STORAGE');
  if (hasStorage) {
    return {
      category: 'storage',
      status: 'READY',
      label: 'Storage',
      detail: 'Storage component detected.',
      targetService: 's3-compatible',
    };
  }
  return {
    category: 'storage',
    status: 'OPTIONAL',
    label: 'Storage',
    detail: 'No storage component detected.',
  };
}

function checkEmail(profile: DeploymentProfile): ReadinessItem {
  const hasEmail = profile.components.some(c => c.type === 'EMAIL');
  if (hasEmail) {
    const hasApiKey = profile.envFile.variables.some(v => v.name === 'RESEND_API_KEY' && v.hasValue);
    if (hasApiKey) {
      return {
        category: 'email',
        status: 'READY',
        label: 'Email',
        detail: 'Email service configured.',
        targetService: 'resend',
      };
    }
    return {
      category: 'email',
      status: 'MISSING',
      label: 'Email',
      detail: 'Email dependency detected but API key is missing.',
      requiredCredential: 'RESEND_API_KEY',
      targetService: 'resend',
    };
  }
  return {
    category: 'email',
    status: 'OPTIONAL',
    label: 'Email',
    detail: 'No email dependency detected.',
  };
}

function checkAi(profile: DeploymentProfile): ReadinessItem {
  const hasAi = profile.components.some(c => c.type === 'AI_SERVICE');
  if (hasAi) {
    const hasKey = profile.envFile.variables.some(v =>
      (v.name === 'OPENAI_API_KEY' || v.name === 'ANTHROPIC_API_KEY') && v.hasValue
    );
    if (hasKey) {
      return {
        category: 'ai',
        status: 'READY',
        label: 'AI Provider',
        detail: 'AI service configured.',
        targetService: 'openai',
      };
    }
    return {
      category: 'ai',
      status: 'MISSING',
      label: 'AI Provider',
      detail: 'AI dependency detected but no API key configured.',
      requiredCredential: 'OPENAI_API_KEY or ANTHROPIC_API_KEY',
    };
  }
  return {
    category: 'ai',
    status: 'OPTIONAL',
    label: 'AI Provider',
    detail: 'No AI dependency detected.',
  };
}

function checkPayment(profile: DeploymentProfile): ReadinessItem {
  const hasPayment = profile.components.some(c => c.type === 'PAYMENT');
  if (hasPayment) {
    const hasKey = profile.envFile.variables.some(v =>
      (v.name === 'STRIPE_SECRET_KEY' || v.name === 'RAZORPAY_KEY_SECRET') && v.hasValue
    );
    if (hasKey) {
      return {
        category: 'payment',
        status: 'DANGEROUS',
        label: 'Payment Provider',
        detail: 'Payment integration detected. Test mode recommended before production.',
        targetService: 'stripe',
        recommendation: 'Ensure TEST mode keys are used during initial deployment.',
      };
    }
    return {
      category: 'payment',
      status: 'BLOCKED',
      label: 'Payment Provider',
      detail: 'Payment dependency detected but keys are missing.',
      requiredCredential: 'STRIPE_SECRET_KEY or RAZORPAY_KEY_SECRET',
      blockReason: 'Payment will fail without credentials.',
    };
  }
  return {
    category: 'payment',
    status: 'OPTIONAL',
    label: 'Payment Provider',
    detail: 'No payment dependency detected.',
  };
}

// ─── Main Function ─────────────────────────────────────────────

export async function checkDeploymentReadiness(
  userId: string,
  projectId: string,
  input: ReadinessInput
): Promise<DeploymentReadiness> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const readinessId = newId(PREFIX.DEPLOY_READINESS);

  const items: ReadinessItem[] = [
    checkDatabase(input.profile),
    checkRedis(input.profile),
    checkEnvironment(input.profile),
    checkFrontend(input.profile),
    checkBackend(input.profile),
    checkWorker(input.profile),
    checkDomain(input.profile),
    checkTls(input.profile),
    checkStorage(input.profile),
    checkEmail(input.profile),
    checkAi(input.profile),
    checkPayment(input.profile),
  ];

  const summary = {
    ready: items.filter(i => i.status === 'READY').length,
    missing: items.filter(i => i.status === 'MISSING').length,
    blocked: items.filter(i => i.status === 'BLOCKED').length,
    optional: items.filter(i => i.status === 'OPTIONAL').length,
    dangerous: items.filter(i => i.status === 'DANGEROUS').length,
  };

  const totalRequired = summary.ready + summary.blocked + summary.dangerous;
  const score = totalRequired > 0 ? Math.round((summary.ready / totalRequired) * 100) : 100;

  let overallStatus: DeploymentReadiness['overallStatus'] = 'READY';
  if (summary.blocked > 0) overallStatus = 'NOT_READY';
  else if (summary.missing > 0 || summary.dangerous > 0) overallStatus = 'PARTIAL';

  const componentCount = input.profile.components.length;
  const estimatedMinutes = Math.max(2, componentCount * 3 + summary.blocked * 5);
  const estimatedDeployTime = `${estimatedMinutes}-${estimatedMinutes + 10} minutes`;

  const result: DeploymentReadiness = {
    id: readinessId,
    profileId: input.profile.id,
    projectId,
    checkedAt: new Date(),
    overallStatus,
    score,
    items,
    summary,
    estimatedDeployTime,
  };

  await pool.query(
    `INSERT INTO deployment_readiness (id, profile_id, project_id, overall_status, score, items, summary, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [readinessId, input.profile.id, projectId, overallStatus, score, JSON.stringify(items), JSON.stringify(summary)],
  );

  await recordAudit({
    action: 'deployment_readiness_checked',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'deployment_readiness',
    resourceId: readinessId,
    detail: { overallStatus, score, blocked: summary.blocked },
  });

  return result;
}
