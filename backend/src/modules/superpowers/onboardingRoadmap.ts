/**
 * CodeConClave — Superpowers: ONBOARDING ROADMAP (Master Feature #140).
 *
 * Generates a personalized first-week task roadmap for a new hire — scoped to
 * role, team and seniority. Onboarding stops being ad-hoc; the first week is
 * a shipped plan.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type OnboardingSeniority = 'JUNIOR' | 'MID' | 'SENIOR';

export interface OnboardingTask {
  day: number;
  title: string;
  goal: string;
  deliverable: string;
}

export interface OnboardingRoadmapRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  role: string;
  team: string;
  seniority: OnboardingSeniority;
  days: number;
  tasks: OnboardingTask[];
  created_at: Date;
}

const ROLE_TASKS: Record<string, string[]> = {
  Frontend: [
    'Set up ${team} locally and run the app end-to-end',
    'Fix a tagged first issue in ${team} UI',
    'Shadow the component catalogue and pick one gap',
    'Contribute an a11y pass to a ${team} screen',
    'Pair on a release-critical frontend fix',
  ],
  Backend: [
    'Set up ${team} locally with seeded data',
    'Trace one API request through the ${team} stack',
    'Write a test for an uncovered ${team} endpoint',
    'Review a PR touching ${team} data access',
    'Ship an isolated ${team} bug fix with tests',
  ],
  Database: [
    'Connect to the ${team} staging DB read-only',
    'Map the ${team} schema and note drift',
    'Draft a reversible migration for ${team}',
    'Backfill-check a ${team} table for orphans',
    'Optimize one slow ${team} query',
  ],
  DevOps: [
    'Deploy ${team} staging from a branch',
    'Trip-wire a ${team} alert and route on-call',
    'Review a ${team} terraform diff dry-run',
    'Run a ${team} backup restore rehearsal',
    'Automate one ${team} release step',
  ],
  Data: [
    'Read the ${team} pipeline DAG end-to-end',
    'Verify ${team} freshness SLAs',
    'Hand-grep a ${team} anomaly with evidence',
    'Draft a ${team} backfill with rollback',
    'Publish a ${team} data-quality finding',
  ],
};

const SENIORITY_GOAL: Record<OnboardingSeniority, string> = {
  JUNIOR: 'build fundamentals in a safe, watched setting',
  MID: 'own a vertical slice end-to-end',
  SENIOR: 'own the architecture and on-call surface of your scope',
};

const rowOf = (r: Record<string, unknown>): OnboardingRoadmapRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  role: String(r.role),
  team: String(r.team),
  seniority: r.seniority as OnboardingSeniority,
  days: Number(r.days),
  tasks: (r.tasks ?? []) as OnboardingTask[],
  created_at: new Date(r.created_at as string),
});

export function buildRoadmapTasks(role: string, team: string, seniority: OnboardingSeniority, days: number): OnboardingTask[] {
  const poolTasks = ROLE_TASKS[role] ?? [
    'Set up ${team} locally end-to-end',
    'Trace one ${team} feature from request to data',
    'Fix a tagged ${team} issue with tests',
    'Review a ${team} PR with your mentor',
    'Ship a small ${team} improvement',
  ];
  const tasks: OnboardingTask[] = [];
  for (let d = 1; d <= days; d += 1) {
    const idx = seniority === 'SENIOR' ? d : seniority === 'MID' ? d + 1 : d - 1;
    const title = poolTasks[((idx % poolTasks.length) + poolTasks.length) % poolTasks.length]!.replace(/\$\{team\}/g, team);
    tasks.push({
      day: d,
      title,
      goal: `day ${d}: ${SENIORITY_GOAL[seniority]}`,
      deliverable: d < days ? 'working code, reviewed and merged' : 'first week summary with demoable output',
    });
  }
  return tasks;
}

export async function generateOnboardingRoadmap(
  userId: string,
  input: {
    projectId?: string | null;
    role: string;
    team: string;
    seniority: OnboardingSeniority;
    days?: number;
  },
): Promise<OnboardingRoadmapRow> {
  if (!input.role || typeof input.role !== 'string') throw AppError.badRequest('invalid_role', 'a role is required');
  if (!input.team || typeof input.team !== 'string') throw AppError.badRequest('invalid_team', 'a team is required');
  const seniority = input.seniority ?? 'JUNIOR';
  if (!['JUNIOR', 'MID', 'SENIOR'].includes(seniority)) throw AppError.badRequest('invalid_seniority', 'seniority must be JUNIOR, MID or SENIOR');
  const days = Math.max(1, Math.min(10, input.days ?? 5));
  const tasks = buildRoadmapTasks(input.role, input.team, seniority, days);
  const id = newId(PREFIX.ONBOARDING_ROADMAP);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO onboarding_roadmaps (id, owner_id, project_id, role, team, seniority, days, tasks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.projectId ?? null, input.role, input.team, seniority, days, tasks],
  ));
  await recordAudit({
    action: AuditAction.ONBOARDING_ROADMAP_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'onboarding_roadmaps',
    resourceId: id,
    detail: { role: input.role, team: input.team, seniority, days },
  });
  return getOnboardingRoadmap(userId, id);
}

export async function getOnboardingRoadmap(userId: string, id: string): Promise<OnboardingRoadmapRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM onboarding_roadmaps WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('onboarding_roadmap_not_found', 'no onboarding roadmap found for that id');
  return rowOf(row);
}

export async function listOnboardingRoadmaps(userId: string, filter: { role?: string } = {}): Promise<OnboardingRoadmapRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM onboarding_roadmaps WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.role) rows = rows.filter((r) => r.role === filter.role);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function onboardingRoadmapReport(userId: string): Promise<{
  total: number;
  by_seniority: Record<OnboardingSeniority, number>;
}> {
  const rows = await listOnboardingRoadmaps(userId);
  const by_seniority: Record<OnboardingSeniority, number> = { JUNIOR: 0, MID: 0, SENIOR: 0 };
  for (const r of rows) by_seniority[r.seniority] += 1;
  return { total: rows.length, by_seniority };
}