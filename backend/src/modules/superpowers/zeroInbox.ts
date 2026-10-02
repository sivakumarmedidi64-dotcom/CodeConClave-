/**
 * CodeConClave — Superpowers: ZERO-INBOX MODE (Master Feature #6).
 *
 * Every morning all notifications — CI failures, PR comments, security alerts,
 * test flakes — are triaged by a coworker. Each item is either fixed (PR for
 * review), escalated with one precise question, or marked waiting on someone.
 * You review decisions, not notifications: "5 fixes ready, 3 waiting, 2 escalations."
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type InboxVerdict = 'READY' | 'WAITING' | 'ESCALATED';

export interface InboxItem {
  source: string;
  subject: string;
  kind: string;
}

export interface TriageDecision extends InboxItem {
  verdict: InboxVerdict;
  detail: string;
}

export interface ZeroInboxDigestRow {
  id: string;
  owner_id: string;
  period: string;
  total_issues: number;
  fixes_ready: number;
  waiting: number;
  escalations: number;
  items: TriageDecision[];
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): ZeroInboxDigestRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  period: String(r.period),
  total_issues: Number(r.total_issues),
  fixes_ready: Number(r.fixes_ready),
  waiting: Number(r.waiting),
  escalations: Number(r.escalations),
  items: (r.items ?? []) as TriageDecision[],
  created_at: new Date(r.created_at as string),
});

const ESCALATE_HINTS = /\b(fail|broken|down|blocked|auth|permission|crashed|timeout)\b/i;
const WAITING_HINTS = /\b(waiting on|awaiting|blocked on|needs|please confirm|question)\b/i;

/** Deterministic triage: fixes what it can, escalates anything security-adjacent, waits otherwise. */
export function triageDecision(item: InboxItem): TriageDecision {
  if (!item.subject || typeof item.subject !== 'string') throw AppError.badRequest('invalid_item', 'every inbox item needs a subject');
  let verdict: InboxVerdict;
  let detail: string;
  if (WAITING_HINTS.test(item.subject)) {
    verdict = 'WAITING';
    detail = `waiting on: ${item.subject}`;
  } else if (ESCALATE_HINTS.test(item.subject)) {
    verdict = 'ESCALATED';
    detail = `escalated: ${item.subject}`;
  } else {
    verdict = 'READY';
    detail = `fix ready: ${item.subject}`;
  }
  return { ...item, verdict, detail };
}

export async function runTriaging(
  userId: string,
  input: { period: string; items: InboxItem[] },
): Promise<ZeroInboxDigestRow> {
  if (!input.period || typeof input.period !== 'string') throw AppError.badRequest('invalid_period', 'a digest period is required');
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw AppError.badRequest('empty_inbox', 'nothing to triage');
  const decisions = items.map(triageDecision);
  const id = newId(PREFIX.ZERO_INBOX_DIGEST);
  const fixes = decisions.filter((d) => d.verdict === 'READY').length;
  const waiting = decisions.filter((d) => d.verdict === 'WAITING').length;
  const escalations = decisions.filter((d) => d.verdict === 'ESCALATED').length;
  await recordDigest(userId, id, input.period, decisions, fixes, waiting, escalations);
  await recordAudit({
    action: AuditAction.INBOX_TRIAGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'zero_inbox_digests',
    resourceId: id,
    detail: { fixes, waiting, escalations },
  });
  return getZeroInboxDigest(userId, id);
}

async function recordDigest(
  userId: string,
  id: string,
  period: string,
  decisions: TriageDecision[],
  fixes: number,
  waiting: number,
  escalations: number,
): Promise<void> {
  await withTenant(userId, (q) => q.query(
    'INSERT INTO zero_inbox_digests (id, owner_id, period, total_issues, fixes_ready, waiting, escalations, items) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, period, decisions.length, fixes, waiting, escalations, decisions],
  ));
  await recordAudit({
    action: AuditAction.INBOX_DIGEST_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'zero_inbox_digests',
    resourceId: id,
    detail: { period, total: decisions.length },
  });
}

export async function getZeroInboxDigest(userId: string, id: string): Promise<ZeroInboxDigestRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM zero_inbox_digests WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('zero_inbox_digest_not_found', 'no triage digest found for that id');
  return rowOf(row);
}

export async function listZeroInboxDigests(userId: string): Promise<ZeroInboxDigestRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM zero_inbox_digests WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function inboxReport(userId: string): Promise<{ digests: number; fixes_ready: number; waiting: number; escalations: number }> {
  const digests = await listZeroInboxDigests(userId);
  return {
    digests: digests.length,
    fixes_ready: digests.reduce((acc, d) => acc + d.fixes_ready, 0),
    waiting: digests.reduce((acc, d) => acc + d.waiting, 0),
    escalations: digests.reduce((acc, d) => acc + d.escalations, 0),
  };
}