/**
 * CodeConClave — Superpowers: CROSS-TEAM CONTRACT MESH (#138).
 *
 * Enforces API contracts and shared-library versions across teams automatically.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CrossTeamContractRow {
  id: string;
  owner_id: string;
  team_a: string;
  team_b: string;
  api_contract: string;
  shared_library: string;
  version: string;
  status: string;
  breach_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): CrossTeamContractRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  team_a: String(r.team_a),
  team_b: String(r.team_b),
  api_contract: String(r.api_contract),
  shared_library: String(r.shared_library),
  version: String(r.version),
  status: String(r.status),
  breach_reason: r.breach_reason == null ? null : String(r.breach_reason),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createContract(userId: string, input: { team_a: string; team_b: string; api_contract: string; shared_library: string; version: string }): Promise<CrossTeamContractRow> {
  if (!input.team_a || typeof input.team_a !== 'string') throw AppError.badRequest('team_a_required', 'team A name is required');
  if (!input.team_b || typeof input.team_b !== 'string') throw AppError.badRequest('team_b_required', 'team B name is required');
  if (!input.api_contract || typeof input.api_contract !== 'string') throw AppError.badRequest('api_contract_required', 'API contract is required');
  if (!input.shared_library || typeof input.shared_library !== 'string') throw AppError.badRequest('shared_library_required', 'shared library name is required');
  if (!input.version || typeof input.version !== 'string') throw AppError.badRequest('version_required', 'version is required');
  const id = newId(PREFIX.CROSS_TEAM_CONTRACT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO cross_team_contracts (id, owner_id, team_a, team_b, api_contract, shared_library, version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.team_a, input.team_b, input.api_contract, input.shared_library, input.version, 'ACTIVE'],
  ));
  await recordAudit({
    action: AuditAction.CONTRACT_BREACH_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cross_team_contracts',
    resourceId: id,
    detail: { team_a: input.team_a, team_b: input.team_b },
  });
  return getContract(userId, id);
}

export async function flagBreach(userId: string, id: string, input: { breach_reason: string }): Promise<CrossTeamContractRow> {
  if (!input.breach_reason || typeof input.breach_reason !== 'string') throw AppError.badRequest('breach_reason_required', 'breach reason is required');
  const contract = await getContract(userId, id);
  if (contract.status === 'BREACH_FLAGGED') throw AppError.badRequest('already_flagged', 'breach already flagged for this contract');
  await withTenant(userId, (q) => q.query(
    'UPDATE cross_team_contracts SET breach_reason = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4',
    [id, input.breach_reason, 'BREACH_FLAGGED', userId],
  ));
  await recordAudit({
    action: AuditAction.CONTRACT_BREACH_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cross_team_contracts',
    resourceId: id,
    detail: { breach_reason: input.breach_reason },
  });
  return getContract(userId, id);
}

export async function getContract(userId: string, id: string): Promise<CrossTeamContractRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM cross_team_contracts WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('cross_team_contract_not_found', 'no cross-team contract found for that id');
  return rowOf(row);
}

export async function listContracts(userId: string): Promise<CrossTeamContractRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM cross_team_contracts WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function crossTeamContractReport(userId: string): Promise<{ contracts: number; active: number; breach_flagged: number }> {
  const contracts = await listContracts(userId);
  return {
    contracts: contracts.length,
    active: contracts.filter((c) => c.status === 'ACTIVE').length,
    breach_flagged: contracts.filter((c) => c.status === 'BREACH_FLAGGED').length,
  };
}
