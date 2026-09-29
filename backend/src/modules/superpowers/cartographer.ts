/**
 * CodeConClave — Superpowers: DEPENDENCY CARTOGRAPHER (Master Feature #47).
 *
 * Maps not just the dependency tree but the *social* tree: who maintains each
 * package, release cadence, funding status and replacements. Before adopting a
 * package you get "Maintained by 1 person, last commit 8 months ago, no
 * funding" instead of a silent transitive-risk time bomb.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
export type FundingStatus = 'SPONSORED' | 'OPEN_COLLECTIVE' | 'UNFUNDED' | 'UNKNOWN';

export const RISK_LEVELS: RiskLevel[] = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'];
export const FUNDING_STATUSES: FundingStatus[] = ['SPONSORED', 'OPEN_COLLECTIVE', 'UNFUNDED', 'UNKNOWN'];

export interface DependencyProfile {
  package_name: string;
  version?: string;
  maintainer_count: number;
  last_commit_days_ago: number;
  funding_status: FundingStatus;
  replacement_packages: string[];
}

export interface DependencyInsightRow {
  id: string;
  owner_id: string;
  package_name: string;
  profile: DependencyProfile;
  risk_score: number;
  risk_level: RiskLevel;
  recommendations: string[];
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DependencyInsightRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  package_name: String(r.package_name),
  profile: asProfile(r.profile),
  risk_score: Number(r.risk_score ?? 0),
  risk_level: (r.risk_level ?? 'LOW') as RiskLevel,
  recommendations: asStringArray(r.recommendations),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const asStringArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const asProfile = (v: unknown): DependencyProfile => {
  const base = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return {
    package_name: String(base.package_name ?? ''),
    version: base.version ? String(base.version) : undefined,
    maintainer_count: Number(base.maintainer_count ?? 0),
    last_commit_days_ago: Number(base.last_commit_days_ago ?? 0),
    funding_status: (base.funding_status ?? 'UNKNOWN') as FundingStatus,
    replacement_packages: asStringArray(base.replacement_packages),
  };
};

export function assessRisk(profile: {
  maintainer_count: number;
  last_commit_days_ago: number;
  funding_status: FundingStatus;
  replacement_packages: string[];
}): { risk_score: number; risk_level: RiskLevel; recommendations: string[] } {
  let score = 0;
  const recommendations: string[] = [];
  const { maintainer_count: mc, last_commit_days_ago: idle, funding_status: funding, replacement_packages: replacements } = profile;

  if (mc <= 0) {
    score += 50;
    recommendations.push('Wrap-and-isolate: do not adopt this package directly.');
  } else if (mc === 1) {
    score += 30;
    recommendations.push('Single maintainer: consider a fork or a widely-maintained alternative.');
  } else if (mc <= 2) {
    score += 15;
  }
  if (idle > 365) {
    score += 35;
    recommendations.push('Stale releases (12+ months idle): pin the version and plan a replacement.');
  } else if (idle > 180) {
    score += 25;
    recommendations.push('Releases slowing (6+ months idle): plan a defensible replacement path.');
  } else if (idle > 90) {
    score += 15;
  }
  if (funding === 'UNFUNDED') {
    score += 15;
    recommendations.push('Unfunded: verify maintenance commitment before adopting.');
  } else if (funding === 'UNKNOWN') {
    score += 5;
  }
  if (replacements.length > 0) {
    recommendations.push(`Alternatives worth evaluating: ${replacements.join(', ')}.`);
  }
  const risk_level: RiskLevel = score >= 70 ? 'CRITICAL' : score >= 45 ? 'HIGH' : score >= 20 ? 'MODERATE' : 'LOW';
  return { risk_score: score, risk_level, recommendations };
}

export async function assessDependency(userId: string, input: Partial<DependencyProfile>): Promise<DependencyInsightRow> {
  const packageName = (input.package_name ?? '').trim();
  if (!packageName) throw AppError.badRequest('missing_package', 'a package name is required');
  const maintainerCount = Number(input.maintainer_count);
  const idle = Number(input.last_commit_days_ago);
  if (!Number.isFinite(maintainerCount) || maintainerCount < 0) throw AppError.badRequest('invalid_maintainer_count', 'maintainer_count must be a non-negative number');
  if (!Number.isFinite(idle) || idle < 0) throw AppError.badRequest('invalid_idle', 'last_commit_days_ago must be a non-negative number');
  const funding = (input.funding_status ?? 'UNKNOWN') as FundingStatus;
  if (!FUNDING_STATUSES.includes(funding)) throw AppError.badRequest('invalid_funding', 'funding_status must be SPONSORED, OPEN_COLLECTIVE, UNFUNDED or UNKNOWN');
  const replacements = asStringArray(input.replacement_packages);
  const { risk_score, risk_level, recommendations } = assessRisk({ maintainer_count: maintainerCount, last_commit_days_ago: idle, funding_status: funding, replacement_packages: replacements });
  const profile: DependencyProfile = {
    package_name: packageName,
    version: input.version ? String(input.version) : undefined,
    maintainer_count: maintainerCount,
    last_commit_days_ago: idle,
    funding_status: funding,
    replacement_packages: replacements,
  };
  const existing = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM dependency_insights WHERE owner_id = $1 AND package_name = $2', [userId, packageName]).then((r) => r.rows[0] ?? null),
  );
  if (existing) {
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE dependency_insights SET profile = $3, risk_score = $4, risk_level = $5, recommendations = $6, updated_at = now() WHERE id = $1 AND owner_id = $2',
        [String(existing.id), userId, profile, risk_score, risk_level, recommendations],
      ),
    );
    const insight = await findInsightById(userId, String(existing.id));
    await recordAudit({
      action: AuditAction.DEPENDENCY_ASSESSED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'dependency_insights',
      resourceId: insight.id,
      detail: { package_name: packageName, risk_score, risk_level, updated: true },
    });
    return insight;
  }
  const id = newId(PREFIX.DEPENDENCY_INSIGHT);
  await withTenant(userId, (q) =>
    q.query('INSERT INTO dependency_insights (id, owner_id, package_name, profile, risk_score, risk_level, recommendations) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      id,
      userId,
      packageName,
      profile,
      risk_score,
      risk_level,
      recommendations,
    ]),
  );
  await recordAudit({
    action: AuditAction.DEPENDENCY_ASSESSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_insights',
    resourceId: id,
    detail: { package_name: packageName, risk_score, risk_level, updated: false },
  });
  return findInsightById(userId, id);
}

export async function findInsightById(userId: string, id: string): Promise<DependencyInsightRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM dependency_insights WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('insight_not_found', 'no dependency insight found for that id');
  return rowOf(row);
}

export async function getInsight(userId: string, packageName: string): Promise<DependencyInsightRow> {
  const pkg = (packageName ?? '').trim();
  if (!pkg) throw AppError.badRequest('missing_package', 'a package name is required');
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM dependency_insights WHERE owner_id = $1 AND package_name = $2', [userId, pkg]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('insight_not_found', 'no dependency insight found for that package');
  return rowOf(row);
}

export async function listInsights(userId: string, filter: { riskLevel?: string } = {}): Promise<DependencyInsightRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM dependency_insights WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(rowOf);
  if (filter.riskLevel) rows = rows.filter((i) => i.risk_level === filter.riskLevel);
  return rows.sort((a, b) => b.risk_score - a.risk_score || a.package_name.localeCompare(b.package_name));
}

export async function dependencySociety(userId: string): Promise<{
  total: number;
  by_level: Record<RiskLevel, number>;
  top_risks: Array<{ package_name: string; risk_score: number; risk_level: RiskLevel }>;
}> {
  const rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM dependency_insights WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(rowOf);
  const by_level: Record<RiskLevel, number> = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0 };
  for (const r of rows) by_level[r.risk_level] += 1;
  const top = [...rows]
    .sort((a, b) => b.risk_score - a.risk_score || a.package_name.localeCompare(b.package_name))
    .slice(0, 5)
    .map((i) => ({ package_name: i.package_name, risk_score: i.risk_score, risk_level: i.risk_level }));
  return { total: rows.length, by_level, top_risks: top };
}