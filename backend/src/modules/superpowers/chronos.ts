/**
 * CodeConClave — Superpowers: CHRONOS (Master Feature #17).
 *
 * "Why does this codebase work this way?" — answer from the actual recorded
 * reasoning, not from guessing at a git blame. Every decision gets stored with
 * its underlying assumptions and author at the moment of the decision, then
 * every search is answered from that record. Compliments DECISION REAPER (#25)
 * which shares the same decision_records storage: CHRONOS reads the past,
 * REAPER challenges it.
 *
 * Deterministic, owner-scoped, audited, removable.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DecisionInput {
  area: string;
  subject: string;
  decision: string;
  reasoning: string;
  author: string;
  assumptions?: string[];
  projectId?: string | null;
}

export interface DecisionRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  area: string;
  subject: string;
  decision: string;
  reasoning: string;
  author: string;
  assumptions: string[];
  status: 'ACTIVE' | 'RECONSIDERING' | 'SUPERSEDED';
  reconsider_ticket: string | null;
  decided_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const rowOfDecision = (r: Record<string, unknown>): DecisionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  area: String(r.area),
  subject: String(r.subject),
  decision: String(r.decision),
  reasoning: String(r.reasoning),
  author: String(r.author),
  assumptions: Array.isArray(r.assumptions) ? (r.assumptions as string[]) : [],
  status: r.status as DecisionRow['status'],
  reconsider_ticket: r.reconsider_ticket ? String(r.reconsider_ticket) : null,
  decided_at: new Date(r.decided_at as string),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findDecisionById(userId: string, id: string): Promise<DecisionRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    q
      .query<Record<string, unknown>>('SELECT * FROM decision_records WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('decision_not_found', 'no decision record found for that id');
  return rowOfDecision(row);
}

export async function recordDecision(userId: string, input: DecisionInput): Promise<DecisionRow> {
  const area = String(input.area ?? '').trim();
  const subject = String(input.subject ?? '').trim();
  const decision = String(input.decision ?? '').trim();
  const reasoning = String(input.reasoning ?? '').trim();
  const author = String(input.author ?? '').trim();
  if (!area || !subject || !decision || !reasoning || !author) {
    throw AppError.badRequest('invalid_decision', 'area, subject, decision, reasoning and author are all required');
  }
  const id = newId(PREFIX.DECISION_RECORD);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO decision_records (id, owner_id, project_id, area, subject, decision, reasoning, author, assumptions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, userId, input.projectId ?? null, area, subject, decision, reasoning, author, JSON.stringify(input.assumptions ?? [])],
    ),
  );
  await recordAudit({
    action: AuditAction.DECISION_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'decision_records',
    resourceId: id,
    detail: { area, subject },
  });
  return findDecisionById(userId, id);
}

/** CHRONOS: "why?" — exact-record lookup + search across area/subject/decision. */
export async function getDecisionHistory(userId: string, area?: string, status?: DecisionRow['status']): Promise<DecisionRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM decision_records WHERE owner_id = $1', [userId])).rows,
  );
  let out = rows.map(rowOfDecision).sort((a, b) => (b.decided_at.getTime() - a.decided_at.getTime()) || b.id.localeCompare(a.id));
  if (area) out = out.filter((d) => d.area.toLowerCase().includes(area.toLowerCase()));
  if (status) out = out.filter((d) => d.status === status);
  return out;
}

export async function searchDecisions(userId: string, term: string): Promise<DecisionRow[]> {
  const q = String(term ?? '').trim().toLowerCase();
  if (!q) throw AppError.badRequest('invalid_term', 'a search term is required');
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM decision_records WHERE owner_id = $1', [userId])).rows,
  );
  return rows
    .map(rowOfDecision)
    .filter((d) =>
      [d.subject, d.decision, d.reasoning, d.area, ...d.assumptions].some((field) => field.toLowerCase().includes(q)),
    )
    .sort((a, b) => (b.decided_at.getTime() - a.decided_at.getTime()) || b.id.localeCompare(a.id));
}