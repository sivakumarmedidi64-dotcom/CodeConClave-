/**
 * CodeConClave — Superpowers: WHY-WIKI (Master Feature #28).
 *
 * Every non-obvious line of code gets a linked, auto-maintained "why" entry
 * sourced from discussions, commits and decision records. A why_links row
 * pins (file_path, line) to a human reason + the source it was drawn from.
 * Detaching keeps the history but stops the link from resolving.
 *
 * Deterministic, owner-scoped, audited.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface WhyLinkInput {
  filePath: string;
  line?: number | null;
  reason: string;
  sourceType: string;
  sourceRef?: string | null;
  projectId?: string | null;
}

export interface WhyLinkRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  file_path: string;
  line: number | null;
  reason: string;
  source_type: string;
  source_ref: string | null;
  status: 'ACTIVE' | 'DETACHED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): WhyLinkRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  file_path: String(r.file_path),
  line: r.line != null && r.line !== '' ? Number(r.line) : null,
  reason: String(r.reason),
  source_type: String(r.source_type),
  source_ref: r.source_ref ? String(r.source_ref) : null,
  status: r.status as WhyLinkRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findWhyLinkById(userId: string, id: string): Promise<WhyLinkRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM why_links WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('why_link_not_found', 'no why-link found for that id');
  return rowOf(row);
}

export async function createWhyLink(userId: string, input: WhyLinkInput): Promise<WhyLinkRow> {
  const filePath = String(input.filePath ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  const sourceType = String(input.sourceType ?? '').trim();
  if (!filePath || !reason || !sourceType) throw AppError.badRequest('invalid_why_link', 'filePath, reason and sourceType are required');
  const line = input.line == null ? null : Number(input.line);
  const id = newId(PREFIX.WHY_LINK);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO why_links (id, owner_id, project_id, file_path, line, reason, source_type, source_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.projectId ?? null, filePath, line, reason, sourceType, input.sourceRef ?? null],
  ));
  await recordAudit({
    action: AuditAction.WHY_LINK_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'why_links',
    resourceId: id,
    detail: { filePath, line },
  });
  return findWhyLinkById(userId, id);
}

export async function listWhyLinks(userId: string, filePath?: string): Promise<WhyLinkRow[]> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM why_links WHERE owner_id = $1', [userId])).rows);
  let out = rows.map(rowOf).sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
  if (filePath) out = out.filter((w) => w.file_path === filePath);
  return out;
}

export async function detachWhyLink(userId: string, id: string): Promise<WhyLinkRow> {
  const link = await findWhyLinkById(userId, id);
  if (link.status !== 'DETACHED') {
    await withTenant(userId, (q) => q.query("UPDATE why_links SET status = 'DETACHED', updated_at = now() WHERE id = $1 AND owner_id = $2", [id, userId]));
  }
  await recordAudit({
    action: AuditAction.WHY_LINK_DETACHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'why_links',
    resourceId: id,
    detail: { file_path: link.file_path, line: link.line },
  });
  return findWhyLinkById(userId, id);
}