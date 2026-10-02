/**
 * CodeConClave — Superpowers: DETERMINISM HAMMER (Master Feature #38).
 *
 * Flakiness is a P0 lie. Every flaky test is INVESTIGATED, classified from the
 * actual test source (deterministic pattern scan), given a root cause + fix and
 * only then closed. No working-around, no silence.
 *
 * Pure detection first, then owner-scoped, audited storage.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type FlakeCategory = 'TIME_DEPENDENCE' | 'RANDOM_SEED' | 'ORDER_DEPENDENCE' | 'NETWORK_RELIANCE' | 'UNKNOWN';

export interface FlakeClassification {
  category: FlakeCategory;
  evidence: string;
}

export function categorizeFlake(source: string): FlakeClassification {
  const code = source ?? '';
  const time = /\bnew\s+Date\(\)/.test(code) && !/\b(19|20)\d{2}-\d{2}-\d{2}/.test(code);
  if (time) return { category: 'TIME_DEPENDENCE', evidence: 'test constructs an unbounded new Date() with no fixed clock' };
  if (/\bMath\.random\(\)|\bMath\.floor\(Math\.random/.test(code)) {
    return { category: 'RANDOM_SEED', evidence: 'test draws from an unseeded Math.random()' };
  }
  if (/\b(?:fetch|axios|request|https?\.\w*get)\s*[/(]/.test(code)) {
    return { category: 'NETWORK_RELIANCE', evidence: 'test performs a live network call' };
  }
  if (/\w+\.sort\s*\(\s*\)/.test(code)) {
    return { category: 'ORDER_DEPENDENCE', evidence: 'test relies on a sort that cannot be pinned' };
  }
  return { category: 'UNKNOWN', evidence: 'no determinism hazard detected — investigate manually' };
}

export interface FlakeInput {
  target: string;
  source?: string;
  category?: FlakeCategory;
  evidence?: string;
  rootCause?: string;
  fix?: string;
  projectId?: string | null;
}

export interface FlakeRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  target: string;
  source: string | null;
  category: FlakeCategory;
  evidence: string | null;
  root_cause: string | null;
  fix: string | null;
  status: 'OPEN' | 'FIXED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): FlakeRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  target: String(r.target),
  source: r.source ? String(r.source) : null,
  category: r.category as FlakeCategory,
  evidence: r.evidence ? String(r.evidence) : null,
  root_cause: r.root_cause ? String(r.root_cause) : null,
  fix: r.fix ? String(r.fix) : null,
  status: r.status as FlakeRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findFlakeById(userId: string, id: string): Promise<FlakeRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM flake_investigations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('flake_not_found', 'no flake investigation found for that id');
  return rowOf(row);
}

export async function recordFlakeInvestigation(userId: string, input: FlakeInput): Promise<FlakeRow> {
  const target = String(input.target ?? '').trim();
  if (!target) throw AppError.badRequest('invalid_target', 'target is required');
  const classification = input.category && input.category !== 'UNKNOWN'
    ? { category: input.category, evidence: input.evidence ?? null }
    : input.source
      ? categorizeFlake(input.source)
      : { category: (input.category ?? 'UNKNOWN') as FlakeCategory, evidence: input.evidence ?? null };
  const id = newId(PREFIX.FLAKE_INVESTIGATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO flake_investigations (id, owner_id, project_id, target, source, category, evidence, root_cause, fix) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.projectId ?? null, target, input.source ?? null, classification.category, classification.evidence, input.rootCause ?? null, input.fix ?? null],
  ));
  await recordAudit({
    action: AuditAction.FLAKE_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'flake_investigations',
    resourceId: id,
    detail: { target, category: classification.category },
  });
  return findFlakeById(userId, id);
}

export async function listFlakeInvestigations(userId: string, filter: { status?: 'OPEN' | 'FIXED'; category?: FlakeCategory } = {}): Promise<FlakeRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM flake_investigations WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.category) rows = rows.filter((r) => r.category === filter.category);
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}

export async function resolveFlakeInvestigation(userId: string, id: string): Promise<FlakeRow> {
  const flake = await findFlakeById(userId, id);
  if (flake.status !== 'FIXED') {
    await withTenant(userId, (q) => q.query("UPDATE flake_investigations SET status = 'FIXED', updated_at = now() WHERE id = $1 AND owner_id = $2", [id, userId]));
  }
  await recordAudit({
    action: AuditAction.FLAKE_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'flake_investigations',
    resourceId: id,
    detail: { target: flake.target, category: flake.category },
  });
  return findFlakeById(userId, id);
}