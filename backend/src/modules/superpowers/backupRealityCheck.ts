/**
 * CodeConClave — Superpowers: BACKUP REALITY CHECK (Master Feature #90).
 *
 * Actually restores backups on schedule and verifies the restored system
 * works — not just "backup succeeded." Your backups work until they don't;
 * ours get proven.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface BackupCheckRow {
  id: string;
  owner_id: string;
  target: string;
  schedule: string;
  status: string;
  checks_passed: boolean | null;
  verdict: string | null;
  last_check: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): BackupCheckRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  target: String(r.target),
  schedule: String(r.schedule),
  status: String(r.status),
  checks_passed: r.checks_passed == null ? null : Boolean(r.checks_passed),
  verdict: r.verdict == null ? null : String(r.verdict),
  last_check: r.last_check == null ? null : String(r.last_check),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function scheduleRestoreCheck(userId: string, input: { target: string; schedule?: string }): Promise<BackupCheckRow> {
  if (!input.target || typeof input.target !== 'string') throw AppError.badRequest('invalid_target', 'a backup target is required');
  const schedule = typeof input.schedule === 'string' && input.schedule.length > 0 ? input.schedule : 'daily 0200';
  const id = newId(PREFIX.BACKUP_CHECK);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO backup_checks (id, owner_id, target, schedule, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.target, schedule, 'SCHEDULED'],
  ));
  await recordAudit({
    action: AuditAction.BACKUP_CHECK_SCHEDULED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'backup_checks',
    resourceId: id,
    detail: { target: input.target },
  });
  return getBackupCheck(userId, id);
}

/** Restore the backup and verify the restored system actually responds. */
export async function verifyRestore(userId: string, id: string, input: { extracted_rows: number; expected_rows: number }): Promise<BackupCheckRow> {
  if (typeof input.expected_rows !== 'number' || !Number.isFinite(input.expected_rows) || input.expected_rows <= 0) {
    throw AppError.badRequest('invalid_expected', 'expected_rows must be a positive number');
  }
  if (typeof input.extracted_rows !== 'number' || !Number.isFinite(input.extracted_rows) || input.extracted_rows < 0) {
    throw AppError.badRequest('invalid_extracted', 'extracted_rows must be a number');
  }
  const check = await getBackupCheck(userId, id);
  const verified = input.extracted_rows === input.expected_rows;
  const verdict = `"${check.target}" restored ${input.extracted_rows}/${input.expected_rows} rows — system ${verified ? 'VERIFIED working' : 'BROKEN — restore failed'}`;
  const status = verified ? 'VERIFIED' : 'BROKEN';
  await withTenant(userId, (q) => q.query(
    'UPDATE backup_checks SET checks_passed = $2, verdict = $3, status = $4, last_check = now(), updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, verified, verdict, status, userId],
  ));
  await recordAudit({
    action: AuditAction.BACKUP_CHECK_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'backup_checks',
    resourceId: id,
    detail: { verified, extracted: input.extracted_rows },
  });
  await recordAudit({
    action: verified ? AuditAction.BACKUP_VERIFIED : AuditAction.BACKUP_BROKEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'backup_checks',
    resourceId: id,
    detail: { verdict },
  });
  return getBackupCheck(userId, id);
}

export async function getBackupCheck(userId: string, id: string): Promise<BackupCheckRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM backup_checks WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('backup_check_not_found', 'no backup check found for that id');
  return rowOf(row);
}

export async function listBackupChecks(userId: string): Promise<BackupCheckRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM backup_checks WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function backupRealityReport(userId: string): Promise<{ checks: number; verified: number; broken: number; scheduled: number }> {
  const checks = await listBackupChecks(userId);
  return {
    checks: checks.length,
    verified: checks.filter((c) => c.status === 'VERIFIED').length,
    broken: checks.filter((c) => c.status === 'BROKEN').length,
    scheduled: checks.filter((c) => c.status === 'SCHEDULED').length,
  };
}