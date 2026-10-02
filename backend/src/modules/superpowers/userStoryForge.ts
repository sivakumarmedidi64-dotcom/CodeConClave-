/**
 * CodeConClave — Superpowers: USER STORY FORGE (Master Feature #76).
 *
 * Turns vague goals into complete, testable user stories with acceptance
 * criteria written as executable tests. Definition-of-Done pushed upstream.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface StoryForgeRow {
  id: string;
  owner_id: string;
  goal: string;
  story: string;
  tests: string[];
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): StoryForgeRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  goal: String(r.goal),
  story: String(r.story),
  tests: (r.tests ?? []) as string[],
  created_at: new Date(r.created_at as string),
});

/** Vague goal → role, desire, outcome, story, and executable tests. */
export function forgeStory(goal: string): { role: string; desire: string; outcome: string; story: string; tests: string[] } {
  const roleMatch = /as an? ([^,]+),/i.exec(goal);
  const rest = roleMatch ? goal.slice(roleMatch[0].length).trim() : goal;
  const wantMatch = /i (?:want|would like) to (.+)/i.exec(rest);
  const action = (wantMatch ? wantMatch[1]!.trim() : goal).trim();
  const sfMatch = /so that (.+)$/i.exec(action);
  const outcome = sfMatch ? sfMatch[1]!.trim() : action;
  const desire = sfMatch ? action.slice(0, action.length - sfMatch[0].length).trim().replace(/[,.\s]+$/, '') : action;
  const role = roleMatch ? roleMatch[1]!.trim() : 'one of our users';
  const story = `As a ${role}, I want to ${desire} so that ${outcome}`;
  const tests = [
    `given a fresh start, when ${desire} runs, then it returns a defined result`,
    `given valid input, when ${desire} runs, then no error is raised`,
    `given malformed input, when ${desire} runs, then it fails loudly`,
  ];
  return { role, desire, outcome, story, tests };
}

export async function forgeStoryRun(userId: string, input: { goal: string }): Promise<StoryForgeRow> {
  if (!input.goal || typeof input.goal !== 'string') throw AppError.badRequest('invalid_goal', 'a goal is required — even a vague one');
  const forged = forgeStory(input.goal);
  const id = newId(PREFIX.USER_STORY);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO story_forges (id, owner_id, goal, story, tests) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.goal, forged.story, forged.tests],
  ));
  await recordAudit({
    action: AuditAction.STORY_FORGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'story_forges',
    resourceId: id,
    detail: { goal: input.goal, tests: forged.tests.length },
  });
  return getStory(userId, id);
}

export async function getStory(userId: string, id: string): Promise<StoryForgeRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM story_forges WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('story_forge_not_found', 'no user story found for that id');
  return rowOf(row);
}

export async function listStories(userId: string): Promise<StoryForgeRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM story_forges WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function userStoryForgeReport(userId: string): Promise<{ stories: number; tests: number; roles: number }> {
  const stories = await listStories(userId);
  return {
    stories: stories.length,
    tests: stories.reduce((s, st) => s + st.tests.length, 0),
    roles: new Set(stories.map((st) => st.story.match(/^As a ([^,]+),/)![1]!)).size,
  };
}