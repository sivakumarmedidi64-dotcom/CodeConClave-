/**
 * CodeConClave — Superpowers: CONCEPT GAP DETECTOR (Master Feature #49).
 *
 * Finds places where the codebase implements the same concept three different
 * ways under three different names — User, Account, Member are the same thing,
 * three schemas, three bugs waiting. Proposes a unification plan with
 * migration paths straight from the scan.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ConceptLocation {
  name: string;
  path: string;
  usage: string;
}

export type ConceptScanStatus = 'FOUND' | 'UNIFYING' | 'RESOLVED';

export interface ConceptGapScanRow {
  id: string;
  owner_id: string;
  concept: string;
  aliases: string[];
  locations: ConceptLocation[];
  schema_count: number;
  unification: string;
  migration_paths: string[];
  status: ConceptScanStatus;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ConceptGapScanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  concept: String(r.concept),
  aliases: (r.aliases ?? []) as string[],
  locations: (r.locations ?? []) as ConceptLocation[],
  schema_count: Number(r.schema_count),
  unification: String(r.unification),
  migration_paths: (r.migration_paths ?? []) as string[],
  status: r.status as ConceptScanStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** One migration path per divergent alias, onto the canonical first alias. */
export function buildUnificationPlan(concept: string, aliases: string[], locations: ConceptLocation[]): { schema_count: number; unification: string; migration_paths: string[] } {
  const canonical = aliases[0]!;
  const distinct = new Set(locations.map((l) => l.name)).size;
  const migrationPaths = aliases.slice(1).map((alias) => `merge ${alias} resource into ${canonical} (${concept})`);
  return {
    schema_count: distinct,
    unification: `${concept} is implemented ${distinct} different ways under ${distinct} schemas; unify onto ${canonical}`,
    migration_paths: migrationPaths,
  };
}

export async function runConceptScan(userId: string, input: { concept: string; aliases: string[]; locations: ConceptLocation[] }): Promise<ConceptGapScanRow> {
  if (!input.concept || typeof input.concept !== 'string') throw AppError.badRequest('invalid_concept', 'a concept name is required');
  if (!Array.isArray(input.aliases) || input.aliases.length < 2) throw AppError.badRequest('too_few_aliases', 'a concept gap needs at least 2 aliases');
  if (!Array.isArray(input.locations) || input.locations.length < 2) throw AppError.badRequest('too_few_locations', 'a concept gap needs at least 2 locations');
  const distinctNames = new Set(input.locations.map((l) => l.name));
  if (distinctNames.size < 2) throw AppError.badRequest('no_gap', 'every location uses the same name; there is no gap');

  const plan = buildUnificationPlan(input.concept, input.aliases, input.locations);
  const id = newId(PREFIX.CONCEPT_GAP_SCAN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO concept_gap_scans (id, owner_id, concept, aliases, locations, schema_count, unification, migration_paths, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.concept, input.aliases, input.locations, plan.schema_count, plan.unification, plan.migration_paths, 'FOUND'],
  ));
  await recordAudit({
    action: AuditAction.CONCEPT_GAP_FOUND,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'concept_gap_scans',
    resourceId: id,
    detail: { concept: input.concept, aliases: input.aliases, schema_count: plan.schema_count },
  });
  return getConceptScan(userId, id);
}

export async function unifyConcept(userId: string, id: string): Promise<ConceptGapScanRow> {
  const scan = await getConceptScan(userId, id);
  if (scan.status !== 'FOUND') throw AppError.badRequest('scan_not_found_state', 'only a fresh FOUND scan can start unification');
  await withTenant(userId, (q) => q.query('UPDATE concept_gap_scans SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'UNIFYING', userId]));
  await recordAudit({
    action: AuditAction.CONCEPT_UNIFICATION_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'concept_gap_scans',
    resourceId: id,
    detail: { concept: scan.concept, migration_paths: scan.migration_paths },
  });
  return getConceptScan(userId, id);
}

export async function resolveConceptGap(userId: string, id: string): Promise<ConceptGapScanRow> {
  const scan = await getConceptScan(userId, id);
  if (scan.status !== 'UNIFYING') throw AppError.badRequest('scan_not_unifying', 'start unification before resolving it');
  await withTenant(userId, (q) => q.query('UPDATE concept_gap_scans SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'RESOLVED', userId]));
  await recordAudit({
    action: AuditAction.CONCEPT_GAP_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'concept_gap_scans',
    resourceId: id,
    detail: { concept: scan.concept },
  });
  return getConceptScan(userId, id);
}

export async function getConceptScan(userId: string, id: string): Promise<ConceptGapScanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM concept_gap_scans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('concept_gap_scan_not_found', 'no concept gap scan found for that id');
  return rowOf(row);
}

export async function listConceptScans(userId: string): Promise<ConceptGapScanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM concept_gap_scans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function conceptGapReport(userId: string): Promise<{ scans: number; unifying: number; resolved: number }> {
  const scans = await listConceptScans(userId);
  return {
    scans: scans.length,
    unifying: scans.filter((s) => s.status === 'UNIFYING').length,
    resolved: scans.filter((s) => s.status === 'RESOLVED').length,
  };
}