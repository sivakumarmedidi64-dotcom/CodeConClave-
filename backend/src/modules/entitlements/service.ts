/**
 * CodeConClave — server-authoritative entitlement enforcement.
 * Plan features are enforced here (server-side), keyed on verified
 * entitlements only. PRO_PENDING grants nothing beyond the free tier.
 */
import { queryOne } from '../../shared/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

export interface PlanLimits {
  DAILY_MESSAGES: number;
  MAX_PROJECTS: number;
  STORAGE_BYTES: number;
  COWORKER_TYPES: readonly string[];
  MAX_COWORKER_RUNS_PER_TASK: number;
  /** Multi-agent workspace (Stage 25.5): max concurrent agent configs per plan. */
  MAX_AGENTS: number;
  /** Max tasks one agent run may create (bounded execution). */
  AGENT_MAX_TASKS_PER_RUN: number;
  /** Max cost (USD) an agent run may consume before it is blocked. */
  AGENT_MAX_BUDGET_USD: number;
}

const COWORKERS_ALL = [
  'ARCHITECT',
  'CODER',
  'SECURITY',
  'TESTER',
  'PERFORMANCE',
  'RESEARCH',
  'DOCS',
  'REVIEWER',
  'PLANNER',
] as const;

export const FREE_LIMITS: PlanLimits = {
  DAILY_MESSAGES: 20,
  MAX_PROJECTS: 1,
  STORAGE_BYTES: 2 * 1024 * 1024 * 1024,
  COWORKER_TYPES: ['ARCHITECT', 'PLANNER'], // free: planner + architect only
  MAX_COWORKER_RUNS_PER_TASK: 3,
  MAX_AGENTS: 2,
  AGENT_MAX_TASKS_PER_RUN: 5,
  AGENT_MAX_BUDGET_USD: 1,
} as const;

export const PRO_LIMITS: PlanLimits = {
  DAILY_MESSAGES: 200,
  MAX_PROJECTS: 10,
  STORAGE_BYTES: 100 * 1024 * 1024 * 1024,
  COWORKER_TYPES: COWORKERS_ALL,
  MAX_COWORKER_RUNS_PER_TASK: 9,
  MAX_AGENTS: 10,
  AGENT_MAX_TASKS_PER_RUN: 10,
  AGENT_MAX_BUDGET_USD: 5,
} as const;

export const TEAM_LIMITS: PlanLimits = {
  DAILY_MESSAGES: 600,
  MAX_PROJECTS: 30,
  STORAGE_BYTES: 500 * 1024 * 1024 * 1024,
  COWORKER_TYPES: COWORKERS_ALL,
  MAX_COWORKER_RUNS_PER_TASK: 9,
  MAX_AGENTS: 20,
  AGENT_MAX_TASKS_PER_RUN: 10,
  AGENT_MAX_BUDGET_USD: 10,
} as const;

export type PlanId = 'free' | 'pro' | 'team';

/** Effective plan = highest VERIFIED entitlement; PENDING states count as free. */
export async function effectivePlan(userId: string): Promise<PlanId> {
  const row = await queryOne<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]);
  const base = row?.plan_id === 'pro' || row?.plan_id === 'team' ? row.plan_id : 'free';
  if (base === 'free') return 'free';
  const ent = await queryOne<{ state: string }>(
    'SELECT state FROM entitlements WHERE user_id = $1 AND plan_id = $2 ORDER BY updated_at DESC LIMIT 1',
    [userId, base],
  );
  if (ent?.state === 'PRO_VERIFIED') return base;
  return 'free';
}

export function limitsFor(plan: PlanId): PlanLimits {
  switch (plan) {
    case 'team':
      return TEAM_LIMITS;
    case 'pro':
      return PRO_LIMITS;
    default:
      return FREE_LIMITS;
  }
}

export async function requirePlanFeature(userId: string, feature: 'projects' | 'storage' | 'coworkers' | 'plugins'): Promise<PlanId> {
  const plan = await effectivePlan(userId);
  const limits = limitsFor(plan);
  switch (feature) {
    case 'projects': {
      const { queryOne } = await import('../../shared/db.js');
      const count = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM projects WHERE owner_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const max = limits.MAX_PROJECTS;
      if ((count?.n ?? 0) >= max) {
        throw AppError.paymentRequired('plan_limit', `Project limit (${max}) reached for the ${plan} plan`);
      }
      return plan;
    }
    case 'storage': {
      const { getStorageUsage } = await import('../workspace/service.js');
      const used = await getStorageUsage(userId);
      const max = limits.STORAGE_BYTES;
      if (used >= max) throw AppError.paymentRequired('storage_limit', `Storage limit (${max}) reached`);
      return plan;
    }
    default:
      return plan;
  }
}

/** Express middleware: authenticated user must have a verified plan for paid features. */
export function requireEntitlement(plan: 'pro' | 'team') {
  return async (req: { ctx?: { user?: { id: string } } }, res: unknown, next: (err?: unknown) => void): Promise<void> => {
    const userId = req.ctx?.user?.id;
    if (!userId) {
      next(AppError.unauthorized());
      return;
    }
    const current = await effectivePlan(userId);
    if (current !== plan && !(plan === 'pro' && current === 'team')) {
      next(AppError.paymentRequired('entitlement_required', `This feature requires the ${plan === 'pro' ? 'Pro' : 'Team'} plan`));
      return;
    }
    next();
  };
}

export function isFreeTier(userId: string): Promise<boolean> {
  return effectivePlan(userId).then((p) => p === 'free');
}

export function envFreeDailyMessages(): number {
  return env.FREE_DAILY_MESSAGES;
}