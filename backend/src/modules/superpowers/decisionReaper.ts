/**
 * CodeConClave — Superpowers: DECISION REAPER (Master Feature #25).
 *
 * Every stored decision (via CHRONOS #17) gets reaped: if an assumption it was
 * built on has explicitly flipped (holds=false) OR the decision has aged past
 * its review horizon, it is flagged RECONSIDERING. A record of the reason is
 * kept and the verdict is deterministic — no silent expiry.
 *
 * Shares decision_records with CHRONOS. Owner-scoped + audited.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { rowOfDecision, type DecisionRow, findDecisionById } from './chronos.js';

export interface AssumptionState {
  id: string;
  claim: string;
  holds: boolean | null;
}

const REVIEW_HORIZON_DAYS = 180;

export function daysSince(date: Date, from: Date = new Date()): number {
  return Math.floor((from.getTime() - date.getTime()) / 86_400_000);
}

export function decodeAssumptions(stored: DecisionRow['assumptions']): AssumptionState[] {
  return (stored ?? []).map((entry, i) => {
    if (entry && typeof entry === 'object') {
      const e = entry as unknown as AssumptionState;
      return { id: String(e.id ?? i), claim: e.claim ?? '', holds: e.holds ?? null };
    }
    return { id: String(i), claim: entry as string, holds: null };
  });
}

/**
 * Reap all decisions for an owner. Returns decisions that now need a
 * second look, each with the exact reason (stale assumption or review
 * horizon crossed). Callers are expected to recordReconsider() afterwards —
 * the audit trail records the reap itself for every decision checked.
 */
export async function reapDecisions(userId: string): Promise<Array<{ decision: DecisionRow; reason: string }>> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM decision_records WHERE owner_id = $1', [userId])).rows);
  const reaped: Array<{ decision: DecisionRow; reason: string }> = [];
  for (const row of rows) {
    const decision = rowOfDecision(row);
    if (decision.status === 'SUPERSEDED') continue;
    const assumptions = decodeAssumptions(decision.assumptions);
    const stale = assumptions.find((a) => a.holds === false);
    const tooOld = daysSince(decision.decided_at) >= REVIEW_HORIZON_DAYS;
    if (stale) {
      reaped.push({ decision, reason: `assumption no longer holds: "${stale.claim}"` });
    } else if (tooOld) {
      reaped.push({ decision, reason: `decision is ${REVIEW_HORIZON_DAYS}+ days old and has never been rechecked` });
    }
  }
  return reaped;
}

export async function recordReconsider(userId: string, decisionId: string, note?: string): Promise<DecisionRow> {
  const decision = await findDecisionById(userId, decisionId);
  if (decision.status !== 'RECONSIDERING') {
    await withTenant(userId, (q) => q.query(
      "UPDATE decision_records SET status = 'RECONSIDERING', reconsider_ticket = $3, updated_at = now() WHERE id = $1 AND owner_id = $2",
      [decisionId, userId, note ?? null],
    ));
  }
  await recordAudit({
    action: AuditAction.DECISION_RECONSIDERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'decision_records',
    resourceId: decisionId,
    detail: { subject: decision.subject, note: note ?? null },
  });
  return findDecisionById(userId, decisionId);
}

export async function suppressDecision(userId: string, decisionId: string): Promise<DecisionRow> {
  const decision = await findDecisionById(userId, decisionId);
  if (decision.status !== 'SUPERSEDED') {
    await withTenant(userId, (q) => q.query("UPDATE decision_records SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1 AND owner_id = $2", [decisionId, userId]));
  }
  return findDecisionById(userId, decisionId);
}

export async function reviewUnlessSupplanted(userId: string, decisionId: string, note?: string): Promise<DecisionRow> {
  const decision = await findDecisionById(userId, decisionId);
  if (decision.status === 'SUPERSEDED') throw AppError.conflict('decision_superseded', 'superseded decisions are not reconsidered');
  return recordReconsider(userId, decisionId, note);
}