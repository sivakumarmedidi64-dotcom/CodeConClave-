/**
 * CodeConClave — Superpowers: INSTITUTIONAL TRANSFER (Master Feature #26).
 *
 * When a senior engineer leaves, everything they knew — every commit, review
 * comment, correction, and pattern they enforced — is exported as a complete
 * brain export. The replacement does not start at zero; the company's scar
 * tissue is preserved as an asset.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type BrainEntryKind = 'commit' | 'review' | 'correction' | 'pattern';

export interface BrainEntry {
  kind: BrainEntryKind;
  subject: string;
  note: string;
}

export type InstitutionalExportStatus = 'DRAFTED' | 'PACKAGED';

export interface InstitutionalExportRow {
  id: string;
  owner_id: string;
  engineer: string;
  exports: Record<BrainEntryKind, number>;
  highlights: BrainEntry[];
  summary: string;
  status: InstitutionalExportStatus;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): InstitutionalExportRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  engineer: String(r.engineer),
  exports: (r.exports ?? {}) as Record<BrainEntryKind, number>,
  highlights: (r.highlights ?? []) as BrainEntry[],
  summary: String(r.summary),
  status: r.status as InstitutionalExportStatus,
  created_at: new Date(r.created_at as string),
});

export function compileBrainExport(engineer: string, entries: BrainEntry[]): { exports: Record<BrainEntryKind, number>; highlights: BrainEntry[]; summary: string } {
  const counts: Record<BrainEntryKind, number> = { commit: 0, review: 0, correction: 0, pattern: 0 };
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const highlights = entries.slice(0, 8);
  const summary = `${engineer}'s brain export: ${entries.length} pieces of context preserved — ${counts.commit} commits, ${counts.review} review comments, ${counts.correction} corrections, ${counts.pattern} patterns`;
  return { exports: counts, highlights, summary };
}

export async function exportBrain(userId: string, input: { engineer: string; entries: BrainEntry[] }): Promise<InstitutionalExportRow> {
  if (!input.engineer || typeof input.engineer !== 'string') throw AppError.badRequest('invalid_engineer', 'an engineer name is required');
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw AppError.badRequest('empty_export', 'there is nothing to export yet');
  for (const e of input.entries) {
    if (!['commit', 'review', 'correction', 'pattern'].includes(e.kind)) throw AppError.badRequest('invalid_kind', `${e.kind} is not a brain export entry kind`);
    if (!e.subject) throw AppError.badRequest('invalid_entry', 'every entry needs a subject');
  }
  const compiled = compileBrainExport(input.engineer, input.entries);
  const id = newId(PREFIX.INSTITUTIONAL_EXPORT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO institutional_exports (id, owner_id, engineer, exports, highlights, summary, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.engineer, compiled.exports, compiled.highlights, compiled.summary, 'DRAFTED'],
  ));
  await recordAudit({
    action: AuditAction.TRANSFER_EXPORTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'institutional_exports',
    resourceId: id,
    detail: { engineer: input.engineer, total: input.entries.length },
  });
  return getInstitutionalExport(userId, id);
}

export async function packageExport(userId: string, id: string): Promise<InstitutionalExportRow> {
  const exp = await getInstitutionalExport(userId, id);
  if (exp.status === 'PACKAGED') throw AppError.badRequest('export_already_packaged', 'this brain export is already packaged');
  await withTenant(userId, (q) => q.query('UPDATE institutional_exports SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'PACKAGED', userId]));
  await recordAudit({
    action: AuditAction.TRANSFER_PACKAGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'institutional_exports',
    resourceId: id,
    detail: { engineer: exp.engineer },
  });
  return getInstitutionalExport(userId, id);
}

export async function getInstitutionalExport(userId: string, id: string): Promise<InstitutionalExportRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM institutional_exports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('institutional_export_not_found', 'no institutional export found for that id');
  return rowOf(row);
}

export async function listInstitutionalExports(userId: string): Promise<InstitutionalExportRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM institutional_exports WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function institutionalReport(userId: string): Promise<{ exports: number; packaged: number; total_pieces: number }> {
  const exportsList = await listInstitutionalExports(userId);
  const totalPieces = exportsList.reduce((s, e) => s + Object.values(e.exports).reduce((a, b) => a + b, 0), 0);
  return {
    exports: exportsList.length,
    packaged: exportsList.filter((e) => e.status === 'PACKAGED').length,
    total_pieces: totalPieces,
  };
}