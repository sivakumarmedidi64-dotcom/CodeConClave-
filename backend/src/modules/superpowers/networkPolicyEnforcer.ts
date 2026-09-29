/**
 * CodeConClave — Superpowers: NETWORK POLICY ENFORCER (Master Feature #98).
 *
 * Every network call from agents runs against a policy (allowed domains,
 * rate limits); egress allowlist + logging for full audit trail.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface NetworkPolicyRow {
  id: string;
  owner_id: string;
  agent_name: string;
  allowed_domains: string[];
  rate_limit: number;
  calls_made: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): NetworkPolicyRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  agent_name: String(r.agent_name),
  allowed_domains: (r.allowed_domains ?? []) as string[],
  rate_limit: Number(r.rate_limit),
  calls_made: Number(r.calls_made),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createNetworkPolicy(userId: string, input: { agent_name: string; allowed_domains: string[]; rate_limit: number }): Promise<NetworkPolicyRow> {
  if (!input.agent_name || typeof input.agent_name !== 'string') throw AppError.badRequest('invalid_agent_name', 'an agent name is required');
  if (!Array.isArray(input.allowed_domains) || input.allowed_domains.length === 0) {
    throw AppError.badRequest('invalid_allowed_domains', 'at least one allowed domain is required');
  }
  if (typeof input.rate_limit !== 'number' || !Number.isFinite(input.rate_limit) || input.rate_limit < 1) {
    throw AppError.badRequest('invalid_rate_limit', 'rate limit must be a positive number');
  }
  const id = newId(PREFIX.NETWORK_POLICY);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO network_policies (id, owner_id, agent_name, allowed_domains, rate_limit, calls_made, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.agent_name, input.allowed_domains, input.rate_limit, 0, 'ACTIVE'],
  ));
  await recordAudit({
    action: AuditAction.NETWORK_POLICY_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'network_policies',
    resourceId: id,
    detail: { agent_name: input.agent_name, domains: input.allowed_domains.length },
  });
  return getNetworkPolicy(userId, id);
}

export async function auditNetworkCall(userId: string, id: string, input: { domain: string }): Promise<NetworkPolicyRow> {
  if (!input.domain || typeof input.domain !== 'string') throw AppError.badRequest('invalid_domain', 'a domain is required');
  const policy = await getNetworkPolicy(userId, id);
  if (policy.status !== 'ACTIVE') throw AppError.badRequest('policy_exhausted', 'this policy has reached its rate limit');
  if (!policy.allowed_domains.includes(input.domain)) {
    throw AppError.badRequest('domain_not_allowed', `domain "${input.domain}" is not in the allowlist`);
  }
  const newCalls = policy.calls_made + 1;
  const newStatus = newCalls >= policy.rate_limit ? 'EXHAUSTED' : 'ACTIVE';
  await withTenant(userId, (q) => q.query(
    'UPDATE network_policies SET calls_made = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, newCalls, newStatus, userId],
  ));
  await recordAudit({
    action: AuditAction.NETWORK_CALL_AUDITED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'network_policies',
    resourceId: id,
    detail: { domain: input.domain, calls_made: newCalls },
  });
  return getNetworkPolicy(userId, id);
}

export async function getNetworkPolicy(userId: string, id: string): Promise<NetworkPolicyRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM network_policies WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('network_policy_not_found', 'no network policy found for that id');
  return rowOf(row);
}

export async function listNetworkPolicies(userId: string): Promise<NetworkPolicyRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM network_policies WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function networkPolicyReport(userId: string): Promise<{ policies: number; active: number; exhausted: number; total_calls: number }> {
  const list = await listNetworkPolicies(userId);
  return {
    policies: list.length,
    active: list.filter((p) => p.status === 'ACTIVE').length,
    exhausted: list.filter((p) => p.status === 'EXHAUSTED').length,
    total_calls: list.reduce((sum, p) => sum + p.calls_made, 0),
  };
}
