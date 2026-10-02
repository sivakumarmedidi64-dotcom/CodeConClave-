/**
 * CodeConClave — Superpowers: FRAMEWORK BRIDGE (Master Feature #99).
 *
 * Incremental framework migration while keeping the app shippable
 * (e.g., AngularJS → React). Each step is verified before the next.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface BridgeStep {
  text: string;
  status: string;
}

export interface FrameworkBridgeRow {
  id: string;
  owner_id: string;
  source_framework: string;
  target_framework: string;
  steps: BridgeStep[];
  steps_applied: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): FrameworkBridgeRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_framework: String(r.source_framework),
  target_framework: String(r.target_framework),
  steps: (r.steps ?? []) as BridgeStep[],
  steps_applied: Number(r.steps_applied),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function planBridge(userId: string, input: { source_framework: string; target_framework: string; steps: string[] }): Promise<FrameworkBridgeRow> {
  if (!input.source_framework || typeof input.source_framework !== 'string') {
    throw AppError.badRequest('invalid_source_framework', 'a source framework is required');
  }
  if (!input.target_framework || typeof input.target_framework !== 'string') {
    throw AppError.badRequest('invalid_target_framework', 'a target framework is required');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0 || !input.steps.every((s) => typeof s === 'string' && s.length > 0)) {
    throw AppError.badRequest('invalid_steps', 'at least one migration step is required');
  }
  const steps: BridgeStep[] = input.steps.map((text) => ({ text, status: 'PENDING' }));
  const id = newId(PREFIX.FRAMEWORK_BRIDGE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO framework_bridges (id, owner_id, source_framework, target_framework, steps, steps_applied, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.source_framework, input.target_framework, steps, 0, 'PLANNED'],
  ));
  await recordAudit({
    action: AuditAction.BRIDGE_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'framework_bridges',
    resourceId: id,
    detail: { source: input.source_framework, target: input.target_framework, steps: steps.length },
  });
  return getFrameworkBridge(userId, id);
}

export async function applyStep(userId: string, id: string): Promise<FrameworkBridgeRow> {
  const bridge = await getFrameworkBridge(userId, id);
  if (bridge.status === 'VERIFIED') throw AppError.badRequest('bridge_verified', 'this bridge migration is already verified');
  if (bridge.steps_applied >= bridge.steps.length) throw AppError.badRequest('all_steps_applied', 'all steps have already been applied');
  const steps = bridge.steps.map((s) => ({ ...s }));
  steps[bridge.steps_applied]!.status = 'APPLIED';
  const steps_applied = bridge.steps_applied + 1;
  const allDone = steps_applied >= steps.length;
  const status = allDone ? 'READY' : 'APPLYING';
  await withTenant(userId, (q) => q.query(
    'UPDATE framework_bridges SET steps = $2, steps_applied = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, steps, steps_applied, status, userId],
  ));
  await recordAudit({
    action: AuditAction.BRIDGE_STEP_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'framework_bridges',
    resourceId: id,
    detail: { step: steps[bridge.steps_applied]!.text, steps_applied },
  });
  return getFrameworkBridge(userId, id);
}

export async function verifyBridge(userId: string, id: string): Promise<FrameworkBridgeRow> {
  const bridge = await getFrameworkBridge(userId, id);
  if (bridge.status === 'VERIFIED') throw AppError.badRequest('already_verified', 'this bridge is already verified');
  if (bridge.steps_applied < bridge.steps.length) {
    throw AppError.badRequest('steps_pending', `${bridge.steps.length - bridge.steps_applied} steps still pending`);
  }
  await withTenant(userId, (q) => q.query(
    'UPDATE framework_bridges SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'VERIFIED', userId],
  ));
  await recordAudit({
    action: AuditAction.BRIDGE_VERIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'framework_bridges',
    resourceId: id,
    detail: { source: bridge.source_framework, target: bridge.target_framework },
  });
  return getFrameworkBridge(userId, id);
}

export async function getFrameworkBridge(userId: string, id: string): Promise<FrameworkBridgeRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM framework_bridges WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('framework_bridge_not_found', 'no framework bridge found for that id');
  return rowOf(row);
}

export async function listFrameworkBridges(userId: string): Promise<FrameworkBridgeRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM framework_bridges WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function frameworkBridgeReport(userId: string): Promise<{ bridges: number; planned: number; verified: number }> {
  const list = await listFrameworkBridges(userId);
  return {
    bridges: list.length,
    planned: list.filter((b) => b.status === 'PLANNED' || b.status === 'APPLYING' || b.status === 'READY').length,
    verified: list.filter((b) => b.status === 'VERIFIED').length,
  };
}
