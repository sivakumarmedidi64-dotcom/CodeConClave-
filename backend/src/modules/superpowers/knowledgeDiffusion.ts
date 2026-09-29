/**
 * CodeConClave — Superpowers: KNOWLEDGE DIFFUSION (Master Feature #55).
 *
 * When one engineer solves a hard problem, the lesson is automatically taught
 * to every agent and suggested to every human who touches that area. One
 * person's breakthrough becomes everyone's baseline.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface AgentDomain {
  agent: string;
  tokens: string[];
}

export const AGENT_DOMAINS: AgentDomain[] = [
  { agent: 'billing-agent', tokens: ['payment', 'billing', 'invoice', 'checkout'] },
  { agent: 'auth-agent', tokens: ['auth', 'login', 'session', 'token'] },
  { agent: 'data-agent', tokens: ['migration', 'schema', 'query', 'index'] },
  { agent: 'release-agent', tokens: ['release', 'deploy', 'rollback'] },
  { agent: 'runtime-agent', tokens: ['webhook', 'queue', 'cron', 'timeout'] },
  { agent: 'frontend-agent', tokens: ['ui', 'component', 'css', 'render'] },
];

export type KnowledgeDiffusionStatus = 'SEEDED' | 'DIFFUSED';

export interface KnowledgeDiffusionRow {
  id: string;
  owner_id: string;
  topic: string;
  lesson: string;
  area: string;
  agents: string[];
  reaches: number;
  retrievals: number;
  status: KnowledgeDiffusionStatus;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): KnowledgeDiffusionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  topic: String(r.topic),
  lesson: String(r.lesson),
  area: String(r.area),
  agents: (r.agents ?? []) as string[],
  reaches: Number(r.reaches),
  retrievals: Number(r.retrievals),
  status: r.status as KnowledgeDiffusionStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** Which agent domains should carry a lesson anchored to this area. */
export function coveringAgents(area: string): string[] {
  const lower = area.toLowerCase();
  return AGENT_DOMAINS.filter((d) => d.tokens.some((t) => lower.includes(t) || new RegExp(`\\b${t}`).test(lower))).map((d) => d.agent);
}

export async function seedLesson(userId: string, input: { topic: string; lesson: string; area: string }): Promise<KnowledgeDiffusionRow> {
  if (!input.topic || typeof input.topic !== 'string') throw AppError.badRequest('invalid_topic', 'a topic is required');
  if (!input.lesson || typeof input.lesson !== 'string') throw AppError.badRequest('invalid_lesson', 'a lesson is required');
  if (!input.area || typeof input.area !== 'string') throw AppError.badRequest('invalid_area', 'an area is required');
  const agents = coveringAgents(input.area);
  const id = newId(PREFIX.KNOWLEDGE_LESSON);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO knowledge_diffusions (id, owner_id, topic, lesson, area, agents, reaches, retrievals, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.topic, input.lesson, input.area, agents, agents.length, 0, 'SEEDED'],
  ));
  await recordAudit({
    action: AuditAction.KNOWLEDGE_SEEDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'knowledge_diffusions',
    resourceId: id,
    detail: { topic: input.topic, area: input.area, reaches: agents.length },
  });
  return getLesson(userId, id);
}

export async function diffuseLesson(userId: string, id: string): Promise<KnowledgeDiffusionRow> {
  const lesson = await getLesson(userId, id);
  if (lesson.status !== 'SEEDED') throw AppError.badRequest('lesson_not_seeded', 'only a fresh SEEDED lesson can diffuse');
  await withTenant(userId, (q) => q.query('UPDATE knowledge_diffusions SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'DIFFUSED', userId]));
  await recordAudit({
    action: AuditAction.KNOWLEDGE_DIFFUSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'knowledge_diffusions',
    resourceId: id,
    detail: { topic: lesson.topic, area: lesson.area },
  });
  return getLesson(userId, id);
}

/** Every agent about to touch this area pulls the lesson up. */
export async function retrieveLesson(userId: string, input: { area: string }): Promise<{ lessons: KnowledgeDiffusionRow[]; note: string }> {
  if (!input.area || typeof input.area !== 'string') throw AppError.badRequest('invalid_area', 'an area is required');
  const queryAgents = coveringAgents(input.area);
  const lessons = await listLessons(userId);
  const matched = lessons.filter((l) => l.agents.some((a) => queryAgents.includes(a)));
  for (const l of matched) {
    await withTenant(userId, (q) => q.query('UPDATE knowledge_diffusions SET retrievals = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [l.id, l.retrievals + 1, userId]));
  }
  await recordAudit({
    action: AuditAction.KNOWLEDGE_RETRIEVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'knowledge_diffusions',
    resourceId: matched[0]?.id ?? null,
    detail: { area: input.area, matched: matched.length },
  });
  const refreshed = await Promise.all(matched.map((l) => getLesson(userId, l.id)));
  const note = refreshed.length ? `${refreshed.length} lesson(s) surface for "${input.area}"` : `no lesson covers "${input.area}" yet`;
  return { lessons: refreshed, note };
}

export async function getLesson(userId: string, id: string): Promise<KnowledgeDiffusionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM knowledge_diffusions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('knowledge_lesson_not_found', 'no knowledge lesson found for that id');
  return rowOf(row);
}

export async function listLessons(userId: string): Promise<KnowledgeDiffusionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM knowledge_diffusions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function knowledgeReport(userId: string): Promise<{ lessons: number; seeded: number; diffused: number; coverage: number; retrievals: number }> {
  const lessons = await listLessons(userId);
  const covered = new Set<string>();
  for (const l of lessons) for (const a of l.agents) covered.add(a);
  return {
    lessons: lessons.length,
    seeded: lessons.filter((l) => l.status === 'SEEDED').length,
    diffused: lessons.filter((l) => l.status === 'DIFFUSED').length,
    coverage: AGENT_DOMAINS.length ? Math.round((covered.size / AGENT_DOMAINS.length) * 100) : 0,
    retrievals: lessons.reduce((s, l) => s + l.retrievals, 0),
  };
}