/**
 * CodeConClave — Superpowers: RUNBOOK RUNNER (Master Feature #89).
 *
 * Every alert → automatically executing runbook; escalates to a human only
 * when confidence drops. On-call becomes reviewing what the machine already
 * did.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RunbookStep {
  text: string;
  status: string;
}

export interface RunbookRunRow {
  id: string;
  owner_id: string;
  alert: string;
  steps: RunbookStep[];
  completed: number;
  blocked: number;
  confidence: number;
  note: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): RunbookRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  alert: String(r.alert),
  steps: (r.steps ?? []) as RunbookStep[],
  completed: Number(r.completed),
  blocked: Number(r.blocked),
  confidence: Number(r.confidence),
  note: r.note == null ? null : String(r.note),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export function confidenceFor(blocked: number): number {
  return Math.max(0, Math.round((0.95 - blocked * 0.25) * 100) / 100);
}

export async function startRunbook(userId: string, input: { alert: string; steps: string[] }): Promise<RunbookRunRow> {
  if (!input.alert || typeof input.alert !== 'string') throw AppError.badRequest('invalid_alert', 'an alert condition is required');
  if (!Array.isArray(input.steps) || input.steps.length === 0 || !input.steps.every((s) => typeof s === 'string' && s.length > 0)) {
    throw AppError.badRequest('invalid_steps', 'a runbook needs at least one step');
  }
  const steps: RunbookStep[] = input.steps.map((text) => ({ text, status: 'PENDING' }));
  const id = newId(PREFIX.RUNBOOK_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO runbook_runs (id, owner_id, alert, steps, completed, blocked, confidence, note, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.alert, steps, 0, 0, confidenceFor(0), null, 'EXECUTING'],
  ));
  await recordAudit({
    action: AuditAction.RUNBOOK_EXECUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook_runs',
    resourceId: id,
    detail: { alert: input.alert, steps: steps.length },
  });
  return getRunbook(userId, id);
}

export async function executeStep(userId: string, id: string, input: { ok?: boolean }): Promise<RunbookRunRow> {
  const run = await getRunbook(userId, id);
  if (run.status !== 'EXECUTING') throw AppError.badRequest('runbook_closed', 'this runbook is closed');
  const idx = run.steps.findIndex((s) => s.status === 'PENDING');
  if (idx < 0) throw AppError.badRequest('runbook_stalled', 'the runbook has no pending steps');
  const ok = input.ok !== false;
  const steps = run.steps.map((s) => ({ ...s }));
  let completed = run.completed;
  let blocked = run.blocked;
  steps[idx]!.status = ok ? 'SUCCESS' : 'BLOCKED';
  if (ok) completed += 1;
  else blocked += 1;
  const confidence = confidenceFor(blocked);
  let status = run.status;
  let note = run.note;
  if (!ok && confidence < 0.6) {
    status = 'ESCALATED';
    note = `human attention: "${run.alert}" — confidence dropped to ${confidence}. ${completed}/${run.steps.length} steps done`;
  } else if (steps.every((s) => s.status === 'SUCCESS')) {
    status = 'RESOLVED';
  }
  await withTenant(userId, (q) => q.query(
    'UPDATE runbook_runs SET steps = $2, completed = $3, blocked = $4, confidence = $5, note = $6, status = $7, updated_at = now() WHERE id = $1 AND owner_id = $8',
    [id, steps, completed, blocked, confidence, note, status, userId],
  ));
  await recordAudit({
    action: AuditAction.RUNBOOK_STEP_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook_runs',
    resourceId: id,
    detail: { step: steps[idx]!.text, ok },
  });
  if (status === 'ESCALATED') {
    await recordAudit({
      action: AuditAction.RUNBOOK_ESCALATED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'runbook_runs',
      resourceId: id,
      detail: { confidence },
    });
  }
  if (status === 'RESOLVED') {
    await recordAudit({
      action: AuditAction.RUNBOOK_RESOLVED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'runbook_runs',
      resourceId: id,
      detail: { completed },
    });
  }
  return getRunbook(userId, id);
}

export async function resolveRunbook(userId: string, id: string): Promise<RunbookRunRow> {
  const run = await getRunbook(userId, id);
  if (run.status !== 'EXECUTING') {
    if (run.status === 'RESOLVED') throw AppError.badRequest('runbook_resolved', 'this runbook is already resolved');
    throw AppError.badRequest('runbook_escalated', 'this runbook still needs a human');
  }
  await withTenant(userId, (q) => q.query('UPDATE runbook_runs SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'RESOLVED', userId]));
  await recordAudit({
    action: AuditAction.RUNBOOK_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook_runs',
    resourceId: id,
    detail: { completed: run.completed },
  });
  return getRunbook(userId, id);
}

export async function getRunbook(userId: string, id: string): Promise<RunbookRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM runbook_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('runbook_run_not_found', 'no runbook run found for that id');
  return rowOf(row);
}

export async function listRunbooks(userId: string): Promise<RunbookRunRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM runbook_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function runbookReport(userId: string): Promise<{ runs: number; executing: number; escalated: number; resolved: number }> {
  const runs = await listRunbooks(userId);
  return {
    runs: runs.length,
    executing: runs.filter((r) => r.status === 'EXECUTING').length,
    escalated: runs.filter((r) => r.status === 'ESCALATED').length,
    resolved: runs.filter((r) => r.status === 'RESOLVED').length,
  };
}