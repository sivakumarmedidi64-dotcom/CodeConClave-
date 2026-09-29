/**
 * CodeConClave — Superpowers: MOTION DOCTOR (Master Feature #114).
 *
 * Every animation audited for performance (jank, layout thrash) and
 * accessibility (reduced motion, vestibular safety). Flags what's broken
 * and sizes the fix.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type MotionSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
export type MotionCategory = 'jank' | 'layout_thrash' | 'reduced_motion_violation' | 'vestibular_unsafe';

export interface MotionAuditRow {
  id: string;
  owner_id: string;
  component: string;
  animation_name: string;
  fps: number;
  duration_ms: number;
  issues: Array<{ category: MotionCategory; severity: MotionSeverity; detail: string }>;
  overall_severity: MotionSeverity;
  status: 'AUDITED' | 'FLAGGED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): MotionAuditRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component: String(r.component),
  animation_name: String(r.animation_name),
  fps: Number(r.fps ?? 0),
  duration_ms: Number(r.duration_ms ?? 0),
  issues: asArray(r.issues) as MotionAuditRow['issues'],
  overall_severity: (r.overall_severity ?? 'NONE') as MotionAuditRow['overall_severity'],
  status: (r.status ?? 'AUDITED') as MotionAuditRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

const SEVERITY_RANK: Record<MotionSeverity, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

function highestSeverity(issues: MotionAuditRow['issues']): MotionSeverity {
  let max: MotionSeverity = 'NONE';
  for (const issue of issues) {
    if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[max]) max = issue.severity;
  }
  return max;
}

export function auditAnimation(fps: number, durationMs: number, reducedMotionPreferred: boolean): MotionAuditRow['issues'] {
  const issues: MotionAuditRow['issues'] = [];
  if (fps < 30 && fps > 0) issues.push({ category: 'jank', severity: 'HIGH', detail: `frame rate ${fps}fps is below 30fps threshold` });
  else if (fps < 60 && fps > 0) issues.push({ category: 'jank', severity: 'LOW', detail: `frame rate ${fps}fps below ideal 60fps` });
  if (durationMs > 500) issues.push({ category: 'layout_thrash', severity: 'MEDIUM', detail: `animation duration ${durationMs}ms risks layout thrash` });
  if (durationMs > 1000) issues.push({ category: 'vestibular_unsafe', severity: 'HIGH', detail: `long animation ${durationMs}ms can trigger vestibular discomfort` });
  if (reducedMotionPreferred) issues.push({ category: 'reduced_motion_violation', severity: 'HIGH', detail: 'animation plays despite reduced motion preference' });
  return issues;
}

export async function auditMotion(userId: string, input: { component: string; animation_name: string; fps: number; duration_ms: number; reduced_motion_preferred?: boolean }): Promise<MotionAuditRow> {
  if (!input.component || typeof input.component !== 'string') throw AppError.badRequest('invalid_component', 'a component name is required');
  if (!input.animation_name || typeof input.animation_name !== 'string') throw AppError.badRequest('invalid_animation', 'an animation name is required');
  if (typeof input.fps !== 'number' || !Number.isFinite(input.fps) || input.fps < 0) throw AppError.badRequest('invalid_fps', 'fps must be a non-negative number');
  if (typeof input.duration_ms !== 'number' || !Number.isFinite(input.duration_ms) || input.duration_ms < 0) throw AppError.badRequest('invalid_duration', 'duration must be a non-negative number');
  const issues = auditAnimation(input.fps, input.duration_ms, input.reduced_motion_preferred === true);
  const overallSeverity = highestSeverity(issues);
  const status = issues.length > 0 ? 'FLAGGED' : 'AUDITED';
  const id = newId(PREFIX.MOTION_DOCTOR);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO motion_audits (id, owner_id, component, animation_name, fps, duration_ms, issues, overall_severity, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.component, input.animation_name, input.fps, input.duration_ms, JSON.stringify(issues), overallSeverity, status],
  ));
  await recordAudit({
    action: AuditAction.MOTION_AUDITED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'motion_audits',
    resourceId: id,
    detail: { component: input.component, animation: input.animation_name, issues: issues.length, overall_severity: overallSeverity },
  });
  if (issues.length > 0) {
    await recordAudit({
      action: AuditAction.MOTION_ISSUE_FLAGGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'motion_audits',
      resourceId: id,
      detail: { component: input.component, animation: input.animation_name, issues },
    });
  }
  return getMotionAudit(userId, id);
}

export function motionVerdict(a: MotionAuditRow): string {
  if (a.status === 'AUDITED') return `"${a.component}" animation "${a.animation_name}" — clean, no motion issues`;
  return `"${a.component}" animation "${a.animation_name}" — ${a.issues.length} issue(s) at ${a.overall_severity} severity`;
}

export async function getMotionAudit(userId: string, id: string): Promise<MotionAuditRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM motion_audits WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('motion_audit_not_found', 'no motion audit found for that id');
  return rowOf(row);
}

export async function listMotionAudits(userId: string): Promise<MotionAuditRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM motion_audits WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function motionDoctorReport(userId: string): Promise<{ audits: number; flagged: number; clean: number; high_severity: number }> {
  const list = await listMotionAudits(userId);
  return {
    audits: list.length,
    flagged: list.filter((a) => a.status === 'FLAGGED').length,
    clean: list.filter((a) => a.status === 'AUDITED').length,
    high_severity: list.filter((a) => a.overall_severity === 'HIGH').length,
  };
}
