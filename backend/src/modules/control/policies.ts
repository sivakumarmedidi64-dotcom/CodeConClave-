/**
 * Stage 26G — risk-based control policies.
 *
 * A policy applies to a (scope, action) pair at or above a risk level and
 * imposes a requirement: `require_approval` or `block`. The table is empty by
 * default, so the built-in risk model applies (HIGH/CRITICAL task risk already
 * requires approval via the task engine). Policies only ever tighten or block;
 * they never relax the built-in defaults.
 *
 * Enforcement hook: `evaluatePolicy` is consulted by the task engine and the
 * plugin engine; missing rows (or unknown tables) return the default `allowed`
 * outcome so existing behavior is unchanged.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, RiskLevel, ControlPolicyRequirement } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';

export const POLICY_SCOPES = ['task', 'plugin', 'schedule', 'automation', 'agent', 'global'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export interface ControlPolicyRow {
  id: string;
  owner_id: string;
  scope: string;
  action: string;
  risk_level: string;
  requirement: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface PolicyDecision {
  allowed: boolean;
  requireApproval: boolean;
  matched: ControlPolicyRow | null;
}

const RISK_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** The default decision when no policy matches. */
const DEFAULT_DECISION: PolicyDecision = { allowed: true, requireApproval: false, matched: null };

export async function listControlPolicies(userId: string): Promise<ControlPolicyRow[]> {
  return withTenant<ControlPolicyRow[]>(userId, (q) =>
    q.query<ControlPolicyRow>('SELECT * FROM control_policies WHERE owner_id = $1 ORDER BY scope, action', [userId]).then((r) => r.rows),
  );
}

/** Evaluate a (scope, action) at a given risk level. Unknown tables are
 * treated as "no policies" (default allowed). */
export async function evaluatePolicy(
  userId: string,
  scope: string,
  action: string,
  riskLevel: string,
): Promise<PolicyDecision> {
  const rows = await withTenant<ControlPolicyRow[]>(userId, (q) =>
    q
      .query<ControlPolicyRow>(
        'SELECT * FROM control_policies WHERE owner_id = $1 AND scope = $2 AND (action = $3 OR action = $4)',
        [userId, scope, action, '*'],
      )
      .then((r) => r.rows),
  );
  const riskRank = RISK_RANK[riskLevel] ?? 0;
  const applicable = rows.filter((r) => r.enabled && (RISK_RANK[r.risk_level] ?? 0) <= riskRank);
  if (applicable.length === 0) return DEFAULT_DECISION;
  const strictest = applicable.reduce<ControlPolicyRow | null>((acc, r) => {
    if (!acc) return r;
    if (r.requirement === ControlPolicyRequirement.BLOCK) return r;
    if (acc.requirement === ControlPolicyRequirement.BLOCK) return acc;
    return (RISK_RANK[r.risk_level] ?? 0) >= (RISK_RANK[acc.risk_level] ?? 0) ? r : acc;
  }, null);
  if (!strictest) return DEFAULT_DECISION;
  if (strictest.requirement === ControlPolicyRequirement.BLOCK) {
    return { allowed: false, requireApproval: false, matched: strictest };
  }
  return { allowed: true, requireApproval: true, matched: strictest };
}

export interface UpsertPolicyInput {
  scope: string;
  action: string;
  riskLevel: string;
  requirement?: string;
  enabled?: boolean;
}

export async function upsertControlPolicy(
  userId: string,
  input: UpsertPolicyInput,
): Promise<ControlPolicyRow> {
  if (!POLICY_SCOPES.includes(input.scope as PolicyScope)) {
    throw AppError.badRequest('invalid_policy_scope', `Unknown policy scope ${input.scope}`);
  }
  if (!input.action?.trim()) throw AppError.badRequest('invalid_policy_action', 'Policy action is required');
  const riskLevel = input.riskLevel;
  if (!(riskLevel in RiskLevel)) throw AppError.badRequest('invalid_policy_risk', `Unknown risk level ${riskLevel}`);
  const requirement = (input.requirement ?? ControlPolicyRequirement.REQUIRE_APPROVAL) as ControlPolicyRequirement;
  if (![ControlPolicyRequirement.REQUIRE_APPROVAL, ControlPolicyRequirement.BLOCK].includes(requirement)) {
    throw AppError.badRequest('invalid_policy_requirement', `Unknown requirement ${requirement}`);
  }
  const action = input.action.trim().slice(0, 80);
  const existing = await withTenant<ControlPolicyRow[]>(userId, (q) =>
    q
      .query<ControlPolicyRow>(
        'SELECT * FROM control_policies WHERE owner_id = $1 AND scope = $2 AND action = $3',
        [userId, input.scope, action],
      )
      .then((r) => r.rows),
  );
  const id = existing[0]?.id ?? newId(PREFIX.CONTROL_POLICY);
  await dbUpsert(userId, input.scope, action, riskLevel, requirement, input.enabled ?? true, id);
  await recordAudit({
    action: AuditAction.CONTROL_POLICY_UPSERTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'control_policy',
    resourceId: id,
    detail: { scope: input.scope, action, riskLevel, requirement },
  });
  return (
    await withTenant<ControlPolicyRow[]>(userId, (q) =>
      q
        .query<ControlPolicyRow>(
          'SELECT * FROM control_policies WHERE owner_id = $1 AND scope = $2 AND action = $3',
          [userId, input.scope, action],
        )
        .then((r) => r.rows),
    )
  )[0]!;
}

export async function deleteControlPolicy(userId: string, policyId: string): Promise<void> {
  const rows = await withTenant<ControlPolicyRow[]>(userId, (q) =>
    q.query<ControlPolicyRow>('SELECT * FROM control_policies WHERE id = $1 AND owner_id = $2', [policyId, userId]).then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Control policy');
  await withTenant(userId, (q) => q.query('DELETE FROM control_policies WHERE id = $1 AND owner_id = $2', [policyId, userId]));
  await recordAudit({
    action: AuditAction.CONTROL_POLICY_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'control_policy',
    resourceId: policyId,
    detail: { scope: rows[0].scope, action: rows[0].action },
  });
}

async function dbUpsert(
  userId: string,
  scope: string,
  action: string,
  riskLevel: string,
  requirement: string,
  enabled: boolean,
  id: string,
): Promise<void> {
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO control_policies (id, owner_id, scope, action, risk_level, requirement, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner_id, scope, action)
       DO UPDATE SET risk_level = EXCLUDED.risk_level, requirement = EXCLUDED.requirement,
                     enabled = EXCLUDED.enabled, updated_at = now()`,
      [id, userId, scope, action, riskLevel, requirement, enabled],
    ),
  );
}