/**
 * CodeConClave — Superpowers: RETENTION PREDICTOR (#145).
 *
 * Signals when a strong person is likely to leave (burnout, stalled projects, no growth).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RetentionPredictorRow {
  id: string;
  owner_id: string;
  employee_name: string;
  signal_type: string;
  risk_score: number;
  status: string;
  intervention_plan: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): RetentionPredictorRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  employee_name: String(r.employee_name),
  signal_type: String(r.signal_type),
  risk_score: Number(r.risk_score),
  status: String(r.status),
  intervention_plan: r.intervention_plan == null ? null : String(r.intervention_plan),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createRetentionSignal(userId: string, input: { employee_name: string; signal_type: string; risk_score: number }): Promise<RetentionPredictorRow> {
  if (!input.employee_name || typeof input.employee_name !== 'string') throw AppError.badRequest('employee_name_required', 'employee name is required');
  if (!input.signal_type || typeof input.signal_type !== 'string') throw AppError.badRequest('signal_type_required', 'signal type is required');
  if (typeof input.risk_score !== 'number' || input.risk_score <= 0) throw AppError.badRequest('risk_score_required', 'risk score must be a positive number');
  const id = newId(PREFIX.RETENTION_PREDICTOR);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO retention_predictors (id, owner_id, employee_name, signal_type, risk_score, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.employee_name, input.signal_type, input.risk_score, 'DETECTED'],
  ));
  await recordAudit({
    action: AuditAction.RETENTION_SIGNAL_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'retention_predictors',
    resourceId: id,
    detail: { employee_name: input.employee_name, signal_type: input.signal_type },
  });
  return getRetentionSignal(userId, id);
}

export async function flagRetentionSignal(userId: string, id: string, input: { intervention_plan: string }): Promise<RetentionPredictorRow> {
  if (!input.intervention_plan || typeof input.intervention_plan !== 'string') throw AppError.badRequest('intervention_plan_required', 'intervention plan is required');
  const signal = await getRetentionSignal(userId, id);
  if (signal.status === 'FLAGGED') throw AppError.badRequest('already_flagged', 'retention signal already flagged');
  await withTenant(userId, (q) => q.query(
    'UPDATE retention_predictors SET intervention_plan = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.intervention_plan, 'FLAGGED', userId],
  ));
  await recordAudit({
    action: AuditAction.RETENTION_SIGNAL_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'retention_predictors',
    resourceId: id,
    detail: { intervention_plan: input.intervention_plan },
  });
  return getRetentionSignal(userId, id);
}

export async function getRetentionSignal(userId: string, id: string): Promise<RetentionPredictorRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM retention_predictors WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('retention_predictor_not_found', 'no retention predictor found for that id');
  return rowOf(row);
}

export async function listRetentionSignals(userId: string): Promise<RetentionPredictorRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM retention_predictors WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function retentionPredictorReport(userId: string): Promise<{ signals: number; detected: number; flagged: number; high_risk: number }> {
  const signals = await listRetentionSignals(userId);
  return {
    signals: signals.length,
    detected: signals.filter((s) => s.status === 'DETECTED').length,
    flagged: signals.filter((s) => s.status === 'FLAGGED').length,
    high_risk: signals.filter((s) => s.risk_score >= 7).length,
  };
}
