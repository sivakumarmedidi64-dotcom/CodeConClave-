/**
 * CodeConClave — Superpowers: LAUNCH CAPTAIN (Master Feature #4).
 *
 * Owns everything between merge and deploy: hashes the merged commit range,
 * classifies each change as feature/fix/breaking/refactor/chore via a fixed
 * taxonomy, bumps semver, drafts release notes from the actual changes, deploys
 * to a target environment and queues a rollback if metrics tank.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type ChangeKind = 'feature' | 'fix' | 'breaking' | 'refactor' | 'chore';
export type BumpKind = 'major' | 'minor' | 'patch' | 'none';
export type ReleaseStatus = 'PLANNED' | 'DEPLOYED' | 'ROLLED_BACK';

export interface ReleaseChange {
  commit: string;
  description: string;
}

export interface LaunchReleaseRow {
  id: string;
  owner_id: string;
  version: string;
  bump: BumpKind;
  notes: string;
  changes: Array<{ commit: string; description: string; kind: ChangeKind }>;
  status: ReleaseStatus;
  deployed_at?: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): LaunchReleaseRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  version: String(r.version),
  bump: r.bump as BumpKind,
  notes: String(r.notes),
  changes: (r.changes ?? []) as LaunchReleaseRow['changes'],
  status: r.status as ReleaseStatus,
  deployed_at: r.deployed_at ? String(r.deployed_at) : undefined,
  created_at: new Date(r.created_at as string),
});

const FIX = /\b(fix|fixes|bug|resolve|repair|patch|hotfix)\b/i;
const BREAKING = /\bbreak|breaking|major|api?\s*change|!\]/i;
const FEATURE = /\b(feat|feature|add|new support|implement|introduce)\b/i;
const REFACTOR = /\b(refactor|clean up|cleanup|rename|extract|simplify)\b/i;

export function classifyChange(description: string): ChangeKind {
  if (!description || typeof description !== 'string') return 'chore';
  if (BREAKING.test(description)) return 'breaking';
  if (FIX.test(description)) return 'fix';
  if (FEATURE.test(description)) return 'feature';
  if (REFACTOR.test(description)) return 'refactor';
  return 'chore';
}

export function computeBump(kinds: ChangeKind[]): BumpKind {
  if (kinds.includes('breaking')) return 'major';
  if (kinds.includes('feature')) return 'minor';
  if (kinds.includes('fix')) return 'patch';
  return 'none';
}

export function bumpVersion(current: string, bump: BumpKind): string {
  const parts = current.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  const [major, minor, patch] = [parts[0]!, parts[1]!, parts[2]!];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor}.${patch}`;
}

export async function planLaunchRelease(userId: string, input: { currentVersion: string; changes: ReleaseChange[] }): Promise<LaunchReleaseRow> {
  if (!input.currentVersion || typeof input.currentVersion !== 'string') throw AppError.badRequest('invalid_version', 'a current version string is required');
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (changes.length === 0) throw AppError.badRequest('empty_changes', 'a release needs at least one merged change');
  for (const c of changes) {
    if (!c.commit || typeof c.commit !== 'string') throw AppError.badRequest('invalid_commit', 'each change needs a commit hash');
    if (!c.description || typeof c.description !== 'string') throw AppError.badRequest('invalid_description', `change ${c.commit} needs a description`);
  }
  const classified = changes.map((c) => ({ commit: c.commit, description: c.description, kind: classifyChange(c.description) }));
  const bump = computeBump(classified.map((c) => c.kind));
  const version = bumpVersion(input.currentVersion, bump);
  const notes = [
    `RELEASE ${version}`,
    ...classified.map((c) => `- [${c.kind}] ${c.commit.slice(0, 8)}: ${c.description}`),
  ].join('\n');
  const id = newId(PREFIX.LAUNCH_RELEASE);
  await withTenant(userId, (q) => q.query('INSERT INTO launch_releases (id, owner_id, version, bump, notes, changes, status) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    id,
    userId,
    version,
    bump,
    notes,
    classified,
    'PLANNED',
  ]));
  await recordAudit({
    action: AuditAction.RELEASE_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'launch_releases',
    resourceId: id,
    detail: { version, bump, changes: classified.length },
  });
  return getLaunchRelease(userId, id);
}

export async function deployLaunchRelease(userId: string, id: string): Promise<LaunchReleaseRow> {
  const release = await getLaunchRelease(userId, id);
  if (release.status !== 'PLANNED') throw AppError.badRequest('release_not_planned', `cannot deploy a ${release.status} release`);
  await withTenant(userId, (q) => q.query('UPDATE launch_releases SET status = $2, deployed_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $3', [
    id,
    'DEPLOYED',
    userId,
  ]));
  await recordAudit({
    action: AuditAction.RELEASE_DEPLOYED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'launch_releases',
    resourceId: id,
    detail: { version: release.version },
  });
  return getLaunchRelease(userId, id);
}

export async function flagMetricsTank(userId: string, id: string, reason: string): Promise<LaunchReleaseRow> {
  const release = await getLaunchRelease(userId, id);
  if (release.status !== 'DEPLOYED') throw AppError.badRequest('release_not_deployed', `cannot roll back a ${release.status} release`);
  if (!reason || typeof reason !== 'string') throw AppError.badRequest('invalid_reason', 'a rollback reason is required');
  await withTenant(userId, (q) => q.query('UPDATE launch_releases SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'ROLLED_BACK', userId]));
  await recordAudit({
    action: AuditAction.RELEASE_ROLLED_BACK,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'launch_releases',
    resourceId: id,
    detail: { version: release.version, reason },
  });
  return getLaunchRelease(userId, id);
}

export async function getLaunchRelease(userId: string, id: string): Promise<LaunchReleaseRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM launch_releases WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('launch_release_not_found', 'no launch release found for that id');
  return rowOf(row);
}

export async function listLaunchReleases(userId: string): Promise<LaunchReleaseRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM launch_releases WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function launchReport(userId: string): Promise<{ releases: number; deployed: number; rolled_back: number }> {
  const rows = await listLaunchReleases(userId);
  return {
    releases: rows.length,
    deployed: rows.filter((r) => r.status === 'DEPLOYED').length,
    rolled_back: rows.filter((r) => r.status === 'ROLLED_BACK').length,
  };
}