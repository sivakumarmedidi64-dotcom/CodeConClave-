/**
 * CodeConClave — Superpowers: SECRET AUTOPSY (Master Feature #43).
 *
 * When a secret surfaces anywhere, its ENTIRE exposure is reconstructed: how
 * long it has been exposed, where it first appeared and what it touched — and
 * rotation is orchestrated to a documented state. A secret stays PENDING until
 * it is actually ROTATED.
 *
 * Timeline math is deterministic and owner-scoped; rotation is audit-trailed.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type DetectionSource = 'COMMIT' | 'LOG' | 'TICKET' | 'ENV' | 'SCREENSHOT';

export interface SecretInput {
  secretName: string;
  detectionSource: DetectionSource;
  firstSeen?: string;
  systemsAffected?: string[];
  exposureNotes?: string;
  projectId?: string | null;
}

export interface SecretRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  secret_name: string;
  detection_source: DetectionSource;
  first_seen: Date;
  systems_affected: string[];
  exposure_notes: string | null;
  rotation_status: 'PENDING' | 'ROTATED';
  status: 'OPEN' | 'RESOLVED';
  rotated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): SecretRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  secret_name: String(r.secret_name),
  detection_source: r.detection_source as DetectionSource,
  first_seen: new Date(r.first_seen as string),
  systems_affected: Array.isArray(r.systems_affected) ? (r.systems_affected as string[]) : [],
  exposure_notes: r.exposure_notes ? String(r.exposure_notes) : null,
  rotation_status: r.rotation_status as SecretRow['rotation_status'],
  status: r.status as SecretRow['status'],
  rotated_at: r.rotated_at ? new Date(r.rotated_at as string) : null,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findSecretById(userId: string, id: string): Promise<SecretRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM secret_incidents WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('secret_not_found', 'no secret incident found for that id');
  return rowOf(row);
}

export async function recordSecretIncident(userId: string, input: SecretInput): Promise<SecretRow> {
  const secretName = String(input.secretName ?? '').trim();
  if (!secretName) throw AppError.badRequest('invalid_secret', 'secretName is required');
  const firstSeen = input.firstSeen ? new Date(input.firstSeen) : new Date();
  if (Number.isNaN(firstSeen.getTime())) throw AppError.badRequest('invalid_date', 'firstSeen must be a valid timestamp');
  const id = newId(PREFIX.SECRET_INCIDENT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO secret_incidents (id, owner_id, project_id, secret_name, detection_source, first_seen, systems_affected, exposure_notes) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
    [id, userId, input.projectId ?? null, secretName, input.detectionSource, firstSeen.toISOString(), JSON.stringify(input.systemsAffected ?? []), input.exposureNotes ?? null],
  ));
  await recordAudit({
    action: AuditAction.SECRET_INCIDENT,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_incidents',
    resourceId: id,
    detail: { secretName, detectionSource: input.detectionSource },
  });
  return findSecretById(userId, id);
}

export function exposureDurationMs(firstSeen: Date, now: Date = new Date()): number {
  return Math.max(0, now.getTime() - firstSeen.getTime());
}

/** Full, cited exposure timeline: spans + each affected system. */
export async function buildExposureTimeline(userId: string, id: string, now: Date = new Date()) {
  const secret = await findSecretById(userId, id);
  const spans = [
    {
      from: secret.first_seen.toISOString(),
      to: secret.rotated_at ? secret.rotated_at.toISOString() : now.toISOString(),
      status: secret.rotation_status === 'ROTATED' ? 'CONTAINED' : 'STILL_EXPOSED',
    },
  ];
  return {
    secretId: id,
    secretName: secret.secret_name,
    firstSeen: secret.first_seen.toISOString(),
    durationMs: exposureDurationMs(secret.first_seen, secret.rotated_at ?? now),
    rotationStatus: secret.rotation_status,
    systemsAffected: secret.systems_affected,
    spans,
  };
}

export async function listSecretIncidents(userId: string, filter: { status?: 'OPEN' | 'RESOLVED'; rotation?: 'PENDING' | 'ROTATED' } = {}): Promise<SecretRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM secret_incidents WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.rotation) rows = rows.filter((r) => r.rotation_status === filter.rotation);
  return rows.sort((a, b) => (b.first_seen.getTime() - a.first_seen.getTime()) || b.id.localeCompare(a.id));
}

export async function rotateSecret(userId: string, id: string): Promise<SecretRow> {
  const secret = await findSecretById(userId, id);
  if (secret.rotation_status !== 'ROTATED') {
    await withTenant(userId, (q) => q.query(
      "UPDATE secret_incidents SET rotation_status = 'ROTATED', rotated_at = now(), status = 'RESOLVED', updated_at = now() WHERE id = $1 AND owner_id = $2",
      [id, userId],
    ));
  }
  await recordAudit({
    action: AuditAction.SECRET_ROTATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_incidents',
    resourceId: id,
    detail: { secretName: secret.secret_name },
  });
  return findSecretById(userId, id);
}