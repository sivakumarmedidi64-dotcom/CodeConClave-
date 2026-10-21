/**
 * CodeConClave — plan usage limits (Claude-style).
 *
 * Measured in real tokens from model_usage_logs (input + output, exactly what
 * each provider/resident reported):
 *   session — starts with your first message and lasts USAGE_SESSION_HOURS
 *             (default 5h); the next message after it ends starts a new one.
 *   weekly  — the calendar week, resetting Monday 00:00 in the deployment's
 *             reset timezone (USAGE_WEEK_RESET_OFFSET_MINUTES, default IST).
 * Limits are deployment settings (LIMIT_<PLAN>_<WINDOW>_TOKENS, 0 = unlimited).
 *
 * There is NO free tier: an account without a verified Solo/Team plan (or API
 * Access) gets no AI at all ("none"). The only exception is the server-side
 * early-access demo mode, which has its own bounded "demo" limits.
 *
 * Enforced at the single AI gateway, so chat, Cowork bots, code review and
 * the API all count. A failed usage read never blocks work (quota, not a
 * security boundary) — it is logged and the request proceeds.
 */
import { env } from '../../config/env.js';
import { pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { effectivePlan, temporaryDemoModeEnabled } from '../entitlements/service.js';

export type LimitPlan = 'none' | 'demo' | 'solo' | 'team' | 'api';
export type Product = 'chats' | 'cowork' | 'code_review' | 'api_other';

export interface WindowUsage {
  used: number;
  limit: number;
  /** 0–100; 0 when unlimited. */
  pct: number;
  windowLabel: string;
  /** When this window resets (null = no active session yet). */
  resetsAt: string | null;
}

export interface PlanLimits {
  plan: LimitPlan;
  planLabel: string;
  session: WindowUsage & { active: boolean; startedAt: string | null };
  weekly: WindowUsage;
  /** This week's tokens split by product (sums to weekly.used). */
  byProduct: Record<Product, number>;
  /** Pace against the weekly limit, from usage so far this week. */
  forecast: 'unlimited' | 'on_track' | 'heavy' | 'limited' | 'no_plan';
  /** True when either window is at or over its limit. */
  limited: boolean;
}

/**
 * Which limit tier applies right now. Solo/Team come from the VERIFIED
 * entitlement (effectivePlan, which also honours founder/test grants), never
 * from users.plan_id alone, so a pending payment gets nothing. API Access
 * calls arrive already entitlement-checked by apiKeyAuth.
 */
export async function resolveLimitPlan(userId: string, planId: string | null | undefined): Promise<LimitPlan> {
  if (planId === 'api') return 'api';
  const plan = await effectivePlan(userId);
  if (plan === 'team') return 'team';
  if (plan === 'pro') return 'solo';
  return temporaryDemoModeEnabled() ? 'demo' : 'none';
}

const PLAN_LABEL: Record<LimitPlan, string> = { none: 'No plan', demo: 'Early access', solo: 'Solo', team: 'Team', api: 'API Access' };

export function limitsFor(plan: LimitPlan): { session: number; weekly: number } {
  switch (plan) {
    case 'solo':
      return { session: env.LIMIT_SOLO_SESSION_TOKENS, weekly: env.LIMIT_SOLO_WEEKLY_TOKENS };
    case 'team':
      return { session: env.LIMIT_TEAM_SESSION_TOKENS, weekly: env.LIMIT_TEAM_WEEKLY_TOKENS };
    case 'api':
      return { session: env.LIMIT_API_SESSION_TOKENS, weekly: env.LIMIT_API_WEEKLY_TOKENS };
    case 'demo':
      return { session: env.LIMIT_DEMO_SESSION_TOKENS, weekly: env.LIMIT_DEMO_WEEKLY_TOKENS };
    default:
      // No plan: nothing is included (blocked before these are read).
      return { session: 0, weekly: 0 };
  }
}

/** Monday 00:00 (at UTC+offsetMinutes) of the week containing `now`, as an instant. */
export function weekStartUtc(now: Date, offsetMinutes = 0): Date {
  const shift = offsetMinutes * 60_000;
  const local = new Date(now.getTime() + shift);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return new Date(d.getTime() - shift);
}

/**
 * Claude-style sessions: a session opens at a message and lasts `hours`; a
 * message after it closes opens the next one. Returns the session that is
 * still open at `now`, if any.
 */
export function activeSession(
  events: { at: Date; tokens: number }[],
  hours: number,
  now: Date,
): { startedAt: Date; endsAt: Date; used: number } | null {
  const span = hours * 3_600_000;
  let start: Date | null = null;
  let used = 0;
  for (const e of events) {
    if (!start || e.at.getTime() >= start.getTime() + span) {
      start = e.at;
      used = e.tokens;
    } else {
      used += e.tokens;
    }
  }
  if (!start || now.getTime() >= start.getTime() + span) return null;
  return { startedAt: start, endsAt: new Date(start.getTime() + span), used };
}

const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

/** Current usage against the plan's limits (reads the usage log). */
export async function planLimits(
  userId: string,
  planId: string | null | undefined,
  now = new Date(),
  resolved?: LimitPlan,
): Promise<PlanLimits> {
  const plan = resolved ?? (await resolveLimitPlan(userId, planId));
  const caps = limitsFor(plan);
  const hours = env.USAGE_SESSION_HOURS;
  const weekStart = weekStartUtc(now, env.USAGE_WEEK_RESET_OFFSET_MINUTES);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  // Sessions can only span the last 2×hours; scan that much, oldest first.
  const recent = (
    await pool.query<{ created_at: Date; tokens: string | number }>(
      `SELECT created_at, (input_tokens + output_tokens) AS tokens
         FROM model_usage_logs
        WHERE user_id = $1 AND created_at >= now() - make_interval(hours => $2)
        ORDER BY created_at ASC
        LIMIT 5000`,
      [userId, hours * 2],
    )
  ).rows;
  const products = (
    await pool.query<{ product: Product; tokens: string | number }>(
      `SELECT CASE
                WHEN task_id IS NOT NULL THEN 'cowork'
                WHEN session_id LIKE 'pr-review:%' THEN 'code_review'
                WHEN conversation_id IS NOT NULL THEN 'chats'
                ELSE 'api_other'
              END AS product,
              coalesce(sum(input_tokens + output_tokens), 0) AS tokens
         FROM model_usage_logs
        WHERE user_id = $1 AND created_at >= $2
        GROUP BY 1`,
      [userId, weekStart],
    )
  ).rows;

  const byProduct: Record<Product, number> = { chats: 0, cowork: 0, code_review: 0, api_other: 0 };
  for (const p of products) if (p.product in byProduct) byProduct[p.product] = Number(p.tokens) || 0;
  const weeklyUsed = Object.values(byProduct).reduce((a, b) => a + b, 0);

  const s = activeSession(
    recent.map((r) => ({ at: new Date(r.created_at), tokens: Number(r.tokens) || 0 })),
    hours,
    now,
  );
  const session = {
    used: s?.used ?? 0,
    limit: caps.session,
    pct: pct(s?.used ?? 0, caps.session),
    windowLabel: `${hours}-hour session`,
    resetsAt: s ? s.endsAt.toISOString() : null,
    active: Boolean(s),
    startedAt: s ? s.startedAt.toISOString() : null,
  };
  const weekly: WindowUsage = {
    used: weeklyUsed,
    limit: caps.weekly,
    pct: pct(weeklyUsed, caps.weekly),
    windowLabel: 'weekly',
    resetsAt: weekEnd.toISOString(),
  };

  if (plan === 'none') {
    return { plan, planLabel: PLAN_LABEL[plan], session, weekly, byProduct, forecast: 'no_plan', limited: true };
  }
  const over = (w: WindowUsage) => w.limit > 0 && w.used >= w.limit;
  const limited = over(session) || over(weekly);
  let forecast: PlanLimits['forecast'] = 'unlimited';
  if (weekly.limit > 0) {
    const elapsed = Math.max((now.getTime() - weekStart.getTime()) / (7 * 86_400_000), 1 / (7 * 24));
    const projected = weeklyUsed / elapsed;
    forecast = over(weekly) ? 'limited' : projected <= weekly.limit * 0.9 ? 'on_track' : 'heavy';
  }
  return { plan, planLabel: PLAN_LABEL[plan], session, weekly, byProduct, forecast, limited };
}

const PLAN_REQUIRED = () =>
  AppError.paymentRequired(
    'plan_required',
    'CodeConClave has no free tier. Choose Solo (₹999/month), Team (₹4,999/month) or API Access to use CodeConClave AI.',
  );

function friendlyTime(iso: string | null): string {
  if (!iso) return 'soon';
  const d = new Date(iso);
  const mins = Math.max(1, Math.round((d.getTime() - Date.now()) / 60_000));
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)} hr ${mins % 60} min`;
  return `on ${d.toUTCString().slice(0, 22)} UTC`;
}

/**
 * Gateway guard: refuse new AI work once a window is full, with an honest
 * message saying which limit and when it resets. Read failures fail open.
 */
export async function assertWithinPlanLimits(userId: string, planId: string | null | undefined): Promise<void> {
  let limits: PlanLimits;
  try {
    const plan = await resolveLimitPlan(userId, planId);
    // No free tier: refuse before reading any usage.
    if (plan === 'none') throw PLAN_REQUIRED();
    limits = await planLimits(userId, planId, new Date(), plan);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn('plan usage limit check unavailable', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!limits.limited) return;
  const sessionHit = limits.session.limit > 0 && limits.session.used >= limits.session.limit;
  const hit = sessionHit ? limits.session : limits.weekly;
  throw new AppError(
    429,
    'usage_limit_reached',
    `You've reached your ${limits.planLabel} plan's ${hit.windowLabel} usage limit. It resets ${friendlyTime(hit.resetsAt)}.`,
    { plan: limits.plan, window: sessionHit ? 'session' : 'weekly', resetsAt: hit.resetsAt, used: hit.used, limit: hit.limit },
  );
}
