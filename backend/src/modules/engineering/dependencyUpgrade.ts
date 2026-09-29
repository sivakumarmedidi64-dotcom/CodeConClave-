/**
 * Stage 26F — Dependency Upgrade Agent.
 *
 * One dependency at a time. Explicit, ordered state machine:
 *   INSPECTING → MODIFYING → INSTALLING → TESTING → BUILDING → ANALYZING
 *                 → ACCEPTED | ROLLED_BACK | FAILED
 *
 * Honesty rules:
 *   - A new upgrade is refused while another upgrade for the same project is
 *     still in flight (one dependency at a time).
 *   - Each step's real output is persisted by the caller feeding results back
 *     (`stepUpgrade`); the module never fabricates install/test/build results.
 *   - Rollback is a first-class recorded action with a reason; an accepted
 *     upgrade is never silently undone.
 *   - HIGH-risk upgrades are gated by the existing task approval machinery
 *     (createTask risk HIGH ⇒ required_approval) and notify the owner.
 *
 * Reuses the existing task engine (createTask), audit, notifications.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { createTask } from '../execution/tasks.js';

export const UPGRADE_STEPS = ['INSPECTING', 'MODIFYING', 'INSTALLING', 'TESTING', 'BUILDING', 'ANALYZING'] as const;
export type UpgradeStep = (typeof UPGRADE_STEPS)[number];
export type UpgradeStatus = UpgradeStep | 'ACCEPTED' | 'ROLLED_BACK' | 'FAILED';

export interface DependencyUpgradeRow {
  id: string;
  owner_id: string;
  project_id: string;
  package_name: string;
  from_version: string;
  to_version: string;
  manifest_path: string;
  status: UpgradeStatus;
  diff: Record<string, unknown> | null;
  install_output: string | null;
  test_summary: string | null;
  build_summary: string | null;
  analysis: Record<string, unknown> | null;
  task_id: string | null;
  approval_id: string | null;
  rollback_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StartUpgradeInput {
  projectId: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  manifestPath: string;
}

export interface StepUpgradeInput {
  step: Exclude<UpgradeStep, 'INSPECTING'>;
  ok: boolean;
  output?: string;
  diff?: Record<string, unknown>;
}

const NEXT_STEP: Record<UpgradeStep, Exclude<UpgradeStep, 'INSPECTING'> | null> = {
  INSPECTING: 'MODIFYING',
  MODIFYING: 'INSTALLING',
  INSTALLING: 'TESTING',
  TESTING: 'BUILDING',
  BUILDING: 'ANALYZING',
  ANALYZING: null,
};

const IN_FLIGHT: UpgradeStatus[] = ['INSPECTING', 'MODIFYING', 'INSTALLING', 'TESTING', 'BUILDING', 'ANALYZING'];

export async function getUpgrade(userId: string, upgradeId: string): Promise<DependencyUpgradeRow> {
  const rows = await withTenant<DependencyUpgradeRow[]>(userId, async (q) =>
    (await q.query<DependencyUpgradeRow>(
      'SELECT * FROM dependency_upgrades WHERE id = $1 AND owner_id = $2',
      [upgradeId, userId],
    )).rows,
  );
  if (!rows[0]) throw AppError.notFound('Upgrade');
  return rows[0];
}

export async function listUpgrades(userId: string, projectId?: string): Promise<DependencyUpgradeRow[]> {
  const where = projectId ? 'owner_id = $1 AND project_id = $2' : 'owner_id = $1';
  const params = projectId ? [userId, projectId] : [userId];
  return withTenant<DependencyUpgradeRow[]>(userId, async (q) =>
    (await q.query<DependencyUpgradeRow>(
      `SELECT * FROM dependency_upgrades WHERE ${where} ORDER BY created_at DESC`,
      params,
    )).rows,
  );
}

/** Start an upgrade: refused while another upgrade is in flight for the project. */
export async function startUpgrade(userId: string, input: StartUpgradeInput): Promise<DependencyUpgradeRow> {
  if (!input.projectId || !input.packageName || !input.fromVersion || !input.toVersion || !input.manifestPath) {
    throw AppError.badRequest('upgrade_invalid_input', 'projectId, packageName, fromVersion, toVersion and manifestPath are required');
  }
  const inFlight = await withTenant<DependencyUpgradeRow[]>(userId, async (q) =>
    (await q.query<DependencyUpgradeRow>(
      `SELECT * FROM dependency_upgrades WHERE owner_id = $1 AND project_id = $2 AND status = ANY($3::text[])`,
      [userId, input.projectId, IN_FLIGHT],
    )).rows,
  );
  if (inFlight.length > 0 && inFlight[0]) {
    throw AppError.conflict('upgrade_in_flight', `Another upgrade (${inFlight[0].package_name}) is still in flight`);
  }
  const id = newId(PREFIX.DEP_UPGRADE);
  const task = await createTask({
    userId,
    projectId: input.projectId,
    title: `Upgrade ${input.packageName} ${input.fromVersion} → ${input.toVersion}`,
    description: `One-dependency upgrade of ${input.packageName} in ${input.manifestPath}.`,
    riskLevel: 'HIGH',
  });
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO dependency_upgrades
         (id, owner_id, project_id, package_name, from_version, to_version, manifest_path, status, task_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'INSPECTING',$8)`,
      [id, userId, input.projectId, input.packageName, input.fromVersion, input.toVersion, input.manifestPath, task.id],
    ),
  );
  await recordAudit({
    action: AuditAction.UPGRADE_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_upgrade',
    resourceId: id,
    detail: {
      packageName: input.packageName,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      manifestPath: input.manifestPath,
      taskId: task.id,
    },
  });
  if (task.required_approval) {
    await notify(
      userId,
      NotificationType.UPGRADE_APPROVAL_REQUIRED,
      'Upgrade requires approval',
      {
        body: `Upgrade ${input.packageName} ${input.fromVersion} → ${input.toVersion} is pending approval`,
        resourceType: 'dependency_upgrade',
        resourceId: id,
        metadata: { packageName: input.packageName, taskId: task.id },
      },
    );
  }
  return getUpgrade(userId, id);
}

/** Advance the upgrade by feeding back a REAL step result. */
export async function stepUpgrade(userId: string, upgradeId: string, input: StepUpgradeInput): Promise<DependencyUpgradeRow> {
  const upgrade = await getUpgrade(userId, upgradeId);
  const expected = NEXT_STEP[upgrade.status as UpgradeStep];
  if (!expected || expected !== input.step) {
    throw AppError.conflict('invalid_upgrade_step', `Expected step ${expected ?? 'a terminal state'}, got ${input.step}`);
  }
  if (!input.ok) {
    await failUpgrade(userId, upgradeId, `${input.step} failed: ${input.output ?? 'no output'}`);
    return getUpgrade(userId, upgradeId);
  }
  const column = {
    MODIFYING: 'diff',
    INSTALLING: 'install_output',
    TESTING: 'test_summary',
    BUILDING: 'build_summary',
    ANALYZING: 'analysis',
  }[input.step];
  const value = input.step === 'MODIFYING' || input.step === 'ANALYZING'
    ? JSON.stringify(input.diff ?? (input.step === 'ANALYZING' ? { summary: input.output ?? null } : {}))
    : input.output ?? '';
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE dependency_upgrades SET status = $1, ${column} = $2, updated_at = now() WHERE id = $3 AND owner_id = $4`,
      [input.step, value, upgradeId, userId],
    ),
  );
  await recordAudit({
    action: AuditAction.UPGRADE_STEP,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_upgrade',
    resourceId: upgradeId,
    detail: { step: input.step, ok: true, packageName: upgrade.package_name },
  });
  return getUpgrade(userId, upgradeId);
}

/** Accept an analyzed upgrade (only from ANALYZING). */
export async function acceptUpgrade(userId: string, upgradeId: string): Promise<DependencyUpgradeRow> {
  const upgrade = await getUpgrade(userId, upgradeId);
  if (upgrade.status !== 'ANALYZING') {
    throw AppError.conflict('upgrade_not_analyzable', `Upgrade is ${upgrade.status}`);
  }
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE dependency_upgrades SET status = 'ACCEPTED', updated_at = now() WHERE id = $1 AND owner_id = $2`,
      [upgradeId, userId],
    ),
  );
  await recordAudit({
    action: AuditAction.UPGRADE_ACCEPTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_upgrade',
    resourceId: upgradeId,
    detail: { packageName: upgrade.package_name, toVersion: upgrade.to_version },
  });
  return getUpgrade(userId, upgradeId);
}

/** Roll back an in-flight upgrade with an explicit reason. */
export async function rollbackUpgrade(userId: string, upgradeId: string, reason: string): Promise<DependencyUpgradeRow> {
  const upgrade = await getUpgrade(userId, upgradeId);
  if (!IN_FLIGHT.includes(upgrade.status as UpgradeStatus)) {
    throw AppError.conflict('upgrade_not_rollbackable', `Upgrade is ${upgrade.status}`);
  }
  if (!reason || !reason.trim()) {
    throw AppError.badRequest('rollback_reason_required', 'A rollback reason is required');
  }
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE dependency_upgrades SET status = 'ROLLED_BACK', rollback_reason = $1, updated_at = now() WHERE id = $2 AND owner_id = $3`,
      [reason, upgradeId, userId],
    ),
  );
  await recordAudit({
    action: AuditAction.UPGRADE_ROLLED_BACK,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_upgrade',
    resourceId: upgradeId,
    detail: { packageName: upgrade.package_name, fromVersion: upgrade.from_version, reason },
  });
  return getUpgrade(userId, upgradeId);
}

/** Fail an in-flight upgrade honestly. */
export async function failUpgrade(userId: string, upgradeId: string, reason: string): Promise<DependencyUpgradeRow> {
  const upgrade = await getUpgrade(userId, upgradeId);
  if (!IN_FLIGHT.includes(upgrade.status as UpgradeStatus)) {
    throw AppError.conflict('upgrade_not_failable', `Upgrade is ${upgrade.status}`);
  }
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE dependency_upgrades SET status = 'FAILED', updated_at = now() WHERE id = $1 AND owner_id = $2`,
      [upgradeId, userId],
    ),
  );
  await recordAudit({
    action: AuditAction.UPGRADE_FAILED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_upgrade',
    resourceId: upgradeId,
    detail: { packageName: upgrade.package_name, reason: reason.slice(0, 400) },
  });
  return getUpgrade(userId, upgradeId);
}