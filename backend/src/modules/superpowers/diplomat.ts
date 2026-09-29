/**
 * CodeConClave — Superpowers: DIPLOMAT (Master Feature #32).
 *
 * Keeps every dependency current and every CVE patched without a human opening
 * package.json. Each upgrade attempt runs against the test suite: passes clean
 * and it is surfaced for review; breaks something and it is rolled back with a
 * report on exactly what broke.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type DepFreshness = 'CURRENT' | 'OUTDATED' | 'AHEAD';
export type UpgradeOutcome = 'PASS' | 'FAIL';
export type UpgradeStatus = 'SURFACED' | 'ROLLED_BACK';

export const FRESHNESSES: DepFreshness[] = ['CURRENT', 'OUTDATED', 'AHEAD'];

export interface DependencyRow {
  id: string;
  owner_id: string;
  package_name: string;
  current_version: string;
  latest_version: string;
  cves: string[];
  breaking_changes: string | null;
  freshness: DepFreshness;
  created_at: Date;
  updated_at: Date;
}

export interface UpgradeRow {
  id: string;
  owner_id: string;
  dependency_id: string;
  from_version: string;
  to_version: string;
  cve_count: number;
  test_outcome: UpgradeOutcome;
  status: UpgradeStatus;
  breakage_report: string | null;
  created_at: Date;
}

const depRowOf = (r: Record<string, unknown>): DependencyRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  package_name: String(r.package_name),
  current_version: String(r.current_version),
  latest_version: String(r.latest_version),
  cves: asStringArray(r.cves),
  breaking_changes: r.breaking_changes ? String(r.breaking_changes) : null,
  freshness: (r.freshness ?? 'CURRENT') as DepFreshness,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const upgradeRowOf = (r: Record<string, unknown>): UpgradeRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  dependency_id: String(r.dependency_id),
  from_version: String(r.from_version),
  to_version: String(r.to_version),
  cve_count: Number(r.cve_count ?? 0),
  test_outcome: r.test_outcome as UpgradeOutcome,
  status: r.status as UpgradeStatus,
  breakage_report: r.breakage_report ? String(r.breakage_report) : null,
  created_at: new Date(r.created_at as string),
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

export function versionCompare(a: string, b: string): number {
  const pa = String(a ?? '').split('.').map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  const pb = String(b ?? '').split('.').map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const freshnessOf = (current: string, latest: string): DepFreshness => {
  const c = versionCompare(current, latest);
  return c < 0 ? 'OUTDATED' : c > 0 ? 'AHEAD' : 'CURRENT';
};

export async function upsertDependency(
  userId: string,
  input: { packageName?: string; currentVersion?: string; latestVersion?: string; cves?: string[]; breakingChanges?: string | null },
): Promise<DependencyRow> {
  const packageName = (input.packageName ?? '').trim();
  const currentVersion = (input.currentVersion ?? '').trim();
  const latestVersion = (input.latestVersion ?? '').trim();
  if (!packageName || !currentVersion || !latestVersion) throw AppError.badRequest('incomplete_dependency', 'package name, current and latest versions are required');
  const cves = (Array.isArray(input.cves) ? input.cves : []).map(String).filter((c) => c.length > 0);
  const breakingChanges = input.breakingChanges ?? null;
  const freshness = freshnessOf(currentVersion, latestVersion);
  const existing = await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db
      .query<Record<string, unknown>>('SELECT * FROM diplomat_dependencies WHERE owner_id = $1 AND package_name = $2', [userId, packageName])
      .then((r) => r.rows[0] ?? null),
  );
  if (existing) {
    await withTenant(userId, (db) =>
      db.query(
        'UPDATE diplomat_dependencies SET current_version = $3, latest_version = $4, cves = $5, breaking_changes = $6, freshness = $7, updated_at = now() WHERE id = $1 AND owner_id = $2',
        [String(existing.id), userId, currentVersion, latestVersion, cves, breakingChanges, freshness],
      ),
    );
    const dep = await findDependencyById(userId, String(existing.id));
    await recordAudit({
      action: AuditAction.DEPENDENCY_MONITORED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'diplomat_dependencies',
      resourceId: dep.id,
      detail: { package_name: packageName, freshness, cves: cves.length, updated: true },
    });
    return dep;
  }
  const id = newId(PREFIX.DIPLOMAT_DEPENDENCY);
  await withTenant(userId, (db) =>
    db.query(
      'INSERT INTO diplomat_dependencies (id, owner_id, package_name, current_version, latest_version, cves, breaking_changes, freshness) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, userId, packageName, currentVersion, latestVersion, cves, breakingChanges, freshness],
    ),
  );
  await recordAudit({
    action: AuditAction.DEPENDENCY_MONITORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'diplomat_dependencies',
    resourceId: id,
    detail: { package_name: packageName, freshness, cves: cves.length, updated: false },
  });
  return findDependencyById(userId, id);
}

export async function findDependencyById(userId: string, id: string): Promise<DependencyRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db
      .query<Record<string, unknown>>('SELECT * FROM diplomat_dependencies WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('dependency_not_found', 'no monitored dependency found for that id');
  return depRowOf(row);
}

export async function runUpgrade(
  userId: string,
  input: { packageName?: string; toVersion?: string; testOutcome?: string; breakage?: string | null },
): Promise<{ upgrade: UpgradeRow; dependency: DependencyRow }> {
  const packageName = (input.packageName ?? '').trim();
  if (!packageName) throw AppError.badRequest('missing_package', 'a package name is required');
  const outcome: UpgradeOutcome = input.testOutcome === 'FAIL' ? 'FAIL' : input.testOutcome === 'PASS' ? 'PASS' : (() => { throw AppError.badRequest('invalid_outcome', 'testOutcome must be PASS or FAIL'); })();
  const dep = (await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db
      .query<Record<string, unknown>>('SELECT * FROM diplomat_dependencies WHERE owner_id = $1 AND package_name = $2', [userId, packageName])
      .then((r) => r.rows[0] ?? null),
  ));
  if (!dep) throw AppError.notFound('dependency_not_monitored', 'monitor the dependency before upgrading it');
  const fromVersion = String(dep.current_version);
  const toVersion = (input.toVersion ?? String(dep.latest_version)).trim();
  if (!toVersion) throw AppError.badRequest('missing_version', 'an upgrade target version is required');
  const upgradeId = newId(PREFIX.DIPLOMAT_UPGRADE);

  if (outcome === 'FAIL') {
    await withTenant(userId, (db) =>
      db.query(
        'INSERT INTO diplomat_upgrades (id, owner_id, dependency_id, from_version, to_version, cve_count, test_outcome, status, breakage_report) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [upgradeId, userId, String(dep.id), fromVersion, toVersion, asStringArray(dep.cves).length, 'FAIL', 'ROLLED_BACK', input.breakage ?? null],
      ),
    );
    await recordAudit({
      action: AuditAction.DEP_UPGRADE_ROLLED_BACK,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'diplomat_upgrades',
      resourceId: upgradeId,
      detail: { package_name: packageName, from_version: fromVersion, to_version: toVersion, breakage: input.breakage ?? null },
    });
    const upgrade = await findUpgradeById(userId, upgradeId);
    return { upgrade, dependency: depRowOf(dep) };
  }

  const nextLatest = versionCompare(toVersion, String(dep.latest_version)) > 0 ? toVersion : String(dep.latest_version);
  const patchedCveCount = asStringArray(dep.cves).length;
  await withTenant(userId, (db) =>
    db.query(
      'UPDATE diplomat_dependencies SET current_version = $3, latest_version = $4, cves = $5, breaking_changes = $6, freshness = $7, updated_at = now() WHERE id = $1 AND owner_id = $2',
      [String(dep.id), userId, toVersion, nextLatest, [], null, freshnessOf(toVersion, nextLatest)],
    ),
  );
  await withTenant(userId, (db) =>
    db.query(
      'INSERT INTO diplomat_upgrades (id, owner_id, dependency_id, from_version, to_version, cve_count, test_outcome, status, breakage_report) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [upgradeId, userId, String(dep.id), fromVersion, toVersion, patchedCveCount, 'PASS', 'SURFACED', null],
    ),
  );
  await recordAudit({
    action: AuditAction.DEP_UPGRADE_SURFACED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'diplomat_upgrades',
    resourceId: upgradeId,
    detail: { package_name: packageName, from_version: fromVersion, to_version: toVersion, cves_patched: patchedCveCount },
  });
  const upgrade = await findUpgradeById(userId, upgradeId);
  return { upgrade, dependency: await findDependencyById(userId, String(dep.id)) };
}

export async function findUpgradeById(userId: string, id: string): Promise<UpgradeRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db
      .query<Record<string, unknown>>('SELECT * FROM diplomat_upgrades WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('upgrade_not_found', 'no upgrade attempt found for that id');
  return upgradeRowOf(row);
}

export async function listDependencies(userId: string, filter: { freshness?: string } = {}): Promise<DependencyRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (db) =>
    db.query<Record<string, unknown>>('SELECT * FROM diplomat_dependencies WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(depRowOf);
  if (filter.freshness) rows = rows.filter((d) => d.freshness === filter.freshness);
  return rows.sort((a, b) => a.package_name.localeCompare(b.package_name));
}

export async function listUpgrades(userId: string, filter: { status?: string } = {}): Promise<UpgradeRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (db) =>
    db.query<Record<string, unknown>>('SELECT * FROM diplomat_upgrades WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(upgradeRowOf);
  if (filter.status) rows = rows.filter((u) => u.status === filter.status);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function dependencyHealth(userId: string): Promise<{
  dependencies: number;
  current: number;
  outdated: number;
  ahead: number;
  open_cves: number;
  upgrades: number;
  rolled_back: number;
}> {
  const [deps, upgrades] = await withTenant<[Array<Record<string, unknown>>, Array<Record<string, unknown>>]>(userId, (db) =>
    Promise.all([
      db.query<Record<string, unknown>>('SELECT * FROM diplomat_dependencies WHERE owner_id = $1', [userId]).then((r) => r.rows),
      db.query<Record<string, unknown>>('SELECT * FROM diplomat_upgrades WHERE owner_id = $1', [userId]).then((r) => r.rows),
    ]),
  );
  const depRows = deps.map(depRowOf);
  const upgradeRows = upgrades.map(upgradeRowOf);
  return {
    dependencies: depRows.length,
    current: depRows.filter((d) => d.freshness === 'CURRENT').length,
    outdated: depRows.filter((d) => d.freshness === 'OUTDATED').length,
    ahead: depRows.filter((d) => d.freshness === 'AHEAD').length,
    open_cves: depRows.reduce((acc, d) => acc + d.cves.length, 0),
    upgrades: upgradeRows.length,
    rolled_back: upgradeRows.filter((u) => u.status === 'ROLLED_BACK').length,
  };
}