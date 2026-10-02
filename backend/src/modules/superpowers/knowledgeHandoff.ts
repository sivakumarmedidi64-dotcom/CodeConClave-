/**
 * CodeConClave — Superpowers: KNOWLEDGE HANDOFF (Master Feature #135).
 *
 * When someone leaves, one click generates their "brain export" for the
 * replacement: everything they touched, every decision, every correction
 * pattern — institutional knowledge preserved instead of lost.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type KnowledgeScope = 'FULL' | 'ESSENTIAL';

export interface ModuleTouch {
  module: string;
  commits: number;
}

export interface DecisionRecord {
  context: string;
  decision: string;
}

export interface CorrectionPattern {
  pattern: string;
  applied: number;
}

export interface KnowledgeExportRow {
  id: string;
  owner_id: string;
  person: string;
  scope: KnowledgeScope;
  modules: ModuleTouch[];
  decisions: DecisionRecord[];
  corrections: CorrectionPattern[];
  digest: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): KnowledgeExportRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  person: String(r.person),
  scope: (r.scope ?? 'FULL') as KnowledgeScope,
  modules: (r.modules ?? []) as ModuleTouch[],
  decisions: (r.decisions ?? []) as DecisionRecord[],
  corrections: (r.corrections ?? []) as CorrectionPattern[],
  digest: String(r.digest),
  created_at: new Date(r.created_at as string),
});

export function buildKnowledgeDigest(person: string, scope: KnowledgeScope, modules: ModuleTouch[], decisions: DecisionRecord[], corrections: CorrectionPattern[]): string {
  const sortedModules = [...modules].sort((a, b) => a.module.localeCompare(b.module));
  const touched = scope === 'ESSENTIAL' ? sortedModules.slice(0, 3) : sortedModules;
  const topModules = [...modules]
    .sort((a, b) => b.commits - a.commits || a.module.localeCompare(b.module))
    .slice(0, 3)
    .map((m) => `${m.module} (${m.commits} commits)`)
    .join(', ');
  const decisionLines = decisions.map((d) => `- ${d.context}: ${d.decision}`).join('\n');
  const correctionLines = corrections.map((c) => `- ${c.pattern}: applied ${c.applied}x`).join('\n');
  const lines = [
    `= BRAIN EXPORT: ${person} (${scope}) =`,
    `TOUCHES (${touched.length}): ${touched.map((m) => m.module).join(', ')}`,
    `TOP MODULES: ${topModules || '—'}`,
    `DECISIONS (${decisions.length}):\n${decisionLines || '—'}`,
  ];
  if (scope === 'FULL') lines.push(`CORRECTIONS (${corrections.length}):\n${correctionLines || '—'}`);
  return lines.join('\n');
}

export async function exportKnowledge(
  userId: string,
  input: {
    person: string;
    scope?: KnowledgeScope;
    modules?: ModuleTouch[];
    decisions?: DecisionRecord[];
    corrections?: CorrectionPattern[];
  },
): Promise<KnowledgeExportRow> {
  if (!input.person || typeof input.person !== 'string') throw AppError.badRequest('invalid_person', 'a person is required for the brain export');
  const scope = input.scope ?? 'FULL';
  if (scope !== 'FULL' && scope !== 'ESSENTIAL') throw AppError.badRequest('invalid_scope', 'scope must be FULL or ESSENTIAL');
  const modules = Array.isArray(input.modules) ? input.modules : [];
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  const corrections = Array.isArray(input.corrections) ? input.corrections : [];
  if (modules.length === 0 && decisions.length === 0 && corrections.length === 0) {
    throw AppError.badRequest('empty_export', 'nothing to export: add modules, decisions, or correction patterns');
  }
  const digest = buildKnowledgeDigest(input.person, scope, modules, decisions, corrections);
  const id = newId(PREFIX.KNOWLEDGE_EXPORT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO knowledge_exports (id, owner_id, person, scope, modules, decisions, corrections, digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.person, scope, modules, decisions, corrections, digest],
  ));
  await recordAudit({
    action: AuditAction.KNOWLEDGE_EXPORT_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'knowledge_exports',
    resourceId: id,
    detail: { person: input.person, scope },
  });
  return getKnowledgeExport(userId, id);
}

export async function getKnowledgeExport(userId: string, id: string): Promise<KnowledgeExportRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM knowledge_exports WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('knowledge_export_not_found', 'no knowledge export found for that id');
  return rowOf(row);
}

export async function listKnowledgeExports(userId: string, filter: { person?: string } = {}): Promise<KnowledgeExportRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM knowledge_exports WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.person) rows = rows.filter((r) => r.person === filter.person);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function knowledgeExportReport(userId: string): Promise<{
  total: number;
  by_scope: Record<KnowledgeScope, number>;
}> {
  const rows = await listKnowledgeExports(userId);
  const by_scope: Record<KnowledgeScope, number> = { FULL: 0, ESSENTIAL: 0 };
  for (const r of rows) by_scope[r.scope] += 1;
  return { total: rows.length, by_scope };
}