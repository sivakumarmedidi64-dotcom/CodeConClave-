/**
 * CodeConClave — Superpowers: AUTO-FIX INBOX (Master Feature #69).
 *
 * Every notification (CI failure, Sentry error, broken preview, failed deploy)
 * gets an "Auto-Fix" button. Clicking it creates a fix_ticket in OPEN state.
 * A coworker run then moves it through the reproduce -> fix -> PR pipeline:
 *
 *   OPEN             ticket created (from a notification or manually)
 *   IN_REPRODUCTION  coworker reproduced the failure in a sandbox
 *   FIX_PROPOSED     fix drafted + a PROOF OF RUN claim registered
 *   PR_OPENED        PR with proof sent out for review
 *   RESOLVED         merged/accepted
 *   SUPERSEDED       a newer ticket obsoleted this one
 *
 * The pipeline is orthogonal to the async runtime: every transition is a
 * plain, audited, owner-scoped row so any worker can drive it.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export const FixSource = {
  CI_FAILURE: 'ci_failure',
  SENTRY_ERROR: 'sentry_error',
  PREVIEW_BROKEN: 'preview_broken',
  DEPLOY_FAILED: 'deploy_failed',
  MANUAL: 'manual',
} as const;
export type FixSource = (typeof FixSource)[keyof typeof FixSource];
const SOURCES = new Set<string>(Object.values(FixSource));

export const FixStatus = {
  OPEN: 'OPEN',
  IN_REPRODUCTION: 'IN_REPRODUCTION',
  FIX_PROPOSED: 'FIX_PROPOSED',
  PR_OPENED: 'PR_OPENED',
  RESOLVED: 'RESOLVED',
  SUPERSEDED: 'SUPERSEDED',
} as const;
export type FixStatus = (typeof FixStatus)[keyof typeof FixStatus];
const STATUSES = new Set<string>(Object.values(FixStatus));

const FLOW: Record<FixStatus, FixStatus[]> = {
  OPEN: ['IN_REPRODUCTION', 'SUPERSEDED'],
  IN_REPRODUCTION: ['FIX_PROPOSED', 'PR_OPENED', 'SUPERSEDED'],
  FIX_PROPOSED: ['PR_OPENED', 'SUPERSEDED'],
  PR_OPENED: ['RESOLVED', 'SUPERSEDED'],
  RESOLVED: [],
  SUPERSEDED: [],
};

export interface FixTicketInput {
  source: FixSource;
  issue: string;
  ref?: string | null;
  title?: string | null;
  errorSnippet?: string | null;
  projectId?: string | null;
}

export interface FixTicketRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  source: FixSource;
  issue: string;
  ref: string | null;
  status: FixStatus;
  title: string | null;
  error_snippet: string | null;
  pr_url: string | null;
  proof_claim_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowOf(r: Record<string, unknown>): FixTicketRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    source: String(r.source) as FixSource,
    issue: String(r.issue),
    ref: r.ref === null ? null : String(r.ref),
    status: String(r.status) as FixStatus,
    title: r.title === null ? null : String(r.title),
    error_snippet: r.error_snippet === null ? null : String(r.error_snippet),
    pr_url: r.pr_url === null ? null : String(r.pr_url),
    proof_claim_id: r.proof_claim_id === null ? null : String(r.proof_claim_id),
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

export async function createFixTicket(userId: string, input: FixTicketInput): Promise<FixTicketRow> {
  const issue = (input.issue ?? '').trim();
  if (!issue) throw AppError.badRequest('issue_required', 'A description of the failure is required');
  if (!SOURCES.has(input.source)) throw AppError.badRequest('invalid_source', `Unknown fix source: ${input.source}`);
  const id = newId(PREFIX.FIX_TICKET);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO fix_tickets (id, owner_id, project_id, source, issue, ref, status, title, error_snippet)
     VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8)`,
    [
      id, userId, input.projectId ?? null, input.source, issue, input.ref || null,
      input.title?.trim()?.slice(0, 300) || null, input.errorSnippet?.slice(0, 8000) || null,
    ],
  ));
  await recordAudit({
    action: AuditAction.FIX_TICKET_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'fix_tickets',
    resourceId: id,
    detail: { source: input.source, ref: input.ref ?? null },
  });
  return getFixTicket(userId, id);
}

export async function getFixTicket(userId: string, ticketId: string): Promise<FixTicketRow> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>(
    'SELECT * FROM fix_tickets WHERE id = $1 AND owner_id = $2',
    [ticketId, userId],
  )).rows);
  if (!rows[0]) throw AppError.notFound('Fix ticket');
  return rowOf(rows[0]);
}

export async function listFixTickets(userId: string, opts: { status?: FixStatus; source?: FixSource } = {}): Promise<FixTicketRow[]> {
  const where: string[] = ['owner_id = $1'];
  const params: unknown[] = [userId];
  if (opts.status) {
    where.push(`status = $${params.length + 1}`);
    params.push(opts.status);
  }
  if (opts.source) {
    where.push(`source = $${params.length + 1}`);
    params.push(opts.source);
  }
  return (await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        `SELECT * FROM fix_tickets WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params,
      )
    ).rows,
  )).map(rowOf);
}

function assertTransition(from: FixStatus, to: FixStatus): void {
  if (!FLOW[from].includes(to)) {
    throw AppError.conflict('invalid_ticket_transition', `Cannot move fix ticket from ${from} to ${to}`);
  }
}

async function transition(userId: string, ticketId: string, to: FixStatus, patch: Record<string, unknown>): Promise<FixTicketRow> {
  const ticket = await getFixTicket(userId, ticketId);
  assertTransition(ticket.status, to);
  const entries = Object.entries(patch);
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
  const values = entries.map(([, v]) => v);
  const idParam = entries.length + 2;
  const ownerParam = idParam + 1;
  await withTenant(userId, (q) => q.query(
    `UPDATE fix_tickets SET status = $1, updated_at = now(), ${sets.join(', ')} WHERE id = $${idParam} AND owner_id = $${ownerParam}`,
    [to, ...values, ticketId, userId],
  ));
  await recordAudit({
    action: auditForTransition(to),
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'fix_tickets',
    resourceId: ticketId,
    detail: { from: ticket.status, to, idempotency: 'transition' },
  });
  return getFixTicket(userId, ticketId);
}

function auditForTransition(to: FixStatus): string {
  switch (to) {
    case FixStatus.IN_REPRODUCTION:
      return AuditAction.FIX_TICKET_STARTED;
    case FixStatus.FIX_PROPOSED:
      return AuditAction.FIX_TICKET_PROPOSED;
    case FixStatus.PR_OPENED:
      return AuditAction.FIX_TICKET_PROPOSED;
    case FixStatus.RESOLVED:
      return AuditAction.FIX_TICKET_RESOLVED;
    default:
      return AuditAction.FIX_TICKET_CREATED;
  }
}

/** Auto-Fix clicked -> coworker starts reproducing the failure in a sandbox. */
export async function startReproduction(userId: string, ticketId: string): Promise<FixTicketRow> {
  return transition(userId, ticketId, FixStatus.IN_REPRODUCTION, {});
}

/** Coworker finished a fix with proof: attach the proof claim and the PR url.
 *  A draft fix without a PR stays FIX_PROPOSED; once the PR exists the ticket
 *  moves to PR_OPENED (the review beat). */
export async function proposeFix(
  userId: string,
  ticketId: string,
  input: { proofClaimId?: string | null; prUrl?: string | null; title?: string | null },
): Promise<FixTicketRow> {
  const target = input.prUrl?.trim() ? FixStatus.PR_OPENED : FixStatus.FIX_PROPOSED;
  return transition(userId, ticketId, target, {
    proof_claim_id: input.proofClaimId ?? null,
    pr_url: input.prUrl ?? null,
    title: input.title?.trim()?.slice(0, 300) || null,
  });
}

/** Fix accepted and merged. */
export async function resolveFix(userId: string, ticketId: string, prUrl?: string | null): Promise<FixTicketRow> {
  return transition(userId, ticketId, FixStatus.RESOLVED, { pr_url: prUrl ?? null });
}

/** A newer ticket obsoleted this one. */
export async function supersedeFix(userId: string, ticketId: string): Promise<FixTicketRow> {
  return transition(userId, ticketId, FixStatus.SUPERSEDED, {});
}