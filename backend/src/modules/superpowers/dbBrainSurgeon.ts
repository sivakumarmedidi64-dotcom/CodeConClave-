/**
 * CodeConClave — Superpowers: DB BRAIN SURGEON (Master Feature #102).
 *
 * Zero-downtime schema changes: expand → migrate → contract cycles,
 * dual-writes, backfill verification, and built-in rollback.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DbBrainSurgeryRow {
  id: string;
  owner_id: string;
  table_name: string;
  cycle: string;
  dual_write_active: boolean;
  backfill_verified: boolean;
  status: string;
  rollback_plan: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DbBrainSurgeryRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  table_name: String(r.table_name),
  cycle: String(r.cycle),
  dual_write_active: Boolean(r.dual_write_active),
  backfill_verified: Boolean(r.backfill_verified),
  status: String(r.status),
  rollback_plan: String(r.rollback_plan ?? ''),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const VALID_CYCLES = ['EXPAND', 'MIGRATE', 'CONTRACT'] as const;
const VALID_STATUSES = ['PLANNING', 'DUAL_WRITE', 'CONTRACTING', 'DONE', 'ROLLED_BACK'] as const;

export async function planCycle(userId: string, input: {
  table_name: string;
  cycle: string;
  rollback_plan?: string;
}): Promise<DbBrainSurgeryRow> {
  if (!input.table_name || typeof input.table_name !== 'string') throw AppError.badRequest('invalid_table', 'table name is required');
  if (!input.cycle || !VALID_CYCLES.includes(input.cycle as typeof VALID_CYCLES[number])) throw AppError.badRequest('invalid_cycle', 'cycle must be EXPAND, MIGRATE, or CONTRACT');
  const id = newId(PREFIX.DB_BRAIN_SURGEON);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO db_brain_surgeries (id, owner_id, table_name, cycle, dual_write_active, backfill_verified, status, rollback_plan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.table_name.trim(), input.cycle, false, false, 'PLANNING', input.rollback_plan ?? ''],
  ));
  await recordAudit({
    action: AuditAction.DB_SURGEON_CYCLE_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'db_brain_surgeries',
    resourceId: id,
    detail: { table_name: input.table_name, cycle: input.cycle },
  });
  return getDbBrainSurgery(userId, id);
}

export async function startDualWrite(userId: string, id: string): Promise<DbBrainSurgeryRow> {
  const surgery = await getDbBrainSurgery(userId, id);
  if (surgery.status !== 'PLANNING') throw AppError.badRequest('invalid_transition', 'dual write can only be started from PLANNING status');
  await withTenant(userId, (q) => q.query(
    'UPDATE db_brain_surgeries SET dual_write_active = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $2',
    [id, userId, true, 'DUAL_WRITE'],
  ));
  await recordAudit({
    action: AuditAction.DB_SURGEON_DUAL_WRITE_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'db_brain_surgeries',
    resourceId: id,
  });
  return getDbBrainSurgery(userId, id);
}

export async function verifyBackfill(userId: string, id: string, input: { expected_rows: number; verified_rows: number }): Promise<DbBrainSurgeryRow> {
  const surgery = await getDbBrainSurgery(userId, id);
  if (typeof input.expected_rows !== 'number' || input.expected_rows < 0) throw AppError.badRequest('invalid_expected', 'expected rows must be a non-negative number');
  if (typeof input.verified_rows !== 'number' || input.verified_rows < 0) throw AppError.badRequest('invalid_verified', 'verified rows must be a non-negative number');
  const verified = input.verified_rows >= input.expected_rows;
  await withTenant(userId, (q) => q.query(
    'UPDATE db_brain_surgeries SET backfill_verified = $3, updated_at = now() WHERE id = $1 AND owner_id = $2',
    [id, userId, verified],
  ));
  return getDbBrainSurgery(userId, id);
}

export async function contract(userId: string, id: string): Promise<DbBrainSurgeryRow> {
  const surgery = await getDbBrainSurgery(userId, id);
  if (!surgery.backfill_verified) throw AppError.badRequest('backfill_not_verified', 'backfill must be verified before contracting');
  if (surgery.status !== 'DUAL_WRITE') throw AppError.badRequest('invalid_transition', 'contract can only proceed from DUAL_WRITE status');
  await withTenant(userId, (q) => q.query(
    'UPDATE db_brain_surgeries SET status = $3, dual_write_active = $4, updated_at = now() WHERE id = $1 AND owner_id = $2',
    [id, userId, 'DONE', false],
  ));
  await recordAudit({
    action: AuditAction.DB_SURGEON_CONTRACTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'db_brain_surgeries',
    resourceId: id,
  });
  return getDbBrainSurgery(userId, id);
}

export async function getDbBrainSurgery(userId: string, id: string): Promise<DbBrainSurgeryRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM db_brain_surgeries WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('db_brain_surgeon_not_found', 'no brain surgery found for that id');
  return rowOf(row);
}

export async function listDbBrainSurgeries(userId: string): Promise<DbBrainSurgeryRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM db_brain_surgeries WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function dbBrainSurgeonReport(userId: string): Promise<{
  surgeries: number;
  dual_writes: number;
  completed: number;
  rolled_back: number;
}> {
  const list = await listDbBrainSurgeries(userId);
  return {
    surgeries: list.length,
    dual_writes: list.filter((s) => s.dual_write_active).length,
    completed: list.filter((s) => s.status === 'DONE').length,
    rolled_back: list.filter((s) => s.status === 'ROLLED_BACK').length,
  };
}
