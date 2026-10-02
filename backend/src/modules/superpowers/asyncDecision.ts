/**
 * CodeConClave — Superpowers: ASYNC DECISION PLATFORM (Master Feature #142).
 *
 * Major decisions made async with structured voting, evidence, and recorded
 * dissent. Decision records persist and are searchable — politics become
 * evidence, not vibes.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type DecisionStatus = 'OPEN' | 'DECIDED' | 'CLOSED';

export interface DecisionOption {
  key: string;
  label: string;
  impact: string;
}

export interface DecisionVote {
  voter: string;
  option: string;
  weight: number;
  rationale?: string;
}

export interface DecisionDissent {
  voter: string;
  concern: string;
}

export interface AsyncDecisionRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  description: string;
  options: DecisionOption[];
  evidence: string[];
  voters: string[];
  votes: DecisionVote[];
  dissents: DecisionDissent[];
  status: DecisionStatus;
  resolved_option: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): AsyncDecisionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  title: String(r.title),
  description: String(r.description),
  options: (r.options ?? []) as DecisionOption[],
  evidence: (r.evidence ?? []) as string[],
  voters: (r.voters ?? []) as string[],
  votes: (r.votes ?? []) as DecisionVote[],
  dissents: (r.dissents ?? []) as DecisionDissent[],
  status: (r.status ?? 'OPEN') as DecisionStatus,
  resolved_option: r.resolved_option ? String(r.resolved_option) : null,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export function resolveDecisions(
  voters: string[],
  votes: DecisionVote[],
  dissents: DecisionDissent[],
): { resolved: boolean; winner: string | null; pending: string[]; tally: Record<string, number> } {
  const tally: Record<string, number> = {};
  for (const v of votes) tally[v.option] = (tally[v.option] ?? 0) + v.weight;
  const voted = new Set(votes.map((v) => v.voter));
  const pending = voters.filter((v) => !voted.has(v)).sort();
  if (pending.length > 0) return { resolved: false, winner: null, pending, tally };
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { resolved: false, winner: null, pending: [], tally };
  if (entries.length === 1) return { resolved: true, winner: entries[0]![0], pending: [], tally };
  const topWeight = entries[0]![1]!;
  const tied = entries.filter((e) => e[1] === topWeight);
  if (tied.length === 1) return { resolved: true, winner: tied[0]![0], pending: [], tally };
  const dissentCounts = new Map<string, number>();
  for (const d of dissents) {
    const opt = votes.find((v) => v.voter === d.voter)?.option;
    if (opt) dissentCounts.set(opt, (dissentCounts.get(opt) ?? 0) + 1);
  }
  const sorted = [...tied].sort((a, b) => (dissentCounts.get(a[0]) ?? 0) - (dissentCounts.get(b[0]) ?? 0));
  if (sorted.length === 1 || (dissentCounts.get(sorted[0]![0]) ?? 0) < (dissentCounts.get(sorted[1]![0]) ?? 0)) {
    return { resolved: true, winner: sorted[0]![0], pending: [], tally };
  }
  return { resolved: true, winner: sorted.sort((a, b) => a[0].localeCompare(b[0]))[0]![0], pending: [], tally };
}

export async function proposeDecision(
  userId: string,
  input: {
    projectId?: string | null;
    title: string;
    description: string;
    options: DecisionOption[];
    evidence?: string[];
    voters?: string[];
  },
): Promise<AsyncDecisionRow> {
  if (!input.title || typeof input.title !== 'string') throw AppError.badRequest('invalid_title', 'a title is required');
  if (!input.description || typeof input.description !== 'string') throw AppError.badRequest('invalid_description', 'a description is required');
  const options = Array.isArray(input.options) ? input.options : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const voters = Array.isArray(input.voters) ? input.voters : [];
  if (options.length < 2) throw AppError.badRequest('too_few_options', 'a decision needs at least two options');
  const keys = new Set<string>();
  for (const o of options) {
    if (!o.key || keys.has(o.key)) throw AppError.badRequest('duplicate_option_key', `option key "${o.key}" is invalid or duplicated`);
    keys.add(o.key);
  }
  const id = newId(PREFIX.ASYNC_DECISION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO async_decisions (id, owner_id, project_id, title, description, options, evidence, voters, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.projectId ?? null, input.title, input.description, options, evidence, voters, 'OPEN'],
  ));
  await recordAudit({
    action: AuditAction.DECISION_PROPOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'async_decisions',
    resourceId: id,
    detail: { title: input.title, optionCount: options.length, voterCount: voters.length },
  });
  return getAsyncDecision(userId, id);
}

export async function getAsyncDecision(userId: string, id: string): Promise<AsyncDecisionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM async_decisions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('async_decision_not_found', 'no async decision found for that id');
  return rowOf(row);
}

export async function castDecisionVote(
  userId: string,
  id: string,
  input: { voter: string; option: string; weight: number; rationale?: string; dissent?: string },
): Promise<{ decision: AsyncDecisionRow; resolved: boolean }> {
  const decision = await getAsyncDecision(userId, id);
  if (decision.status !== 'OPEN') throw AppError.badRequest('decision_not_open', `decision is ${decision.status}; voting is closed`);
  if (!input.voter || typeof input.voter !== 'string') throw AppError.badRequest('invalid_voter', 'a voter name is required');
  if (decision.voters.length > 0 && !decision.voters.includes(input.voter)) {
    throw AppError.badRequest('unregistered_voter', `voter "${input.voter}" was not registered for this decision`);
  }
  if (!input.option || typeof input.option !== 'string') throw AppError.badRequest('invalid_option', 'an option key is required');
  const validKeys = new Set(decision.options.map((o) => o.key));
  if (!validKeys.has(input.option)) throw AppError.badRequest('invalid_option', `option "${input.option}" is not in this decision`);
  if (!Number.isFinite(input.weight) || input.weight <= 0) throw AppError.badRequest('invalid_weight', 'vote weight must be positive');
  const alreadyVoted = decision.votes.find((v) => v.voter === input.voter);
  if (alreadyVoted) throw AppError.badRequest('already_voted', `voter "${input.voter}" has already voted`);
  const newVote: DecisionVote = { voter: input.voter, option: input.option, weight: input.weight };
  if (input.rationale) newVote.rationale = input.rationale;
  const newVotes = [...decision.votes, newVote];
  const newDissents = [...decision.dissents];
  if (input.dissent) {
    newDissents.push({ voter: input.voter, concern: input.dissent });
    await recordAudit({
      action: AuditAction.DECISION_DISSENT_LOGGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'async_decisions',
      resourceId: id,
      detail: { voter: input.voter },
    });
  }
  await withTenant(userId, (q) => q.query('UPDATE async_decisions SET votes = $3, dissents = $4, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, newVotes, newDissents]));
  await recordAudit({
    action: AuditAction.DECISION_VOTE_CAST,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'async_decisions',
    resourceId: id,
    detail: { voter: input.voter, option: input.option },
  });
  const updated = await getAsyncDecision(userId, id);
  const result = resolveDecisions(updated.voters, updated.votes, updated.dissents);
  return { decision: updated, resolved: result.resolved };
}

export async function resolveDecision(userId: string, id: string): Promise<{ decision: AsyncDecisionRow; winner: string | null; tally: Record<string, number> }> {
  const decision = await getAsyncDecision(userId, id);
  if (decision.status !== 'OPEN') throw AppError.badRequest('decision_not_open', `decision is ${decision.status}; cannot resolve`);
  const result = resolveDecisions(decision.voters, decision.votes, decision.dissents);
  if (!result.resolved) throw AppError.badRequest('not_all_votes_yet', `pending voters: ${result.pending.join(', ')}`);
  await withTenant(userId, (q) => q.query('UPDATE async_decisions SET status = $3, resolved_option = $4, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'DECIDED', result.winner]));
  await recordAudit({
    action: AuditAction.DECISION_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'async_decisions',
    resourceId: id,
    detail: { title: decision.title, winner: result.winner, tally: result.tally },
  });
  return { decision: await getAsyncDecision(userId, id), winner: result.winner, tally: result.tally };
}

export async function closeDecision(userId: string, id: string): Promise<AsyncDecisionRow> {
  const decision = await getAsyncDecision(userId, id);
  if (decision.status === 'CLOSED') return decision;
  await withTenant(userId, (q) => q.query('UPDATE async_decisions SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'CLOSED']));
  await recordAudit({
    action: AuditAction.DECISION_CLOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'async_decisions',
    resourceId: id,
    detail: { title: decision.title },
  });
  return getAsyncDecision(userId, id);
}

export async function listAsyncDecisions(userId: string, filter: { status?: DecisionStatus } = {}): Promise<AsyncDecisionRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM async_decisions WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.sort((a, b) => a.status.localeCompare(b.status) || b.created_at.getTime() - a.created_at.getTime());
}

export async function asyncDecisionReport(userId: string): Promise<{
  total: number;
  by_status: Record<DecisionStatus, number>;
}> {
  const rows = await listAsyncDecisions(userId);
  const by_status: Record<DecisionStatus, number> = { OPEN: 0, DECIDED: 0, CLOSED: 0 };
  for (const r of rows) by_status[r.status] += 1;
  return { total: rows.length, by_status };
}