/**
 * CodeConClave — brainstorming module (Phase 13).
 * Sessions, participants and captured/generated ideas. AI-assisted generation
 * is strictly gated: AI GATEWAY -> structured zod schema -> validation ->
 * persist. Raw model output is never trusted as state; a failed parse or
 * validation persists nothing. AI-derived ideas carry ai_generated=true and a
 * brainstorm provenance.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { completeWithFallback } from '../ai/gateway.js';
import type { GatewayContext } from '../ai/gateway.js';
import { configuredProviders } from '../ai/registry.js';
import { AuditAction, BrainstormGrouping, NotificationType } from '@codeconclave/shared';
import { createIdea } from '../ideas/service.js';
import { z } from 'zod';

export interface BrainstormSessionRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  status: string;
  grouping: string;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface BrainstormParticipantRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
}

export interface BrainstormIdeaRow {
  id: string;
  session_id: string;
  idea_id: string | null;
  created_by: string;
  proposal: string;
  grouping: string | null;
  ai_generated: boolean;
  created_at: Date;
}

export function toSessionJson(s: BrainstormSessionRow) {
  return {
    id: s.id,
    ownerId: s.owner_id,
    title: s.title,
    description: s.description ?? null,
    status: s.status,
    grouping: s.grouping,
    endedAt: s.ended_at ?? null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function toParticipantJson(p: BrainstormParticipantRow) {
  return {
    id: p.id,
    sessionId: p.session_id,
    userId: p.user_id,
    role: p.role,
    joinedAt: p.joined_at,
  };
}

function toBrainstormIdeaJson(b: BrainstormIdeaRow) {
  return {
    id: b.id,
    sessionId: b.session_id,
    ideaId: b.idea_id ?? null,
    createdBy: b.created_by,
    proposal: b.proposal,
    grouping: b.grouping ?? null,
    aiGenerated: b.ai_generated,
    createdAt: b.created_at,
  };
}

export async function getSession(userId: string, sessionId: string): Promise<BrainstormSessionRow> {
  const row = await queryOne<BrainstormSessionRow>(
    `SELECT * FROM brainstorming_sessions WHERE id = $1
       AND (owner_id = $2 OR id IN (
         SELECT session_id FROM brainstorming_participants WHERE user_id = $2
       ))`,
    [sessionId, userId],
  );
  if (!row) throw AppError.notFound('Brainstorm session');
  return row;
}

async function requireHost(userId: string, sessionId: string): Promise<string> {
  const rows = await queryMany<{ role: string }>(
    'SELECT role FROM brainstorming_participants WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  const role = rows[0]?.role ?? null;
  if (role !== 'HOST') throw AppError.forbidden('host_only', 'Only the session host can do this');
  return role;
}

async function requireParticipant(userId: string, sessionId: string): Promise<void> {
  await getSession(userId, sessionId);
}

export interface CreateBrainstormInput {
  title: string;
  description?: string;
  grouping?: string;
}

export async function createSession(userId: string, input: CreateBrainstormInput) {
  const id = newId(PREFIX.BRAINSTORM);
  const sessionRows = await queryMany<BrainstormSessionRow>(
    `INSERT INTO brainstorming_sessions (id, owner_id, title, description, grouping)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, userId, input.title, input.description ?? null, input.grouping ?? BrainstormGrouping.NONE],
  );
  await pool.query(
    `INSERT INTO brainstorming_participants (id, session_id, user_id, role)
     VALUES ($1,$2,$3,'HOST')`,
    [newId(PREFIX.BRAINSTORM_PARTICIPANT), id, userId],
  );
  await recordAudit({
    action: AuditAction.BRAINSTORM_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'brainstorm',
    resourceId: id,
    detail: { title: input.title },
  });
  return toSessionJson(sessionRows[0] as BrainstormSessionRow);
}

export async function addParticipant(userId: string, sessionId: string, participantUserId: string) {
  const session = await getSession(userId, sessionId);
  await requireHost(userId, sessionId);
  if (session.status !== 'ACTIVE') throw AppError.conflict('session_not_active', 'Session is not active');
  await pool.query(
    `INSERT INTO brainstorming_participants (id, session_id, user_id, role)
     VALUES ($1,$2,$3,'PARTICIPANT') ON CONFLICT (session_id, user_id) DO NOTHING`,
    [newId(PREFIX.BRAINSTORM_PARTICIPANT), sessionId, participantUserId],
  );
  await notify(participantUserId, NotificationType.BRAINSTORM_INVITE, `You were invited to a brainstorm: ${session.title}`, {
    resourceType: 'brainstorm',
    resourceId: sessionId,
    body: `Join the brainstorm "${session.title}" and share your ideas.`,
  });
  const rows = await queryMany<BrainstormParticipantRow>(
    'SELECT * FROM brainstorming_participants WHERE session_id = $1 ORDER BY joined_at ASC',
    [sessionId],
  );
  return rows.map(toParticipantJson);
}

export async function listSessions(userId: string) {
  const rows = await queryMany<BrainstormSessionRow>(
    `SELECT s.* FROM brainstorming_sessions s
     WHERE s.owner_id = $1 OR s.id IN (
       SELECT session_id FROM brainstorming_participants WHERE user_id = $1
     )
     ORDER BY s.created_at DESC LIMIT 200`,
    [userId],
  );
  return rows.map(toSessionJson);
}

export interface SessionDetail {
  session: ReturnType<typeof toSessionJson>;
  participants: ReturnType<typeof toParticipantJson>[];
  ideas: ReturnType<typeof toBrainstormIdeaJson>[];
}

export async function getSessionDetail(userId: string, sessionId: string): Promise<SessionDetail> {
  const session = await getSession(userId, sessionId);
  const participants = await queryMany<BrainstormParticipantRow>(
    'SELECT * FROM brainstorming_participants WHERE session_id = $1 ORDER BY joined_at ASC',
    [sessionId],
  );
  const ideas = await queryMany<BrainstormIdeaRow>(
    'SELECT * FROM brainstorming_ideas WHERE session_id = $1 ORDER BY created_at ASC LIMIT 200',
    [sessionId],
  );
  return {
    session: toSessionJson(session),
    participants: participants.map(toParticipantJson),
    ideas: ideas.map(toBrainstormIdeaJson),
  };
}

export interface CaptureIdeaInput {
  proposal: string;
  grouping?: string;
}

export async function captureIdea(userId: string, sessionId: string, input: CaptureIdeaInput) {
  const session = await getSession(userId, sessionId);
  await requireParticipant(userId, sessionId);
  if (session.status !== 'ACTIVE') throw AppError.conflict('session_not_active', 'Session is not active');
  const truncated = input.proposal.length > 200 ? `${input.proposal.slice(0, 200)}…` : input.proposal;
  const idea = await createIdea(userId, {
    title: truncated,
    description: input.proposal.length > 200 ? input.proposal : undefined,
    provenance: `brainstorm://${sessionId}`,
    aiGenerated: false,
    references: [],
  });
  const rows = await queryMany<BrainstormIdeaRow>(
    `INSERT INTO brainstorming_ideas (id, session_id, idea_id, created_by, proposal, grouping, ai_generated)
     VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *`,
    [
      newId(PREFIX.BRAINSTORM_IDEA),
      sessionId,
      idea.id,
      userId,
      input.proposal,
      input.grouping ?? null,
    ],
  );
  await recordAudit({
    action: AuditAction.BRAINSTORM_IDEA_CAPTURED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'brainstorm',
    resourceId: sessionId,
    detail: { ideaId: idea.id, aiGenerated: false },
  });
  return { brainstormIdea: toBrainstormIdeaJson(rows[0] as BrainstormIdeaRow), idea };
}

// ---------------------------------------------------------------- AI generation

const generatedIdeaSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
});

interface GeneratedIdea {
  title: string;
  description?: string | null;
  tags?: string[];
}

function parseGeneratedIdeas(text: string, maxCount: number): GeneratedIdea[] {
  let clean = text.trim();
  const fence = clean.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) clean = fence[1]!.trim();
  const parsed: unknown = JSON.parse(clean);
  const list = Array.isArray(parsed) ? parsed : (parsed as { ideas?: unknown[] }).ideas;
  if (!Array.isArray(list)) throw new Error('no ideas array');
  return list.slice(0, maxCount).map((raw) => generatedIdeaSchema.parse(raw));
}

export interface GenerateIdeasInput {
  topic: string;
  count: number;
}

export async function generateIdeas(userId: string, sessionId: string, input: GenerateIdeasInput) {
  const session = await getSession(userId, sessionId);
  await requireParticipant(userId, sessionId);
  if (session.status !== 'ACTIVE') throw AppError.conflict('session_not_active', 'Session is not active');
  if (configuredProviders().length === 0) {
    throw AppError.unavailable('ai_unavailable', 'No AI provider is configured for idea generation');
  }
  const user = await queryOne<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]);
  const ctx: GatewayContext = { userId, sessionId, planId: (user?.plan_id ?? 'free') as GatewayContext['planId'] };

  let completion;
  try {
    completion = await completeWithFallback({
      ctx,
      messages: [
        {
          role: 'system',
          content:
            'You are an ideation assistant. Respond with STRICT JSON only: an object ' +
            '{"ideas":[{ "title": "...", "description": "...", "tags": ["..."] }]}. ' +
            `Generate up to ${input.count} distinct, actionable ideas about the topic. ` +
            'Titles must be 1-200 characters. No markdown, no commentary outside the JSON.',
        },
        { role: 'user', content: `Topic: ${input.topic}` },
      ],
      opts: { computeClass: 'A', privacyClass: 'STANDARD' },
      maxTokens: 2000,
      temperature: 0.7,
    });
  } catch (err) {
    throw AppError.unavailable('ai_generation_failed', 'Idea generation could not be completed');
  }

  let ideas: GeneratedIdea[];
  try {
    ideas = parseGeneratedIdeas(completion.text, input.count);
  } catch {
    throw AppError.badRequest(
      'ai_generation_invalid',
      'AI output did not match the required structured schema; nothing was persisted',
    );
  }
  if (!ideas.length) {
    throw AppError.badRequest(
      'ai_generation_invalid',
      'AI output contained no valid ideas; nothing was persisted',
    );
  }

  const persisted: Array<{ brainstormIdea: ReturnType<typeof toBrainstormIdeaJson>; idea: Awaited<ReturnType<typeof createIdea>> }> = [];
  for (const idea of ideas) {
    const created = await createIdea(userId, {
      title: idea.title,
      description: idea.description ?? undefined,
      tags: idea.tags,
      provenance: `brainstorm://${sessionId}/ai`,
      aiGenerated: true,
      references: [],
    });
    const rows = await queryMany<BrainstormIdeaRow>(
      `INSERT INTO brainstorming_ideas (id, session_id, idea_id, created_by, proposal, grouping, ai_generated)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [
        newId(PREFIX.BRAINSTORM_IDEA),
        sessionId,
        created.id,
        userId,
        created.title,
        null,
      ],
    );
    persisted.push({ brainstormIdea: toBrainstormIdeaJson(rows[0] as BrainstormIdeaRow), idea: created });
  }

  await recordAudit({
    action: AuditAction.BRAINSTORM_IDEA_CAPTURED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'brainstorm',
    resourceId: sessionId,
    detail: { aiGenerated: true, count: persisted.length, topic: input.topic },
  });

  return {
    ideas: persisted.map((p) => ({ idea: p.idea, brainstormIdea: p.brainstormIdea })),
    generated: true,
  };
}

// ---------------------------------------------------------------- lifecycle

export async function completeSession(userId: string, sessionId: string) {
  const session = await getSession(userId, sessionId);
  await requireHost(userId, sessionId);
  if (session.status !== 'ACTIVE') throw AppError.conflict('session_not_active', 'Session is not active');
  await pool.query(
    "UPDATE brainstorming_sessions SET status = 'COMPLETED', ended_at = now() WHERE id = $1",
    [sessionId],
  );
  await recordAudit({
    action: AuditAction.BRAINSTORM_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'brainstorm',
    resourceId: sessionId,
  });
  const updated = await getSession(userId, sessionId);
  return toSessionJson(updated);
}

export async function archiveSession(userId: string, sessionId: string) {
  const session = await getSession(userId, sessionId);
  await requireHost(userId, sessionId);
  if (session.status === 'ARCHIVED') throw AppError.conflict('already_archived', 'Session is already archived');
  await pool.query(
    "UPDATE brainstorming_sessions SET status = 'ARCHIVED', ended_at = COALESCE(ended_at, now()) WHERE id = $1",
    [sessionId],
  );
  await recordAudit({
    action: AuditAction.BRAINSTORM_ARCHIVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'brainstorm',
    resourceId: sessionId,
  });
  const updated = await getSession(userId, sessionId);
  return toSessionJson(updated);
}