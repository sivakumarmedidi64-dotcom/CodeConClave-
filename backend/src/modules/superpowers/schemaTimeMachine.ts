/**
 * CodeConClave — Superpowers: SCHEMA TIME MACHINE (Feature #125).
 *
 * Point-in-time schema + data reconstruction.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface SchemaTimeMachineSnapshotRow {
  id: string;
  owner_id: string;
  schema_name: string;
  schema_definition: string;
  snapshot_label: string;
  restored_from: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SchemaTimeMachineSnapshotRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  schema_name: String(r.schema_name),
  schema_definition: String(r.schema_definition),
  snapshot_label: String(r.snapshot_label),
  restored_from: String(r.restored_from),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createSchemaSnapshot(
  userId: string,
  input: { schema_name: string; schema_definition: string; snapshot_label: string },
): Promise<SchemaTimeMachineSnapshotRow> {
  if (!input.schema_name || typeof input.schema_name !== 'string') throw AppError.badRequest('invalid_schema_name', 'schema name is required');
  if (!input.schema_definition || typeof input.schema_definition !== 'string') throw AppError.badRequest('invalid_schema_definition', 'schema definition is required');
  const id = newId(PREFIX.SCHEMA_TIME_MACHINE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO schema_time_machine_snapshots (id, owner_id, schema_name, schema_definition, snapshot_label, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.schema_name, input.schema_definition, input.snapshot_label ?? '', 'CAPTURED'],
  ));
  await recordAudit({
    action: AuditAction.SCHEMA_SNAPSHOT_CAPTURED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schema_time_machine_snapshots',
    resourceId: id,
    detail: { schema_name: input.schema_name },
  });
  return getSchemaTimeMachine(userId, id);
}

export async function captureSchemaSnapshot(userId: string, id: string, input: { schema_definition: string }): Promise<SchemaTimeMachineSnapshotRow> {
  await getSchemaTimeMachine(userId, id);
  if (!input.schema_definition || typeof input.schema_definition !== 'string') throw AppError.badRequest('invalid_schema_definition', 'schema definition is required');
  await withTenant(userId, (q) => q.query(
    'UPDATE schema_time_machine_snapshots SET schema_definition = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, input.schema_definition, userId],
  ));
  await recordAudit({
    action: AuditAction.SCHEMA_SNAPSHOT_CAPTURED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schema_time_machine_snapshots',
    resourceId: id,
    detail: { schema_definition: input.schema_definition },
  });
  return getSchemaTimeMachine(userId, id);
}

export async function restoreSchemaPoint(userId: string, id: string, input: { restored_from: string }): Promise<SchemaTimeMachineSnapshotRow> {
  await getSchemaTimeMachine(userId, id);
  if (!input.restored_from || typeof input.restored_from !== 'string') throw AppError.badRequest('invalid_restored_from', 'restored_from timestamp is required');
  await withTenant(userId, (q) => q.query(
    'UPDATE schema_time_machine_snapshots SET restored_from = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.restored_from, 'RESTORED', userId],
  ));
  await recordAudit({
    action: AuditAction.SCHEMA_POINT_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'schema_time_machine_snapshots',
    resourceId: id,
    detail: { restored_from: input.restored_from },
  });
  return getSchemaTimeMachine(userId, id);
}

export async function getSchemaTimeMachine(userId: string, id: string): Promise<SchemaTimeMachineSnapshotRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM schema_time_machine_snapshots WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('schema_time_machine_snapshot_not_found', 'no schema time machine snapshot found for that id');
  return rowOf(row);
}

export async function listSchemaTimeMachineSnapshots(userId: string): Promise<SchemaTimeMachineSnapshotRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM schema_time_machine_snapshots WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function schemaTimeMachineReport(userId: string): Promise<{ snapshots: number; captured: number; restored: number }> {
  const snapshots = await listSchemaTimeMachineSnapshots(userId);
  return {
    snapshots: snapshots.length,
    captured: snapshots.filter((s) => s.status === 'CAPTURED').length,
    restored: snapshots.filter((s) => s.status === 'RESTORED').length,
  };
}
