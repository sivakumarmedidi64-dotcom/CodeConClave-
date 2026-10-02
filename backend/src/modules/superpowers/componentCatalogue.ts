/**
 * CodeConClave — Superpowers: COMPONENT CATALOGUE (Feature #122).
 *
 * Auto-generates living component library from your codebase.
 * Every component with live preview, props, states, accessibility notes.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ComponentCatalogueEntryRow {
  id: string;
  owner_id: string;
  component_name: string;
  description: string;
  props: string[];
  states: string[];
  accessibility_notes: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ComponentCatalogueEntryRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component_name: String(r.component_name),
  description: String(r.description),
  props: Array.isArray(r.props) ? (r.props as string[]) : [],
  states: Array.isArray(r.states) ? (r.states as string[]) : [],
  accessibility_notes: String(r.accessibility_notes),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createCatalogueEntry(
  userId: string,
  input: { component_name: string; description: string; props: string[]; states: string[]; accessibility_notes: string },
): Promise<ComponentCatalogueEntryRow> {
  if (!input.component_name || typeof input.component_name !== 'string') throw AppError.badRequest('invalid_component_name', 'component name is required');
  const id = newId(PREFIX.COMPONENT_CATALOGUE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO component_catalogue_entries (id, owner_id, component_name, description, props, states, accessibility_notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.component_name, input.description ?? '', input.props ?? [], input.states ?? [], input.accessibility_notes ?? '', 'PARSED'],
  ));
  await recordAudit({
    action: AuditAction.CATALOGUE_PARSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'component_catalogue_entries',
    resourceId: id,
    detail: { component_name: input.component_name },
  });
  return getCatalogueEntry(userId, id);
}

export async function parseCatalogueEntry(
  userId: string,
  id: string,
  input: { props: string[]; states: string[]; accessibility_notes: string },
): Promise<ComponentCatalogueEntryRow> {
  await getCatalogueEntry(userId, id);
  await withTenant(userId, (q) => q.query(
    'UPDATE component_catalogue_entries SET props = $2, states = $3, accessibility_notes = $4, status = $5, updated_at = now() WHERE id = $1 AND owner_id = $6',
    [id, input.props, input.states, input.accessibility_notes, 'PARSED', userId],
  ));
  await recordAudit({
    action: AuditAction.CATALOGUE_PARSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'component_catalogue_entries',
    resourceId: id,
    detail: { props: input.props },
  });
  return getCatalogueEntry(userId, id);
}

export async function publishCatalogueEntry(userId: string, id: string): Promise<ComponentCatalogueEntryRow> {
  await getCatalogueEntry(userId, id);
  await withTenant(userId, (q) => q.query(
    'UPDATE component_catalogue_entries SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'PUBLISHED', userId],
  ));
  await recordAudit({
    action: AuditAction.CATALOGUE_PUBLISHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'component_catalogue_entries',
    resourceId: id,
    detail: {},
  });
  return getCatalogueEntry(userId, id);
}

export async function getCatalogueEntry(userId: string, id: string): Promise<ComponentCatalogueEntryRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM component_catalogue_entries WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('component_catalogue_entry_not_found', 'no component catalogue entry found for that id');
  return rowOf(row);
}

export async function listCatalogueEntries(userId: string): Promise<ComponentCatalogueEntryRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM component_catalogue_entries WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function componentCatalogueReport(userId: string): Promise<{ entries: number; parsed: number; published: number }> {
  const entries = await listCatalogueEntries(userId);
  return {
    entries: entries.length,
    parsed: entries.filter((e) => e.status === 'PARSED').length,
    published: entries.filter((e) => e.status === 'PUBLISHED').length,
  };
}
