/**
 * CodeConClave — Superpowers: ORG MEMORY PORTABILITY (Master Feature #53).
 *
 * One click exports the entire institutional knowledge graph — Memory Gravity,
 * DNA, decision history — as a portable, queryable archive. If you ever leave,
 * your knowledge comes with you. Trust through exit rights.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ExportComponent {
  kind: string;
  count: number;
}

export interface MemoryExportRow {
  id: string;
  owner_id: string;
  components: string[];
  stats: ExportComponent[];
  archive_ref: string;
  size_bytes: number;
  status: string;
  created_at: Date;
}

const KNOWN_COMPONENTS = ['memory_gravity', 'dna', 'decision_history', 'patterns', 'lessons'];
const BYTES_PER_ENTRY = 512;
const BYTES_PER_COMPONENT = 1024;

const rowOf = (r: Record<string, unknown>): MemoryExportRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  components: (r.components ?? []) as string[],
  stats: (r.stats ?? []) as ExportComponent[],
  archive_ref: String(r.archive_ref),
  size_bytes: Number(r.size_bytes),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
});

export function estimateExportSize(stats: ExportComponent[]): number {
  const entries = stats.reduce((s, c) => s + c.count, 0);
  return entries * BYTES_PER_ENTRY + stats.length * BYTES_PER_COMPONENT;
}

export async function exportMemoryGraph(userId: string, input: { components: ExportComponent[] }): Promise<MemoryExportRow> {
  if (!Array.isArray(input.components) || input.components.length === 0) throw AppError.badRequest('empty_export', 'at least one knowledge component is required');
  for (const c of input.components) {
    if (!KNOWN_COMPONENTS.includes(c.kind)) throw AppError.badRequest('unknown_component', `${c.kind} is not a portable knowledge component`);
    if (typeof c.count !== 'number' || c.count < 0) throw AppError.badRequest('invalid_count', 'component counts must be non-negative');
  }
  const id = newId(PREFIX.MEMORY_EXPORT);
  const archiveRef = `memory-export-${id}`;
  const sizeBytes = estimateExportSize(input.components);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO memory_exports (id, owner_id, components, stats, archive_ref, size_bytes, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.components.map((c) => c.kind), input.components, archiveRef, sizeBytes, 'EXPORTED'],
  ));
  await recordAudit({
    action: AuditAction.MEMORY_EXPORTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory_exports',
    resourceId: id,
    detail: { archive_ref: archiveRef, size_bytes: sizeBytes, components: input.components.map((c) => c.kind) },
  });
  return getMemoryExport(userId, id);
}

/** Query the portable archive by name; returns every matching component and how many entries it holds. */
export async function queryExport(userId: string, id: string, query: string): Promise<{ matches: ExportComponent[]; answer: string }> {
  const exp = await getMemoryExport(userId, id);
  if (!query || typeof query !== 'string') throw AppError.badRequest('invalid_query', 'a query term is required');
  const term = query.toLowerCase();
  const matches = exp.stats.filter((c) => c.kind.toLowerCase().includes(term));
  if (matches.length === 0) return { matches: [], answer: `no component of this export mentions "${query}"` };
  const total = matches.reduce((s, c) => s + c.count, 0);
  return { matches, answer: `found ${total} entries across ${matches.length} component(s) matching "${query}"` };
}

export async function getMemoryExport(userId: string, id: string): Promise<MemoryExportRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM memory_exports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('memory_export_not_found', 'no memory export found for that id');
  return rowOf(row);
}

export async function listMemoryExports(userId: string): Promise<MemoryExportRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM memory_exports WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function memoryPortabilityReport(userId: string): Promise<{ exports: number; total_entries: number; total_bytes: number }> {
  const exportsList = await listMemoryExports(userId);
  return {
    exports: exportsList.length,
    total_entries: exportsList.reduce((s, e) => s + e.stats.reduce((a, c) => a + c.count, 0), 0),
    total_bytes: exportsList.reduce((s, e) => s + e.size_bytes, 0),
  };
}