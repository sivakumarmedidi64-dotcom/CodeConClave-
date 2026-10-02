/**
 * CodeConClave — Superpowers: MONOLITH SURGEON (Master Feature #101).
 *
 * Extracts services from monoliths: identifies the cleanest cut line,
 * stubs seams, and migrates incrementally so the ship never stops.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface MonolithSurgeonRow {
  id: string;
  owner_id: string;
  monolith_name: string;
  cut_line: string;
  services: string[];
  services_extracted: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): MonolithSurgeonRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  monolith_name: String(r.monolith_name),
  cut_line: String(r.cut_line),
  services: (r.services ?? []) as string[],
  services_extracted: Number(r.services_extracted),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function planCut(userId: string, input: { monolith_name: string; cut_line: string; services: string[] }): Promise<MonolithSurgeonRow> {
  if (!input.monolith_name || typeof input.monolith_name !== 'string') {
    throw AppError.badRequest('invalid_monolith_name', 'a monolith name is required');
  }
  if (!input.cut_line || typeof input.cut_line !== 'string') {
    throw AppError.badRequest('invalid_cut_line', 'a cut line description is required');
  }
  if (!Array.isArray(input.services) || input.services.length === 0 || !input.services.every((s) => typeof s === 'string' && s.length > 0)) {
    throw AppError.badRequest('invalid_services', 'at least one service to extract is required');
  }
  const id = newId(PREFIX.MONOLITH_SURGEON);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO monolith_surgeries (id, owner_id, monolith_name, cut_line, services, services_extracted, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.monolith_name, input.cut_line, input.services, 0, 'PLANNED'],
  ));
  await recordAudit({
    action: AuditAction.SURGEON_CUT_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'monolith_surgeries',
    resourceId: id,
    detail: { monolith: input.monolith_name, services: input.services.length },
  });
  return getMonolithSurgeon(userId, id);
}

export async function extractService(userId: string, id: string, input: { service_name: string }): Promise<MonolithSurgeonRow> {
  if (!input.service_name || typeof input.service_name !== 'string') {
    throw AppError.badRequest('invalid_service_name', 'a service name is required');
  }
  const surgery = await getMonolithSurgeon(userId, id);
  if (surgery.status === 'DONE') throw AppError.badRequest('surgery_complete', 'all services have already been extracted');
  if (surgery.services_extracted >= surgery.services.length) {
    throw AppError.badRequest('all_extracted', 'all planned services have been extracted');
  }
  const extracted = surgery.services_extracted + 1;
  const allDone = extracted >= surgery.services.length;
  const status = allDone ? 'DONE' : 'EXTRACTING';
  await withTenant(userId, (q) => q.query(
    'UPDATE monolith_surgeries SET services_extracted = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, extracted, status, userId],
  ));
  await recordAudit({
    action: AuditAction.SURGEON_SERVICE_EXTRACTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'monolith_surgeries',
    resourceId: id,
    detail: { service: input.service_name, extracted },
  });
  return getMonolithSurgeon(userId, id);
}

export async function getMonolithSurgeon(userId: string, id: string): Promise<MonolithSurgeonRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM monolith_surgeries WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('monolith_surgeon_not_found', 'no monolith surgeon found for that id');
  return rowOf(row);
}

export async function listMonolithSurgeries(userId: string): Promise<MonolithSurgeonRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM monolith_surgeries WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function monolithSurgeonReport(userId: string): Promise<{ surgeries: number; planned: number; extracting: number; done: number }> {
  const list = await listMonolithSurgeries(userId);
  return {
    surgeries: list.length,
    planned: list.filter((s) => s.status === 'PLANNED').length,
    extracting: list.filter((s) => s.status === 'EXTRACTING').length,
    done: list.filter((s) => s.status === 'DONE').length,
  };
}
