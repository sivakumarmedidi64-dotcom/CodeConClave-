/**
 * CodeConClave — Superpowers: POLICY COPILOT (Master Feature #81).
 *
 * Non-technical founders write engineering policies in plain English; the
 * system compiles them into enforced agent permissions. Policy becomes code,
 * not a poster on the wall.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PolicyCopilotRow {
  id: string;
  owner_id: string;
  policy: string;
  constraints: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PolicyCopilotRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  policy: String(r.policy),
  constraints: (r.constraints ?? []) as string[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** Plain English → enforceable constraints. */
export function compilePolicy(policy: string): string[] {
  const constraints: string[] = [];
  const l = policy.toLowerCase();
  if (/(data|pii|records|logs).*(leaves?|exit|outside|out of).*(eu|europe)/.test(l) || /no data leaves the eu/.test(l)) {
    constraints.push('egress_blocked: eu_region');
  }
  if (/(no |never ).*(ssh|shell|exec|execution)/.test(l)) constraints.push('no_shell_access');
  if (/production.*(must not|cannot|never) (deploy|change|modify|touch)/.test(l)) constraints.push('deploy_guard: production');
  if (/(staging|test).*(must|cannot) (touch|change|write)/.test(l)) constraints.push('write_protected: staging');
  if (/(deploy|rollout|release).*(canary|incremental|rolling|percent|10%)/.test(l)) constraints.push('release_cadence: progressive_rollout');
  constraints.push('permission_set: least_privilege');
  return constraints;
}

export async function writePolicy(userId: string, input: { policy: string }): Promise<PolicyCopilotRow> {
  if (!input.policy || typeof input.policy !== 'string') throw AppError.badRequest('invalid_policy', 'write the policy in plain English');
  const constraints = compilePolicy(input.policy);
  const id = newId(PREFIX.POLICY);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO policy_copilots (id, owner_id, policy, constraints, status) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, input.policy, constraints, 'PENDING'],
  ));
  await recordAudit({
    action: AuditAction.POLICY_WRITTEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'policy_copilots',
    resourceId: id,
    detail: { policy: input.policy, constraints: constraints.length },
  });
  return getPolicy(userId, id);
}

export async function activatePolicy(userId: string, id: string): Promise<PolicyCopilotRow> {
  const policy = await getPolicy(userId, id);
  if (policy.status === 'ACTIVE') throw AppError.badRequest('policy_already_active', 'that policy is already enforced');
  await withTenant(userId, (q) => q.query('UPDATE policy_copilots SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'ACTIVE', userId]));
  await recordAudit({
    action: AuditAction.POLICY_ACTIVATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'policy_copilots',
    resourceId: id,
    detail: { constraints: policy.constraints.length },
  });
  return getPolicy(userId, id);
}

export async function suspendPolicy(userId: string, id: string): Promise<PolicyCopilotRow> {
  const policy = await getPolicy(userId, id);
  if (policy.status !== 'ACTIVE') throw AppError.badRequest('policy_not_active', 'only an enforced policy can be suspended');
  await withTenant(userId, (q) => q.query('UPDATE policy_copilots SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'SUSPENDED', userId]));
  await recordAudit({
    action: AuditAction.POLICY_SUSPENDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'policy_copilots',
    resourceId: id,
    detail: { policy: policy.policy },
  });
  return getPolicy(userId, id);
}

export async function getPolicy(userId: string, id: string): Promise<PolicyCopilotRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM policy_copilots WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('policy_copilot_not_found', 'no policy copilot found for that id');
  return rowOf(row);
}

export async function listPolicies(userId: string): Promise<PolicyCopilotRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM policy_copilots WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function policyCopilotReport(userId: string): Promise<{ policies: number; active: number; suspended: number; constraints: number }> {
  const policies = await listPolicies(userId);
  return {
    policies: policies.length,
    active: policies.filter((p) => p.status === 'ACTIVE').length,
    suspended: policies.filter((p) => p.status === 'SUSPENDED').length,
    constraints: policies.reduce((s, p) => s + p.constraints.length, 0),
  };
}