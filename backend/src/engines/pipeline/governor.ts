/**
 * Budget governor — per-run token cap, locked at Intake. Cache first, one
 * role per task, and overage → ask first: an attempt that would exceed the
 * cap is not started; the run stops with NEEDS_BUDGET and says why.
 */
export type BudgetTier = 'demo' | 'solo' | 'team' | 'api';
export type Effort = 'low' | 'medium' | 'high';

/** Per-run caps by plan tier (tokens, all attempts + scout). */
export const TIER_RUN_CAP: Record<BudgetTier, number> = { demo: 12_000, solo: 24_000, team: 48_000, api: 48_000 };
export const EFFORT_ATTEMPT_TOKENS: Record<Effort, number> = { low: 1024, medium: 4096, high: 8192 };
export const SCOUT_TOKENS = 300;

export interface Budget {
  tier: BudgetTier;
  cap: number;
  perAttempt: number;
}

export function lockBudget(tier: BudgetTier, effort: Effort): Budget {
  const perAttempt = EFFORT_ATTEMPT_TOKENS[effort];
  return { tier, cap: Math.min(TIER_RUN_CAP[tier], SCOUT_TOKENS + perAttempt * 3), perAttempt };
}

/** Rough prompt-size estimate (≈4 chars per token). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export function canAfford(budget: Budget, spent: number, promptChars: number): { ok: true } | { ok: false; need: number; left: number } {
  const need = estimateTokens(promptChars) + budget.perAttempt;
  const left = budget.cap - spent;
  return need <= left ? { ok: true } : { ok: false, need, left: Math.max(0, left) };
}
