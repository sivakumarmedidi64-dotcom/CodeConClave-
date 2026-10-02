/**
 * CodeConClave — Superpowers: SILENCE BREAKER (Master Feature #23).
 *
 * Finds the stall before it becomes a zombie: a task "in progress" for 3+
 * days with zero movement gets diagnosed — waiting on review, ambiguous
 * requirement, hidden dependency — and then unblocked, escalated with one
 * precise question, or reassigned.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface StallSignal {
  kind: 'review' | 'requirement' | 'dependency';
  detail: string;
}

export type StallStatus = 'MONITORED' | 'UNBLOCKED' | 'ESCALATED' | 'REASSIGNED' | 'RESOLVED';

export interface StallBreakoutRow {
  id: string;
  owner_id: string;
  task: string;
  stalled_days: number;
  diagnosis: string;
  action: string;
  status: StallStatus;
  resolution: string | null;
  created_at: Date;
  updated_at: Date;
}

const STALL_THRESHOLD_DAYS = 3;
const SIGNAL_PRIORITY: StallSignal['kind'][] = ['review', 'requirement', 'dependency'];

const rowOf = (r: Record<string, unknown>): StallBreakoutRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  task: String(r.task),
  stalled_days: Number(r.stalled_days),
  diagnosis: String(r.diagnosis),
  action: String(r.action),
  status: r.status as StallStatus,
  resolution: r.resolution === null || r.resolution === undefined ? null : String(r.resolution),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** The most blocking signal decides the fix: reviewer -> nudge, requirement -> precise question, dependency -> unblock. */
export function diagnoseStallBehavior(stalledDays: number, signals: StallSignal[]): { diagnosis: string; action: string; status: StallStatus } {
  if (stalledDays < STALL_THRESHOLD_DAYS) {
    return { diagnosis: 'still moving', action: 'keep monitoring', status: 'MONITORED' };
  }
  const blocker = SIGNAL_PRIORITY.find((k) => signals.some((s) => s.kind === k));
  if (blocker === 'review') return { diagnosis: 'waiting on review', action: 'nudge the reviewer', status: 'UNBLOCKED' };
  if (blocker === 'requirement') return { diagnosis: 'ambiguous requirement', action: 'escalate one precise question', status: 'ESCALATED' };
  if (blocker === 'dependency') return { diagnosis: 'hidden dependency', action: 'unblock the dependency', status: 'UNBLOCKED' };
  return { diagnosis: 'owner not making progress', action: 'reassign ownership', status: 'REASSIGNED' };
}

export async function diagnoseStall(userId: string, input: { task: string; stalledDays: number; signals: StallSignal[] }): Promise<StallBreakoutRow> {
  if (!input.task || typeof input.task !== 'string') throw AppError.badRequest('invalid_task', 'a task name is required');
  if (typeof input.stalledDays !== 'number' || input.stalledDays < 0) throw AppError.badRequest('invalid_stalled_days', 'stalled days must be a non-negative number');
  if (!Array.isArray(input.signals)) throw AppError.badRequest('invalid_signals', 'a signal list is required');

  const behavior = diagnoseStallBehavior(input.stalledDays, input.signals);
  const id = newId(PREFIX.STALL_BREAKOUT);
  await withTenant(userId, (q) => q.query('INSERT INTO stall_breakouts (id, owner_id, task, stalled_days, diagnosis, action, status) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    id,
    userId,
    input.task,
    input.stalledDays,
    behavior.diagnosis,
    behavior.action,
    behavior.status,
  ]));
  await recordAudit({
    action: AuditAction.SILENCE_BREAK_DIAGNOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'stall_breakouts',
    resourceId: id,
    detail: { task: input.task, stalledDays: input.stalledDays, diagnosis: behavior.diagnosis, action: behavior.action },
  });
  return getStallBreakout(userId, id);
}

export async function resolveStall(userId: string, id: string, resolution: string): Promise<StallBreakoutRow> {
  const stall = await getStallBreakout(userId, id);
  if (stall.status === 'RESOLVED') throw AppError.badRequest('stall_already_resolved', 'this stall is already resolved');
  if (!resolution || typeof resolution !== 'string') throw AppError.badRequest('invalid_resolution', 'a resolution note is required');
  await withTenant(userId, (q) => q.query('UPDATE stall_breakouts SET status = $2, resolution = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, 'RESOLVED', resolution, userId]));
  await recordAudit({
    action: AuditAction.SILENCE_BREAK_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'stall_breakouts',
    resourceId: id,
    detail: { task: stall.task, resolution },
  });
  return getStallBreakout(userId, id);
}

export async function getStallBreakout(userId: string, id: string): Promise<StallBreakoutRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM stall_breakouts WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('stall_breakout_not_found', 'no stall breakout found for that id');
  return rowOf(row);
}

export async function listStallBreakouts(userId: string): Promise<StallBreakoutRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM stall_breakouts WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function silenceBreakerReport(userId: string): Promise<{ stalls: number; resolved: number; unblocked: number; escalated: number }> {
  const stalls = await listStallBreakouts(userId);
  return {
    stalls: stalls.length,
    resolved: stalls.filter((s) => s.status === 'RESOLVED').length,
    unblocked: stalls.filter((s) => s.status === 'UNBLOCKED').length,
    escalated: stalls.filter((s) => s.status === 'ESCALATED').length,
  };
}