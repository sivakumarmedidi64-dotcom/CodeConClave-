/**
 * CodeConClave — Superpowers: ONTOLOGY ENGINE (Master Feature #50).
 *
 * A living dictionary of every domain term. Divergence scans flag places where
 * an alias is used instead of the canonical name (Workspace / Organization /
 * Workspace), violations are resolved by the team, and agreed corrections
 * propagate to every registry entry.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type OntologySourceType = 'CODE' | 'DOCS' | 'API' | 'UI_COPY';

export interface OntologyTermRow {
  id: string;
  owner_id: string;
  canonical_name: string;
  aliases: string[];
  definition: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OntologyViolationRow {
  id: string;
  owner_id: string;
  term_id: string;
  source_type: OntologySourceType;
  location: string;
  used_term: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  created_at: Date;
  updated_at: Date;
}

const termOf = (r: Record<string, unknown>): OntologyTermRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  canonical_name: String(r.canonical_name),
  aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
  definition: r.definition ? String(r.definition) : null,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const violationOf = (r: Record<string, unknown>): OntologyViolationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  term_id: String(r.term_id),
  source_type: r.source_type as OntologySourceType,
  location: String(r.location),
  used_term: String(r.used_term),
  status: r.status as OntologyViolationRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findTermById(userId: string, id: string): Promise<OntologyTermRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    q
      .query<Record<string, unknown>>('SELECT * FROM ontology_terms WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('ontology_term_not_found', 'no ontology term found for that id');
  return termOf(row);
}

export async function listTerms(userId: string): Promise<OntologyTermRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM ontology_terms WHERE owner_id = $1', [userId])).rows,
  );
  return rows
    .map(termOf)
    .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name) || b.id.localeCompare(a.id));
}

export interface RegisterTermInput {
  canonicalName: string;
  aliases?: string[];
  definition?: string | null;
}

export async function registerTerm(userId: string, input: RegisterTermInput): Promise<OntologyTermRow> {
  const canonical = (input.canonicalName ?? '').trim();
  if (!canonical) throw AppError.badRequest('missing_canonical_name', 'a canonical term name is required');
  const aliasList = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== canonical.toLowerCase()))];
  const existing = (await listTerms(userId)).find(
    (t) => t.canonical_name.toLowerCase() === canonical.toLowerCase() || t.aliases.some((a) => a.toLowerCase() === canonical.toLowerCase()),
  );
  if (existing) {
    const merged = [...new Set([...existing.aliases, ...aliasList].map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== existing.canonical_name.toLowerCase()))];
    await withTenant(userId, (q) =>
      q.query('UPDATE ontology_terms SET aliases = $3::jsonb, definition = $4, updated_at = now() WHERE id = $1 AND owner_id = $2', [
        existing.id,
        userId,
        JSON.stringify(merged),
        input.definition !== undefined && input.definition !== null ? input.definition : existing.definition,
      ]),
    );
    await recordAudit({
      action: AuditAction.ONTOLOGY_TERM_REGISTERED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'ontology_terms',
      resourceId: existing.id,
      detail: { canonicalName: canonical, aliases: merged.length, updated: true },
    });
    return findTermById(userId, existing.id);
  }
  const id = newId(PREFIX.ONTOLOGY_TERM);
  await withTenant(userId, (q) =>
    q.query('INSERT INTO ontology_terms (id, owner_id, canonical_name, aliases, definition) VALUES ($1,$2,$3,$4::jsonb,$5)', [
      id,
      userId,
      canonical,
      JSON.stringify(aliasList),
      input.definition ?? null,
    ]),
  );
  await recordAudit({
    action: AuditAction.ONTOLOGY_TERM_REGISTERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ontology_terms',
    resourceId: id,
    detail: { canonicalName: canonical, aliases: aliasList.length, updated: false },
  });
  return findTermById(userId, id);
}

export interface TermObservation {
  name: string;
  sourceType: OntologySourceType;
  location: string;
}

export interface TermScanResult {
  flagged: OntologyViolationRow[];
  counts: { observed: number; canonical: number; flagged: number; existing: number; unmatched: number };
}

/**
 * Scan observations of how terms are actually used. Wherever an alias stands in
 * for the canonical name a violation is recorded (once per location); canonical
 * use and unknown words pass through, reported in counts.
 */
export async function logTermScan(userId: string, observations: TermObservation[]): Promise<TermScanResult> {
  const terms = await listTerms(userId);
  const openViolations = await listViolations(userId, { status: 'OPEN' });
  const flagged: OntologyViolationRow[] = [];
  const counts = { observed: 0, canonical: 0, flagged: 0, existing: 0, unmatched: 0 };
  for (const obs of observations ?? []) {
    const name = (obs.name ?? '').trim();
    if (!name || (obs.sourceType !== 'CODE' && obs.sourceType !== 'DOCS' && obs.sourceType !== 'API' && obs.sourceType !== 'UI_COPY')) continue;
    counts.observed += 1;
    const match = terms.find(
      (t) => t.canonical_name.toLowerCase() === name.toLowerCase() || t.aliases.some((a) => a.toLowerCase() === name.toLowerCase()),
    );
    if (!match) {
      counts.unmatched += 1;
      continue;
    }
    if (match.canonical_name.toLowerCase() === name.toLowerCase()) {
      counts.canonical += 1;
      continue;
    }
    const already = openViolations.find(
      (v) => v.term_id === match.id && v.source_type === obs.sourceType && v.location === obs.location && v.status === 'OPEN',
    );
    if (already) {
      counts.existing += 1;
      flagged.push(already);
      continue;
    }
    const id = newId(PREFIX.ONTOLOGY_VIOLATION);
    const row = (
      await withTenant(userId, (q) =>
        q.query(
          'INSERT INTO ontology_violations (id, owner_id, term_id, source_type, location, used_term) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, userId, match.id, obs.sourceType, obs.location, name],
        ),
      )
    ).rows[0] as Record<string, unknown>;
    flagged.push(violationOf(row));
    counts.flagged += 1;
  }
  await recordAudit({
    action: AuditAction.ONTOLOGY_DIVERGENCE_SCANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ontology_violations',
    resourceId: null,
    detail: counts,
  });
  return { flagged, counts };
}

export async function listViolations(userId: string, filter: { status?: OntologyViolationRow['status']; termId?: string } = {}): Promise<OntologyViolationRow[]> {
  let rows = (
    await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM ontology_violations WHERE owner_id = $1', [userId])).rows,
    )
  ).map(violationOf);
  if (filter.status) rows = rows.filter((v) => v.status === filter.status);
  if (filter.termId) rows = rows.filter((v) => v.term_id === filter.termId);
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}

export async function resolveViolation(userId: string, violationId: string, accepted: boolean): Promise<OntologyViolationRow> {
  const violations = await listViolations(userId);
  const violation = violations.find((v) => v.id === violationId);
  if (!violation) throw AppError.notFound('ontology_violation_not_found', 'no ontology violation found for that id');
  const status = accepted ? 'APPROVED' : 'REJECTED';
  if (violation.status !== status) {
    await withTenant(userId, (q) =>
      q.query('UPDATE ontology_violations SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [
        violationId,
        userId,
        status,
      ]),
    );
  }
  await recordAudit({
    action: AuditAction.ONTOLOGY_VIOLATION_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ontology_violations',
    resourceId: violationId,
    detail: { status, accepted },
  });
  return (await listViolations(userId)).find((v) => v.id === violationId)!;
}

/**
 * When the team agrees on a term, every registry that still held the old name
 * is corrected: the agreed canonical name is propagated into its aliases and the
 * rejected name is dropped.
 */
export async function unifyTerm(userId: string, input: { oldName: string; canonicalName: string }): Promise<{ terms: number }> {
  const oldName = (input.oldName ?? '').trim().toLowerCase();
  const canonicalName = (input.canonicalName ?? '').trim();
  if (!oldName || !canonicalName) throw AppError.badRequest('incomplete_unify', 'oldName and canonicalName are required');
  const affected = (await listTerms(userId)).filter((t) => t.aliases.some((a) => a.toLowerCase() === oldName));
  for (const term of affected) {
    const nextAliases = term.aliases.filter((a) => a.toLowerCase() !== oldName);
    if (canonicalName.toLowerCase() !== term.canonical_name.toLowerCase() && !nextAliases.some((a) => a.toLowerCase() === canonicalName.toLowerCase())) {
      nextAliases.push(canonicalName);
    }
    await withTenant(userId, (q) =>
      q.query('UPDATE ontology_terms SET aliases = $3::jsonb, updated_at = now() WHERE id = $1 AND owner_id = $2', [
        term.id,
        userId,
        JSON.stringify(nextAliases),
      ]),
    );
  }
  await recordAudit({
    action: AuditAction.ONTOLOGY_TERM_UNIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ontology_terms',
    resourceId: null,
    detail: { oldName, canonicalName, terms: affected.length },
  });
  return { terms: affected.length };
}