/**
 * CodeConClave — Superpowers: NEGOTIATOR (Master Feature #51).
 *
 * When a requirement is impossible or contradictory, the system does not
 * silently pick a side. It drafts the exact question for the human — here are
 * the viable interpretations, with tradeoffs — and only resolves when the
 * human picks one.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface Interpretation {
  label: string;
  tradeoff: string;
}

export interface NegotiationDraftRow {
  id: string;
  owner_id: string;
  requirement: string;
  conflict: string;
  interpretations: Interpretation[];
  recommended: string | null;
  status: 'PENDING' | 'RESOLVED';
  resolution: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): NegotiationDraftRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  requirement: String(r.requirement),
  conflict: String(r.conflict),
  interpretations: (r.interpretations ?? []) as Interpretation[],
  recommended: r.recommended === null || r.recommended === undefined ? null : String(r.recommended),
  status: r.status as NegotiationDraftRow['status'],
  resolution: r.resolution === null || r.resolution === undefined ? null : String(r.resolution),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** The exact question a senior engineer would ask, with numbered options. */
export function draftQuestion(input: { requirement: string; conflict: string; interpretations: Interpretation[] }): string {
  const options = input.interpretations.map((i, idx) => `${idx + 1}) ${i.label} — ${i.tradeoff}`).join('; ');
  return `${input.conflict ? `${input.conflict} ` : ''}You asked for "${input.requirement}". Pick one: ${options}.`;
}

export async function draftNegotiation(
  userId: string,
  input: { requirement: string; conflict?: string; interpretations: Interpretation[]; recommended?: string },
): Promise<NegotiationDraftRow> {
  if (!input.requirement || typeof input.requirement !== 'string') throw AppError.badRequest('invalid_requirement', 'a requirement is required');
  if (!Array.isArray(input.interpretations) || input.interpretations.length < 2) throw AppError.badRequest('too_few_interpretations', 'at least 2 viable interpretations are required');
  for (const i of input.interpretations) {
    if (!i.label || !i.tradeoff) throw AppError.badRequest('incomplete_interpretation', 'each interpretation needs a label and a tradeoff');
  }

  const question = draftQuestion({ requirement: input.requirement, conflict: input.conflict ?? '', interpretations: input.interpretations });
  const id = newId(PREFIX.NEGOTIATION_DRAFT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO negotiation_drafts (id, owner_id, requirement, conflict, interpretations, recommended, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.requirement, input.conflict ?? '', input.interpretations, input.recommended ?? null, 'PENDING'],
  ));
  await recordAudit({
    action: AuditAction.NEGOTIATION_DRAFTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'negotiation_drafts',
    resourceId: id,
    detail: { requirement: input.requirement, question },
  });
  return getNegotiationDraft(userId, id);
}

export async function resolveNegotiation(userId: string, id: string, choice: string): Promise<NegotiationDraftRow> {
  const draft = await getNegotiationDraft(userId, id);
  if (draft.status === 'RESOLVED') throw AppError.badRequest('negotiation_already_resolved', 'this negotiation is already resolved');
  if (!choice || !draft.interpretations.some((i) => i.label === choice)) throw AppError.badRequest('unknown_choice', `choice must be one of ${draft.interpretations.map((i) => i.label).join(', ')}`);
  await withTenant(userId, (q) => q.query('UPDATE negotiation_drafts SET status = $2, resolution = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, 'RESOLVED', choice, userId]));
  await recordAudit({
    action: AuditAction.NEGOTIATION_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'negotiation_drafts',
    resourceId: id,
    detail: { requirement: draft.requirement, choice },
  });
  return getNegotiationDraft(userId, id);
}

export async function getNegotiationDraft(userId: string, id: string): Promise<NegotiationDraftRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM negotiation_drafts WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('negotiation_draft_not_found', 'no negotiation draft found for that id');
  return rowOf(row);
}

export async function listNegotiationDrafts(userId: string): Promise<NegotiationDraftRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM negotiation_drafts WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function negotiatorReport(userId: string): Promise<{ drafts: number; resolved: number; pending: number }> {
  const drafts = await listNegotiationDrafts(userId);
  return {
    drafts: drafts.length,
    resolved: drafts.filter((d) => d.status === 'RESOLVED').length,
    pending: drafts.filter((d) => d.status === 'PENDING').length,
  };
}