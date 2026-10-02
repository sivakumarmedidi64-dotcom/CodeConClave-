/**
 * CodeConClave — Superpowers: CLONE KILLER (Master Feature #63).
 *
 * Find duplicated logic even when variable names, structure, and style differ
 * completely — semantic deduplication, then propose the canonical abstraction.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CloneFragmentRow {
  id: string;
  owner_id: string;
  name: string;
  language: string;
  code: string;
  signature: string;
  abstraction: string | null;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CloneFragmentRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  name: String(r.name),
  language: String(r.language),
  code: String(r.code),
  signature: String(r.signature),
  abstraction: r.abstraction == null ? null : String(r.abstraction),
  created_at: new Date(r.created_at as string),
});

const DECL_TYPES = new Set(['const', 'let', 'var', 'function', 'def', 'func', 'fn']);
const STRUCTURAL = new Set(['for', 'while', 'foreach', 'if', 'else', 'return', 'try', 'catch', 'class', 'import', 'from', 'use', 'require', 'async', 'await', 'switch', 'case', 'break', 'continue', 'throw', 'new', 'typeof', 'instanceof']);

/** Semantic skeleton: identifiers and literals are dropped, declarations are canonical. */
export function signatureFor(code: string): string {
  const words = code.toLowerCase().match(/[a-z_$][a-z0-9_$]*/g) ?? [];
  const tokens = words
    .map((w) => (DECL_TYPES.has(w) ? 'DECL' : STRUCTURAL.has(w) ? w : null))
    .filter((t): t is string => t !== null);
  return tokens.sort().join(':');
}

export async function registerFragment(userId: string, input: { name: string; language: string; code: string }): Promise<CloneFragmentRow> {
  if (!input.name || typeof input.name !== 'string') throw AppError.badRequest('invalid_name', 'a name is required so the twin can be named');
  if (!input.language || typeof input.language !== 'string') throw AppError.badRequest('invalid_language', 'a language is required');
  if (!input.code || typeof input.code !== 'string' || input.code.trim().length === 0) throw AppError.badRequest('invalid_code', 'the code region is required');
  const signature = signatureFor(input.code);
  const id = newId(PREFIX.CLONE_FRAGMENT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO clone_fragments (id, owner_id, name, language, code, signature, abstraction) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.name, input.language, input.code, signature, null],
  ));
  await recordAudit({
    action: AuditAction.CLONE_REGISTERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'clone_fragments',
    resourceId: id,
    detail: { name: input.name, language: input.language, signature },
  });
  return getCloneFragment(userId, id);
}

/** Find the semantic twin and propose the canonical abstraction. */
export async function proposeAbstraction(userId: string, id: string): Promise<CloneFragmentRow> {
  const fragment = await getCloneFragment(userId, id);
  const siblings = (await listCloneFragments(userId)).filter((f) => f.signature === fragment.signature && f.id !== id);
  if (siblings.length === 0) throw AppError.notFound('clone_twin_not_found', 'no semantic twin yet — this fragment is unique so far');
  const abstraction = `extract ${siblings.length + 1}-wise ${fragment.language} clone (${fragment.name} + ${siblings.map((s) => s.name).join(', ')}) into one canonical abstraction`;
  await withTenant(userId, (q) => q.query('UPDATE clone_fragments SET abstraction = $2 WHERE id = $1 AND owner_id = $3', [id, abstraction, userId]));
  await recordAudit({
    action: AuditAction.CLONE_MATCHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'clone_fragments',
    resourceId: id,
    detail: { signature: fragment.signature, twin: siblings[0]!.name, clones: siblings.length + 1 },
  });
  await recordAudit({
    action: AuditAction.CLONE_ABSTRACTION_PROPOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'clone_fragments',
    resourceId: id,
    detail: { abstraction },
  });
  return getCloneFragment(userId, id);
}

export async function getCloneFragment(userId: string, id: string): Promise<CloneFragmentRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM clone_fragments WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('clone_fragment_not_found', 'no clone fragment found for that id');
  return rowOf(row);
}

export async function listCloneFragments(userId: string): Promise<CloneFragmentRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM clone_fragments WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function cloneKillerReport(userId: string): Promise<{ fragments: number; languages: number; matched: number; abstractions_proposed: number }> {
  const fragments = await listCloneFragments(userId);
  const bySignature = new Map<string, number>();
  for (const f of fragments) bySignature.set(f.signature, (bySignature.get(f.signature) ?? 0) + 1);
  return {
    fragments: fragments.length,
    languages: new Set(fragments.map((f) => f.language)).size,
    matched: fragments.filter((f) => (bySignature.get(f.signature) ?? 0) > 1).length,
    abstractions_proposed: fragments.filter((f) => f.abstraction != null).length,
  };
}