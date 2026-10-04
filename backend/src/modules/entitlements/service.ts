/**
 * CodeConClave — server-authoritative entitlement enforcement.
 * Plan features are enforced here (server-side), keyed on verified
 * entitlements only. PRO_PENDING grants nothing beyond the free tier.
 */
import { withTenant } from '../../shared/db.js';
import { env, paymentTestUserIds } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

/**
 * TEST-ONLY payment bypass (PAYMENT_TEST_USER_IDS). True only when the
 * allowlist is non-empty AND contains this exact user ID. Disabled by
 * default, never email-based, never client-influenced. Grants Team-level
 * workspace access for development/manual validation WITHOUT payment and
 * WITHOUT writing any entitlement or payment row. Ordinary users can never
 * activate it; the ID set lives server-side only.
 */
export function isPaymentTestUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (paymentTestUserIds.size === 0) return false;
  return paymentTestUserIds.has(userId);
}

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

/**
 * TEMPORARY DEMO / EARLY ACCESS MODE.
 *
 * TEMPORARY — remove together with `env.TEMPORARY_DEMO_MODE` after the Saturday
 * Kuberns demo. Reads the process environment on EVERY call (never cached at
 * import time) so the flag takes effect on the next request after a redeploy and
 * can be flipped back to 'false' to restore the paywall immediately.
 *
 * Server-side only: no client input, cookie, query parameter or request body can
 * influence this. Returns false for any value other than an explicit truthy
 * token, so a typo or empty string fails SAFE to commercial enforcement.
 */
export function temporaryDemoModeEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.TEMPORARY_DEMO_MODE ?? '').trim());
}

/**
 * Hard cap on human members per team (spec §74). Enforced server-side at
 * invitation time; existing members are never affected.
 */
export const TEAM_MAX_MEMBERS = 30;

/**
 * TEMPORARY DEMO / EARLY ACCESS MODE limits.
 *
 * Removing the payment barrier must NOT remove the safety caps, so these are
 * deliberately LOWER than PRO_LIMITS and strictly finite on every axis:
 *   - AGENT_MAX_BUDGET_USD 2  < PRO 5   (hard per-run AI spend stop)
 *   - MAX_PROJECTS 5         < PRO 10
 *   - DAILY_MESSAGES 100     < PRO 200
 *   - STORAGE_BYTES 5 GB     < PRO 100 GB
 * Plan-independent global caps (auth rate limits, RATE_LIMIT_*,
 * AI_PREMIUM_BUDGET_USD_PER_DAY) apply on top of these unchanged.
 * Reverting to FREE_LIMITS is a single flag flip, not a code change.
 */
export const DEMO_LIMITS: PlanLimits = {
  DAILY_MESSAGES: 100,
  MAX_PROJECTS: 5,
  STORAGE_BYTES: 5 * 1024 * 1024 * 1024,
  COWORKER_TYPES: COWORKERS_ALL,
  MAX_COWORKER_RUNS_PER_TASK: 9,
  MAX_AGENTS: 5,
  AGENT_MAX_TASKS_PER_RUN: 10,
  AGENT_MAX_BUDGET_USD: 2,
} as const;

export type PlanId = 'free' | 'pro' | 'team';

/**
 * Case-insensitive comparison against the configured PAYMENT_FOUNDER_EMAIL.
 *
 * SECURITY: this function answers "does this string equal the founder address?"
 * and NOTHING more. It deliberately does not assert founder entitlement —
 * an unverified account that merely registered the founder address must not
 * be treated as the founder. Use `isFounderAccount()` for that.
 */
export function isFounderEmail(email: string | null | undefined): boolean {
  const founder = env.PAYMENT_FOUNDER_EMAIL?.trim().toLowerCase();
  return !!founder && !!email && email.trim().toLowerCase() === founder;
}

/**
 * The authoritative founder-entitlement test.
 *
 * Founder workspace requires ALL of:
 *   1. the email matches PAYMENT_FOUNDER_EMAIL, AND
 *   2. that email is VERIFIED (proves the real founder controls the inbox), AND
 *   3. the account is flagged as the provisioned founder account
 *      (users.is_founder), which only the provisioning path sets.
 *
 * Requiring (1)+(2) closes the squat: registration accepts an unverified
 * founder address but that account can never satisfy (2). Requiring (3) means
 * even a verified holder of the address is not auto-promoted; the founder
 * account is provisioned explicitly, not by typing an address.
 */
export async function isFounderAccount(
  userId: string | null | undefined,
  opts?: { email?: string | null; emailVerified?: boolean | null },
): Promise<boolean> {
  if (!userId) return false;
  const row = await withTenant<{ email: string; email_verified: boolean; is_founder: boolean } | null>(userId, (q) =>
    q.query<{ email: string; email_verified: boolean; is_founder: boolean }>(
      'SELECT email, email_verified, is_founder FROM users WHERE id = $1',
      [userId],
    ).then((r) => r.rows[0] ?? null),
  );
  if (!row) return false;
  const email = opts?.email ?? row.email;
  const verified = opts?.emailVerified ?? row.email_verified;
  if (!row.is_founder) return false;
  if (!verified) return false;
  return isFounderEmail(email);
}

/** Effective plan = highest VERIFIED entitlement; PENDING states count as free. */
export async function effectivePlan(userId: string): Promise<PlanId> {
  const row = await withTenant<{ plan_id: string } | null>(userId, (q) =>
    q.query<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]).then((r) => r.rows[0] ?? null),
  );
  // Security: founder grant is gated on the provisioned + verified account
  // (see isFounderAccount), never on the email string alone.
  if (await isFounderAccount(userId)) return 'team';
  // TEST-ONLY bypass (PAYMENT_TEST_USER_IDS): development/manual validation
  // for explicitly allowlisted user IDs. Read-time override only — writes no
  // entitlement or payment rows. See isPaymentTestUser.
  if (isPaymentTestUser(userId)) return 'team';
  const base = row?.plan_id === 'pro' || row?.plan_id === 'team' ? row.plan_id : 'free';
  if (base === 'free') return 'free';
  if (await hasVerifiedEntitlement(userId, base)) return base;
  return 'free';
}

/**
 * Authoritative entitlement test used by every plan/capability gate.
 *
 * Requires the entitlement row to be PRO_VERIFIED **and not past its expiry**.
 * Bug fix: the previous gate compared only `state`, so an expired entitlement
 * stayed usable until a background sweep rewrote it — access therefore depended
 * on a worker running. Expiry is now evaluated here, at request time, so no
 * sweep is required for security. A NULL expires_at means "no expiry" and is
 * honoured (used by founder/complimentary grants).
 */
export async function hasVerifiedEntitlement(
  userId: string,
  planId: string,
): Promise<boolean> {
  const ent = await withTenant<{ state: string; expires_at: string | null } | null>(userId, (q) =>
    q
      .query<{ state: string; expires_at: string | null }>(
        `SELECT state, expires_at FROM entitlements
          WHERE user_id = $1 AND plan_id = $2
          ORDER BY updated_at DESC LIMIT 1`,
        [userId, planId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!ent) return false;
  if (ent.state !== 'PRO_VERIFIED') return false;
  if (!ent.expires_at) return true; // no expiry set (founder/complimentary grants)
  const expires = new Date(ent.expires_at).getTime();
  // FAIL CLOSED: an expires_at that is present but unparseable is corruption, and
  // treating it as "not expired" would silently grant paid access. Deny instead.
  if (!Number.isFinite(expires)) return false;
  return expires > Date.now();
}

export function limitsFor(plan: PlanId): PlanLimits {
  switch (plan) {
    case 'team':
      return TEAM_LIMITS;
    case 'pro':
      return PRO_LIMITS;
    default:
      // TEMPORARY DEMO MODE: raise the FREE plan's caps to bounded demo limits
      // so a demo account can actually create projects and run agents. This
      // ADJUSTS caps, it never removes them, and a user with a real paid plan
      // keeps their paid limits. Flag off => FREE_LIMITS exactly as before.
      return temporaryDemoModeEnabled() ? DEMO_LIMITS : FREE_LIMITS;
  }
}

export async function requirePlanFeature(userId: string, feature: 'projects' | 'storage' | 'coworkers' | 'plugins'): Promise<PlanId> {
  const plan = await effectivePlan(userId);
  const limits = limitsFor(plan);
  switch (feature) {
    case 'projects': {
      const count = await withTenant<{ n: number } | null>(userId, (q) =>
        q
          .query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM projects WHERE owner_id = $1 AND deleted_at IS NULL`,
            [userId],
          )
          .then((r) => r.rows[0] ?? null),
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