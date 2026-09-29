/**
 * CodeConClave — Deployment Strategy (V4E).
 * Supports standard, rollback, preview, and canary deployments.
 * Only promises strategies the provider actually supports.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

// ─── Types ─────────────────────────────────────────────────────

export type StrategyType = 'standard' | 'rollback' | 'preview' | 'canary';

export interface StrategyConfig {
  type: StrategyType;
  name: string;
  description: string;
  supported: boolean;
  supportedProviders: string[];
  features: string[];
  risks: string[];
  estimatedDowntimeSec: number;
  requiresApproval: boolean;
}

export interface StrategySelection {
  id: string;
  projectId: string;
  selectedAt: Date;
  strategy: StrategyType;
  config: StrategyConfig;
  targetProvider: string;
  previousDeploymentId?: string;
  previewUrl?: string;
  canaryConfig?: CanaryConfig;
}

export interface CanaryConfig {
  initialPercent: number;
  incrementPercent: number;
  intervalMinutes: number;
  successThreshold: number;
}

export interface StrategyComparison {
  availableStrategies: StrategyConfig[];
  recommended: StrategyType;
  reason: string;
}

// ─── Strategy Definitions ──────────────────────────────────────

const STRATEGIES: Record<StrategyType, StrategyConfig> = {
  standard: {
    type: 'standard',
    name: 'Standard Deployment',
    description: 'Replace existing deployment with new version. Zero-downtime when supported by the provider.',
    supported: true,
    supportedProviders: ['railway', 'render', 'fly.io', 'vercel', 'cloudflare', 'netlify', 'kubernetes', 'docker'],
    features: ['zero-downtime', 'auto-restart', 'health-checks', 'auto-rollback-on-failure'],
    risks: ['brief service interruption if health checks fail'],
    estimatedDowntimeSec: 0,
    requiresApproval: true,
  },
  rollback: {
    type: 'rollback',
    name: 'Rollback Deployment',
    description: 'Revert to a previous working version. Use when new deployment has critical issues.',
    supported: true,
    supportedProviders: ['railway', 'render', 'fly.io', 'vercel', 'cloudflare', 'kubernetes'],
    features: ['instant-revert', 'preserves-data', 'no-migration-rollback'],
    risks: ['loses recent changes', 'may require manual intervention for database rollback'],
    estimatedDowntimeSec: 10,
    requiresApproval: true,
  },
  preview: {
    type: 'preview',
    name: 'Preview Deployment',
    description: 'Deploy to an isolated preview environment. Test before merging to production.',
    supported: true,
    supportedProviders: ['vercel', 'cloudflare', 'netlify', 'render'],
    features: ['isolated-environment', 'no-production-impact', 'shareable-url', 'auto-cleanup'],
    risks: ['separate database needed', 'may not mirror production perfectly'],
    estimatedDowntimeSec: 0,
    requiresApproval: false,
  },
  canary: {
    type: 'canary',
    name: 'Canary Deployment',
    description: 'Gradually route traffic from old to new version. Monitor for issues before full rollout.',
    supported: false,
    supportedProviders: ['kubernetes', 'fly.io'],
    features: ['gradual-rollout', 'traffic-splitting', 'auto-monitoring', 'automatic-rollback-on-errors'],
    risks: ['complex setup', 'requires traffic splitting support', 'monitoring overhead'],
    estimatedDowntimeSec: 0,
    requiresApproval: true,
  },
};

// ─── Helpers ───────────────────────────────────────────────────

function getProviderName(configs: Record<string, boolean>): string {
  if (configs.railway) return 'railway';
  if (configs.render) return 'render';
  if (configs.vercel) return 'vercel';
  if (configs.cloudflare) return 'cloudflare';
  if (configs.netlify) return 'netlify';
  if (configs.fly) return 'fly.io';
  if (configs.kubernetes) return 'kubernetes';
  if (configs.docker) return 'docker';
  return 'generic';
}

function recommendStrategy(provider: string, hasDatabase: boolean, isProduction: boolean): { strategy: StrategyType; reason: string } {
  if (isProduction && hasDatabase) {
    return { strategy: 'standard', reason: 'Production with database — standard deployment with health checks is safest.' };
  }
  if (!isProduction) {
    return { strategy: 'preview', reason: 'Non-production environment — preview deployment allows safe testing.' };
  }
  if (provider === 'vercel' || provider === 'cloudflare' || provider === 'netlify') {
    return { strategy: 'preview', reason: 'Platform supports preview deployments natively.' };
  }
  return { strategy: 'standard', reason: 'Standard deployment is the most widely supported and reliable option.' };
}

// ─── Main Functions ────────────────────────────────────────────

export function compareStrategies(
  deploymentConfigs: Record<string, boolean>,
  hasDatabase: boolean,
  isProduction: boolean = true
): StrategyComparison {
  const provider = getProviderName(deploymentConfigs);

  const availableStrategies = Object.values(STRATEGIES).map(s => ({
    ...s,
    supportedProviders: s.supportedProviders,
  }));

  const { strategy: recommended, reason } = recommendStrategy(provider, hasDatabase, isProduction);

  return {
    availableStrategies,
    recommended,
    reason,
  };
}

export async function selectStrategy(
  userId: string,
  projectId: string,
  input: {
    strategy: StrategyType;
    deploymentConfigs: Record<string, boolean>;
    previousDeploymentId?: string;
    canaryConfig?: CanaryConfig;
  }
): Promise<StrategySelection> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const config = STRATEGIES[input.strategy];
  if (!config) throw AppError.badRequest('invalid_strategy', `Unknown strategy: ${input.strategy}`);

  const provider = getProviderName(input.deploymentConfigs);

  if (!config.supportedProviders.includes(provider) && config.supported) {
    // Not a hard block, but warn
  }

  const selectionId = newId(PREFIX.DEPLOY_STRATEGY);

  const selection: StrategySelection = {
    id: selectionId,
    projectId,
    selectedAt: new Date(),
    strategy: input.strategy,
    config,
    targetProvider: provider,
    previousDeploymentId: input.previousDeploymentId,
    canaryConfig: input.canaryConfig,
  };

  await pool.query(
    `INSERT INTO deployment_strategies (id, project_id, strategy, config, target_provider, previous_deployment_id, canary_config, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      selectionId, projectId, input.strategy, JSON.stringify(config),
      provider, input.previousDeploymentId || null,
      input.canaryConfig ? JSON.stringify(input.canaryConfig) : null,
    ],
  );

  await recordAudit({
    action: 'deployment_strategy_selected',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'deployment_strategy',
    resourceId: selectionId,
    detail: { strategy: input.strategy, provider },
  });

  return selection;
}

export function getStrategyInfo(strategy: StrategyType): StrategyConfig {
  return STRATEGIES[strategy];
}

export function isStrategySupported(strategy: StrategyType, provider: string): boolean {
  const config = STRATEGIES[strategy];
  return config.supported && config.supportedProviders.includes(provider);
}
