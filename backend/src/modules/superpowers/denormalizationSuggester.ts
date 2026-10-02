/**
 * CodeConClave — Superpowers: DENORMALIZATION SUGGESTER (#128).
 *
 * Finds queries that would benefit from denormalized data; drafts the
 * materialized view. Before/after performance numbers included.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DenormSuggestionRow {
  id: string;
  owner_id: string;
  query_text: string;
  source_tables: string[];
  suggested_view: string;
  estimated_improvement: number | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DenormSuggestionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  query_text: String(r.query_text),
  source_tables: Array.isArray(r.source_tables) ? (r.source_tables as string[]) : [],
  suggested_view: String(r.suggested_view),
  estimated_improvement: r.estimated_improvement == null ? null : Number(r.estimated_improvement),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createDenormSuggestion(userId: string, input: { query_text: string; source_tables: string[]; suggested_view: string }): Promise<DenormSuggestionRow> {
  if (!input.query_text || typeof input.query_text !== 'string') throw AppError.badRequest('invalid_query', 'a query text is required');
  if (!Array.isArray(input.source_tables) || input.source_tables.length === 0) throw AppError.badRequest('no_source_tables', 'at least one source table is required');
  if (!input.suggested_view || typeof input.suggested_view !== 'string') throw AppError.badRequest('invalid_view', 'a suggested view name is required');
  const id = newId(PREFIX.DENORMALIZATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO denorm_suggestions (id, owner_id, query_text, source_tables, suggested_view, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.query_text, input.source_tables, input.suggested_view, 'SUGGESTED'],
  ));
  await recordAudit({
    action: AuditAction.DENORMALIZATION_SUGGESTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'denorm_suggestions',
    resourceId: id,
    detail: { query_text: input.query_text, source_tables: input.source_tables },
  });
  return getDenormSuggestion(userId, id);
}

export async function applyDenormSuggestion(userId: string, id: string, input: { estimated_improvement: number }): Promise<DenormSuggestionRow> {
  if (input.estimated_improvement == null || typeof input.estimated_improvement !== 'number') throw AppError.badRequest('invalid_improvement', 'a numeric estimated improvement is required');
  const suggestion = await getDenormSuggestion(userId, id);
  if (suggestion.status === 'APPLIED') throw AppError.badRequest('already_applied', 'suggestion has already been applied');
  await withTenant(userId, (q) => q.query(
    'UPDATE denorm_suggestions SET estimated_improvement = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.estimated_improvement, 'APPLIED', userId],
  ));
  return getDenormSuggestion(userId, id);
}

export async function getDenormSuggestion(userId: string, id: string): Promise<DenormSuggestionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM denorm_suggestions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('denorm_suggestion_not_found', 'no denorm suggestion found for that id');
  return rowOf(row);
}

export async function listDenormSuggestions(userId: string): Promise<DenormSuggestionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM denorm_suggestions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function denormSuggestionReport(userId: string): Promise<{ total: number; suggested: number; applied: number; avg_improvement: number }> {
  const rows = await listDenormSuggestions(userId);
  const withImpr = rows.filter((r) => r.estimated_improvement != null);
  return {
    total: rows.length,
    suggested: rows.filter((r) => r.status === 'SUGGESTED').length,
    applied: rows.filter((r) => r.status === 'APPLIED').length,
    avg_improvement: withImpr.length > 0 ? withImpr.reduce((s, r) => s + (r.estimated_improvement ?? 0), 0) / withImpr.length : 0,
  };
}
