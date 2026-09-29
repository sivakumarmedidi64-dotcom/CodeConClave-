/**
 * CodeConClave — Superpowers: SUPPLY-CHAIN SENTINEL (Master Feature #40).
 *
 * Every dependency gets a deterministic verdict from its own facts — how new
 * it is, who maintains it, whether it runs install scripts. Young anonymous
 * packages with install scripts are BLOCKED; one-maintainer / very-new /
 * script-heavy packages are SANDBOXED; everything else is APPROVED. Nothing is
 * ever silently ignored.
 *
 * Pure scoring first, then owner-scoped upsert (one evaluation per package).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type PackageVerdict = 'APPROVE' | 'SANDBOX' | 'BLOCK';

export interface PackageFacts {
  name: string;
  publishedDaysAgo: number;
  lastCommitDaysAgo: number;
  maintainerCount: number;
  hasInstallScript: boolean;
  authorUnknown: boolean;
  projectId?: string | null;
}

export interface EvaluationResult {
  verdict: PackageVerdict;
  reasons: string[];
}

export function evaluatePackageRisk(facts: Omit<PackageFacts, 'name' | 'projectId'>): EvaluationResult {
  const reasons: string[] = [];
  if (facts.publishedDaysAgo < 0 || facts.lastCommitDaysAgo < 0 || facts.maintainerCount < 0) {
    throw AppError.badRequest('invalid_facts', 'days and counts cannot be negative');
  }
  if (facts.hasInstallScript) reasons.push('package runs install scripts at install time');
  if (facts.authorUnknown) reasons.push('package author identity is unknown');
  if (facts.maintainerCount === 1) reasons.push('package is effectively single-maintainer');
  if (facts.publishedDaysAgo < 30) reasons.push(`package is very young (${facts.publishedDaysAgo} days old)`);
  if (facts.lastCommitDaysAgo > 180) reasons.push(`package has been silent for ${facts.lastCommitDaysAgo} days`);

  if ((facts.authorUnknown && facts.publishedDaysAgo < 7) || (facts.authorUnknown && facts.hasInstallScript)) {
    return { verdict: 'BLOCK', reasons: [...reasons, 'anonymous + young or script-heavy package is a blocker'] };
  }
  if (facts.publishedDaysAgo < 30 || facts.maintainerCount === 1 || facts.hasInstallScript) {
    return { verdict: 'SANDBOX', reasons };
  }
  return { verdict: 'APPROVE', reasons };
}

export interface PackageRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  name: string;
  published_days_ago: number;
  last_commit_days_ago: number;
  maintainer_count: number;
  has_install_script: boolean;
  author_unknown: boolean;
  verdict: PackageVerdict;
  reasons: string[];
  created_at: Date;
  updated_at: Date;
}

export const rowOfPackage = (r: Record<string, unknown>): PackageRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  name: String(r.name),
  published_days_ago: Number(r.published_days_ago),
  last_commit_days_ago: Number(r.last_commit_days_ago),
  maintainer_count: Number(r.maintainer_count),
  has_install_script: Boolean(r.has_install_script),
  author_unknown: Boolean(r.author_unknown),
  verdict: r.verdict as PackageVerdict,
  reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function evaluatePackage(userId: string, facts: PackageFacts): Promise<PackageRow> {
  const name = String(facts.name ?? '').trim();
  if (!name) throw AppError.badRequest('invalid_name', 'package name is required');
  const risk = evaluatePackageRisk(facts);
  const existing = await withTenant(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM package_evaluations WHERE owner_id = $1 AND name = $2', [userId, name])).rows[0] ?? null,
  );
  const id = existing ? String(existing.id) : newId(PREFIX.PACKAGE_EVALUATION);
  if (existing) {
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE package_evaluations SET published_days_ago = $1, last_commit_days_ago = $2, maintainer_count = $3, has_install_script = $4, author_unknown = $5, verdict = $6, reasons = $7::jsonb, updated_at = now() WHERE id = $8 AND owner_id = $9',
        [facts.publishedDaysAgo, facts.lastCommitDaysAgo, facts.maintainerCount, facts.hasInstallScript, facts.authorUnknown, risk.verdict, JSON.stringify(risk.reasons), id, userId],
      ),
    );
  } else {
    await withTenant(userId, (q) =>
      q.query(
        'INSERT INTO package_evaluations (id, owner_id, project_id, name, published_days_ago, last_commit_days_ago, maintainer_count, has_install_script, author_unknown, verdict, reasons) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',
        [id, userId, facts.projectId ?? null, name, facts.publishedDaysAgo, facts.lastCommitDaysAgo, facts.maintainerCount, facts.hasInstallScript, facts.authorUnknown, risk.verdict, JSON.stringify(risk.reasons)],
      ),
    );
  }
  await recordAudit({
    action: AuditAction.PACKAGE_EVALUATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'package_evaluations',
    resourceId: id,
    detail: { name, verdict: risk.verdict },
  });
  return listPackages(userId).then((all) => all.find((p) => p.id === id)!);
}

export async function listPackages(userId: string, filter: { verdict?: PackageVerdict } = {}): Promise<PackageRow[]> {
  let rows = (
    await withTenant(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM package_evaluations WHERE owner_id = $1', [userId])).rows,
    )
  ).map(rowOfPackage);
  if (filter.verdict) rows = rows.filter((p) => p.verdict === filter.verdict);
  return rows.sort((a, b) => (b.verdict === 'BLOCK' ? 1 : 0) - (a.verdict === 'BLOCK' ? 1 : 0) || b.id.localeCompare(a.id));
}

export async function getPackage(userId: string, id: string): Promise<PackageRow> {
  const row = await withTenant(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM package_evaluations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('package_not_found', 'no package evaluation found for that id');
  return rowOfPackage(row);
}