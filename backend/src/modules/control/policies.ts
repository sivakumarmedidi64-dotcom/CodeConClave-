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
  /** Set when the row is an organization (team) policy. */
  team_id?: string;
}

export interface TeamPolicyRow {
  id: string;
  team_id: string;
  scope: string;
  action: string;
  risk_level: string;
  requirement: string;
  enabled: boolean;
  created_by: string;
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
 * treated as "no policies" (default allowed). When the work happens in a
 * team's context (e.g. a task in a team project), that team's organization
 * policies apply too; the strictest matching policy wins either way. */
export async function evaluatePolicy(
  userId: string,
  scope: string,
  action: string,
  riskLevel: string,
  context: { teamId?: string | null } = {},
): Promise<PolicyDecision> {
  const rows = await withTenant<ControlPolicyRow[]>(userId, async (q) => {
    const personal = (
      await q.query<ControlPolicyRow>(
        'SELECT * FROM control_policies WHERE owner_id = $1 AND scope = $2 AND (action = $3 OR action = $4)',
        [userId, scope, action, '*'],
      )
    ).rows;
    if (!context.teamId) return personal;
    const team = (
      await q.query<ControlPolicyRow>(
        `SELECT id, team_id AS owner_id, team_id, scope, action, risk_level, requirement, enabled, NULL::jsonb AS config,
                created_at, updated_at
           FROM team_control_policies WHERE team_id = $1 AND scope = $2 AND (action = $3 OR action = $4)`,
        [context.teamId, scope, action, '*'],
      )
    ).rows;
    return [...personal, ...team];
  });
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
// ---------------------------------------------------------------------------
// Organization (team) policies — spec Team #14. Members may read; only team
// owners/admins may change them. Every change is audited at TEAM scope.
// ---------------------------------------------------------------------------

function validatePolicyInput(input: UpsertPolicyInput): { action: string; requirement: ControlPolicyRequirement } {
  if (!POLICY_SCOPES.includes(input.scope as PolicyScope)) {
    throw AppError.badRequest('invalid_policy_scope', `Unknown policy scope ${input.scope}`);
  }
  if (!input.action?.trim()) throw AppError.badRequest('invalid_policy_action', 'Policy action is required');
  if (!(input.riskLevel in RiskLevel)) throw AppError.badRequest('invalid_policy_risk', `Unknown risk level ${input.riskLevel}`);
  const requirement = (input.requirement ?? ControlPolicyRequirement.REQUIRE_APPROVAL) as ControlPolicyRequirement;
  if (![ControlPolicyRequirement.REQUIRE_APPROVAL, ControlPolicyRequirement.BLOCK].includes(requirement)) {
    throw AppError.badRequest('invalid_policy_requirement', `Unknown requirement ${requirement}`);
  }
  return { action: input.action.trim().slice(0, 80), requirement };
}

async function requireTeamAdmin(userId: string, teamId: string): Promise<void> {
  const { requireTeamRole } = await import('../teams/service.js');
  const { TeamRole } = await import('@codeconclave/shared');
  await requireTeamRole(userId, teamId, [TeamRole.OWNER, TeamRole.ADMIN]);
}

export async function listTeamPolicies(userId: string, teamId: string): Promise<TeamPolicyRow[]> {
  const { teamRoleFor } = await import('../teams/service.js');
  if (!(await teamRoleFor(userId, teamId))) throw AppError.forbidden('insufficient_permission');
  return withTenant(userId, async (q) =>
    (
      await q.query<TeamPolicyRow>('SELECT * FROM team_control_policies WHERE team_id = $1 ORDER BY scope, action', [teamId])
    ).rows,
  );
}

export async function upsertTeamPolicy(userId: string, teamId: string, input: UpsertPolicyInput): Promise<TeamPolicyRow> {
  await requireTeamAdmin(userId, teamId);
  const { action, requirement } = validatePolicyInput(input);
  const row = await withTenant(userId, async (q) =>
    (
      await q.query<TeamPolicyRow>(
        `INSERT INTO team_control_policies (id, team_id, scope, action, risk_level, requirement, enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (team_id, scope, action)
         DO UPDATE SET risk_level = EXCLUDED.risk_level, requirement = EXCLUDED.requirement,
                       enabled = EXCLUDED.enabled, created_by = EXCLUDED.created_by
         RETURNING *`,
        [newId(PREFIX.CONTROL_POLICY), teamId, input.scope, action, input.riskLevel, requirement, input.enabled ?? true, userId],
      )
    ).rows[0]!,
  );
  await recordAudit({
    action: AuditAction.CONTROL_POLICY_UPSERTED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team_control_policy',
    resourceId: row.id,
    detail: { scope: input.scope, action, riskLevel: input.riskLevel, requirement, enabled: row.enabled },
  });
  return row;
}

export async function deleteTeamPolicy(userId: string, teamId: string, policyId: string): Promise<void> {
  await requireTeamAdmin(userId, teamId);
  const removed = await withTenant(userId, async (q) =>
    (
      await q.query<TeamPolicyRow>('DELETE FROM team_control_policies WHERE id = $1 AND team_id = $2 RETURNING *', [policyId, teamId])
    ).rows[0],
  );
  if (!removed) throw AppError.notFound('Team control policy');
  await recordAudit({
    action: AuditAction.CONTROL_POLICY_DELETED,
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'team_control_policy',
    resourceId: policyId,
    detail: { scope: removed.scope, action: removed.action },
  });
}
