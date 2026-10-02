/**
 * CodeConClave — Superpowers: ONBOARDING SIMULATOR (Master Feature #79).
 *
 * An agent role-plays a confused new hire trying to set up and use your
 * project. Every point of friction becomes an onboarding fix ticket, before a
 * human ever hits the gotcha.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface SimStep {
  step: string;
  confusing: boolean;
}

export interface OnboardingSimRow {
  id: string;
  owner_id: string;
  profile: string;
  difficulty: number;
  steps: SimStep[];
  tickets: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): OnboardingSimRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  profile: String(r.profile),
  difficulty: Number(r.difficulty),
  steps: (r.steps ?? []) as SimStep[],
  tickets: (r.tickets ?? []) as string[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** The new hire's path through the setup docs. */
export function simulateSteps(): SimStep[] {
  return [
    { step: 'install dependencies', confusing: false },
    { step: 'configure environment variables', confusing: true },
    { step: 'run the dev server', confusing: true },
    { step: 'open the app for the first time', confusing: false },
  ];
}

export async function startOnboardingSim(userId: string, input: { profile: string; difficulty?: number }): Promise<OnboardingSimRow> {
  if (!input.profile || typeof input.profile !== 'string') throw AppError.badRequest('invalid_profile', 'a new-hire profile is required');
  const difficulty = typeof input.difficulty === 'number' && Number.isInteger(input.difficulty) && input.difficulty >= 1 && input.difficulty <= 10 ? input.difficulty : 5;
  const id = newId(PREFIX.ONBOARDING_SIM);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO onboarding_sims (id, owner_id, profile, difficulty, steps, tickets, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.profile, difficulty, simulateSteps(), [], 'PLAYING'],
  ));
  await recordAudit({
    action: AuditAction.ONBOARDING_SIM_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'onboarding_sims',
    resourceId: id,
    detail: { profile: input.profile },
  });
  return getOnboardingSim(userId, id);
}

/** Every friction point becomes an onboarding fix ticket. */
export async function completeSim(userId: string, id: string): Promise<OnboardingSimRow> {
  const sim = await getOnboardingSim(userId, id);
  if (sim.status !== 'PLAYING') throw AppError.badRequest('onboarding_sim_over', 'this onboarding sim already wrapped up');
  const tickets = sim.steps.filter((s) => s.confusing).map((s) => `onboarding fix: step "${s.step}" needs clearer instructions`);
  await withTenant(userId, (q) => q.query('UPDATE onboarding_sims SET tickets = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, tickets, 'COMPLETE', userId]));
  await recordAudit({
    action: AuditAction.ONBOARDING_SIM_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'onboarding_sims',
    resourceId: id,
    detail: { tickets: tickets.length },
  });
  return getOnboardingSim(userId, id);
}

export async function getOnboardingSim(userId: string, id: string): Promise<OnboardingSimRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM onboarding_sims WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('onboarding_sim_not_found', 'no onboarding sim found for that id');
  return rowOf(row);
}

export async function listOnboardingSims(userId: string): Promise<OnboardingSimRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM onboarding_sims WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function onboardingSimReport(userId: string): Promise<{ sims: number; complete: number; tickets: number }> {
  const sims = await listOnboardingSims(userId);
  return {
    sims: sims.length,
    complete: sims.filter((s) => s.status === 'COMPLETE').length,
    tickets: sims.reduce((s, x) => s + x.tickets.length, 0),
  };
}