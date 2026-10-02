/**
 * CodeConClave — Superpowers: CONTRACT WARDEN (Master Feature #37).
 *
 * Published API contracts (OpenAPI-shaped) are verified against the real
 * implementation at proposal time. Breaking changes surface in the producer
 * repo — not in a consumer's production incident — and consumers are checked
 * for compatibility against the same contract.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface EndpointParam {
  name: string;
  required?: boolean;
  type?: string;
}

export interface Endpoint {
  method: string;
  path: string;
  status_codes?: string[];
  params?: EndpointParam[];
}

export type CheckVerdict = 'COMPLIANT' | 'NON_BREAKING_DRIFT' | 'BREAKING';

export const VERDICTS: CheckVerdict[] = ['COMPLIANT', 'NON_BREAKING_DRIFT', 'BREAKING'];

export interface ApiContractRow {
  id: string;
  owner_id: string;
  name: string;
  version: string;
  endpoints: Endpoint[];
  created_at: Date;
  updated_at: Date;
}

export interface ContractCheckRow {
  id: string;
  owner_id: string;
  contract_id: string;
  verdict: CheckVerdict;
  breaking_issues: Array<Record<string, unknown>>;
  warning_issues: Array<Record<string, unknown>>;
  created_at: Date;
}

export type ContractIssue = {
  kind: string;
  method: string;
  path: string;
  param?: string;
  expected?: string;
  actual?: string;
  status?: string;
};

const contractRowOf = (r: Record<string, unknown>): ApiContractRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  name: String(r.name),
  version: String(r.version),
  endpoints: asEndpoints(r.endpoints),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const checkRowOf = (r: Record<string, unknown>): ContractCheckRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  contract_id: String(r.contract_id),
  verdict: r.verdict as CheckVerdict,
  breaking_issues: (Array.isArray(r.breaking_issues) ? r.breaking_issues : typeof r.breaking_issues === 'string' ? safeParse(r.breaking_issues) : []) as Array<Record<string, unknown>>,
  warning_issues: (Array.isArray(r.warning_issues) ? r.warning_issues : typeof r.warning_issues === 'string' ? safeParse(r.warning_issues) : []) as Array<Record<string, unknown>>,
  created_at: new Date(r.created_at as string),
});

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
};

const asEndpoints = (v: unknown): Endpoint[] => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? (safeParse(v) as unknown[]) : [];
  return arr.map((e) => ({
    method: String((e as Record<string, unknown>).method ?? ''),
    path: String((e as Record<string, unknown>).path ?? ''),
    status_codes: asStringArray((e as Record<string, unknown>).status_codes),
    params: Array.isArray((e as Record<string, unknown>).params)
      ? ((e as Record<string, unknown>).params as unknown[]).map((p) => {
          const pr = p as Record<string, unknown>;
          return { name: String(pr.name ?? ''), required: pr.required === true, type: pr.type ? String(pr.type) : undefined };
        })
      : [],
  }));
};

const asStringArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && Array.isArray(safeParse(v))) return (safeParse(v) as unknown[]).map(String);
  return [];
};

export const endpointKey = (ep: { method?: string; path?: string }): string => {
  const method = (ep.method ?? '').toUpperCase();
  const path = (ep.path ?? '').replace(/\/+$/, '') || '/';
  return `${method} ${path}`;
};

const normalizeEndpoint = (ep: Endpoint): Endpoint => ({
  method: (ep.method ?? '').toUpperCase(),
  path: (ep.path ?? '').replace(/\/+$/, '') || '/',
  status_codes: asStringArray(ep.status_codes),
  params: (Array.isArray(ep.params) ? ep.params : []).map((p) => ({ name: String(p.name ?? ''), required: p.required === true, type: p.type ? String(p.type) : undefined })),
});

const validEndpoint = (ep: Endpoint): boolean => Boolean((ep.method ?? '').trim() && (ep.path ?? '').trim());

export async function publishContract(
  userId: string,
  input: { name?: string; version?: string; endpoints?: Endpoint[] },
): Promise<ApiContractRow> {
  const name = (input.name ?? '').trim();
  const version = (input.version ?? '').trim();
  if (!name || !version) throw AppError.badRequest('incomplete_contract', 'contract name and version are required');
  if (!Array.isArray(input.endpoints) || input.endpoints.length === 0) throw AppError.badRequest('empty_contract', 'a contract needs at least one endpoint');
  const endpoints = input.endpoints.map(normalizeEndpoint);
  for (const ep of endpoints) if (!validEndpoint(ep)) throw AppError.badRequest('invalid_endpoint', 'every endpoint needs a method and a path');
  const existing = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM api_contracts WHERE owner_id = $1 AND name = $2 AND version = $3', [userId, name, version]).then((r) => r.rows[0] ?? null),
  );
  if (existing) throw AppError.conflict('contract_exists', 'a contract with that name and version already exists');
  const id = newId(PREFIX.API_CONTRACT);
  await withTenant(userId, (q) =>
    q.query('INSERT INTO api_contracts (id, owner_id, name, version, endpoints) VALUES ($1,$2,$3,$4,$5)', [id, userId, name, version, endpoints]),
  );
  await recordAudit({
    action: AuditAction.CONTRACT_PUBLISHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'api_contracts',
    resourceId: id,
    detail: { name, version, endpoints: endpoints.length },
  });
  return findContractById(userId, id);
}

export async function findContractById(userId: string, id: string): Promise<ApiContractRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM api_contracts WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('contract_not_found', 'no api contract found for that id');
  return contractRowOf(row);
}

export async function listContracts(userId: string, filter: { name?: string } = {}): Promise<ApiContractRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM api_contracts WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(contractRowOf);
  if (filter.name) rows = rows.filter((c) => c.name === filter.name);
  return rows.sort((a, b) => a.name.localeCompare(b.name) || versionCompare(a.version, b.version));
}

export function versionCompare(a: string, b: string): number {
  const pa = String(a).split('.').map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  const pb = String(b).split('.').map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export async function verifyImplementation(
  userId: string,
  input: { contractId?: string; implementation?: Endpoint[] },
): Promise<ContractCheckRow> {
  if (!input.contractId) throw AppError.badRequest('missing_contract', 'a contract id is required');
  if (!Array.isArray(input.implementation) || input.implementation.length === 0) throw AppError.badRequest('missing_implementation', 'an implementation endpoint list is required');
  const contract = await findContractById(userId, input.contractId);
  const impl = input.implementation.map(normalizeEndpoint);
  const breakingIssues: ContractIssue[] = [];
  const warningIssues: ContractIssue[] = [];

  const contractMap = new Map(contract.endpoints.map((e) => [endpointKey(e), e]));
  const implMap = new Map(impl.map((e) => [endpointKey(e), e]));

  for (const cep of contract.endpoints) {
    const key = endpointKey(cep);
    const iep = implMap.get(key);
    if (!iep) {
      breakingIssues.push({ kind: 'missing_endpoint', method: cep.method, path: cep.path });
      continue;
    }
    const contractParams = new Map((cep.params ?? []).map((p) => [p.name, p]));
    const implParams = new Map((iep.params ?? []).map((p) => [p.name, p]));
    for (const cp of cep.params ?? []) {
      const ip = implParams.get(cp.name);
      if (!ip && cp.required) breakingIssues.push({ kind: 'missing_required_param', method: cep.method, path: cep.path, param: cp.name });
      if (ip && ip.type && cp.type && ip.type.toLowerCase() !== cp.type.toLowerCase()) breakingIssues.push({ kind: 'param_type_mismatch', method: cep.method, path: cep.path, param: cp.name, expected: cp.type, actual: ip.type });
    }
    for (const ip of iep.params ?? []) {
      if (ip.required && !(contractParams.get(ip.name)?.required)) breakingIssues.push({ kind: 'added_required_param', method: cep.method, path: cep.path, param: ip.name });
    }
    if ((cep.status_codes ?? []).length > 0) {
      const cStatuses = new Set(cep.status_codes ?? []);
      const iStatuses = new Set(iep.status_codes ?? []);
      for (const s of cep.status_codes ?? []) {
        if (!iStatuses.has(s)) warningIssues.push({ kind: 'missing_status', method: cep.method, path: cep.path, status: s });
      }
      for (const s of iep.status_codes ?? []) {
        if (!cStatuses.has(s)) warningIssues.push({ kind: 'extra_status', method: cep.method, path: cep.path, status: s });
      }
    }
  }
  for (const iep of impl) {
    if (!contractMap.has(endpointKey(iep))) warningIssues.push({ kind: 'extra_endpoint', method: iep.method, path: iep.path });
  }

  const verdict: CheckVerdict = breakingIssues.length > 0 ? 'BREAKING' : warningIssues.length > 0 ? 'NON_BREAKING_DRIFT' : 'COMPLIANT';
  const id = newId(PREFIX.CONTRACT_CHECK);
  await withTenant(userId, (q) =>
    q.query('INSERT INTO contract_checks (id, owner_id, contract_id, verdict, breaking_issues, warning_issues) VALUES ($1,$2,$3,$4,$5,$6)', [
      id,
      userId,
      contract.id,
      verdict,
      breakingIssues,
      warningIssues,
    ]),
  );
  await recordAudit({
    action: AuditAction.CONTRACT_VERIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'contract_checks',
    resourceId: id,
    detail: { contract_id: contract.id, name: contract.name, version: contract.version, verdict, breaking: breakingIssues.length, warnings: warningIssues.length },
  });
  if (verdict === 'BREAKING') {
    await recordAudit({
      action: AuditAction.CONTRACT_BREAKING,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'contract_checks',
      resourceId: id,
      detail: { contract_id: contract.id, name: contract.name, issues: breakingIssues },
    });
  }
  return findCheckById(userId, id);
}

export async function findCheckById(userId: string, id: string): Promise<ContractCheckRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM contract_checks WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('contract_check_not_found', 'no contract check found for that id');
  return checkRowOf(row);
}

export async function listChecks(userId: string, filter: { contractId?: string } = {}): Promise<ContractCheckRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM contract_checks WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(checkRowOf);
  if (filter.contractId) rows = rows.filter((c) => c.contract_id === filter.contractId);
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function checkConsumer(
  userId: string,
  input: { contractId?: string; consumer?: Endpoint[] },
): Promise<{
  verdict: 'COMPATIBLE' | 'COMPATIBLE_WITH_DRIFT' | 'INCOMPATIBLE';
  breaking_issues: ContractIssue[];
  warning_issues: ContractIssue[];
}> {
  if (!input.contractId) throw AppError.badRequest('missing_contract', 'a contract id is required');
  if (!Array.isArray(input.consumer)) throw AppError.badRequest('missing_consumer', 'a consumer endpoint list is required');
  const contract = await findContractById(userId, input.contractId);
  const contractMap = new Map(contract.endpoints.map((e) => [endpointKey(e), e]));
  const breakingIssues: ContractIssue[] = [];
  const warningIssues: ContractIssue[] = [];
  for (const raw of input.consumer) {
    const cep = normalizeEndpoint(raw);
    if (!validEndpoint(cep)) throw AppError.badRequest('invalid_consumer_endpoint', 'every consumer endpoint needs a method and a path');
    const pep = contractMap.get(endpointKey(cep));
    if (!pep) {
      breakingIssues.push({ kind: 'consumer_missing_producer_endpoint', method: cep.method, path: cep.path });
      continue;
    }
    const producerParams = new Map((pep.params ?? []).map((p) => [p.name, p]));
    for (const cp of cep.params ?? []) {
      const pp = producerParams.get(cp.name);
      if (!pp && cp.required) breakingIssues.push({ kind: 'consumer_required_param_unsupported', method: cep.method, path: cep.path, param: cp.name });
      if (pp && cp.type && pp.type && cp.type.toLowerCase() !== pp.type.toLowerCase()) breakingIssues.push({ kind: 'consumer_param_type_mismatch', method: cep.method, path: cep.path, param: cp.name, expected: pp.type, actual: cp.type });
    }
    for (const cs of cep.status_codes ?? []) {
      if (!(pep.status_codes ?? []).includes(cs)) warningIssues.push({ kind: 'consumer_missing_status', method: cep.method, path: cep.path, status: cs });
    }
  }
  const verdict: 'COMPATIBLE' | 'COMPATIBLE_WITH_DRIFT' | 'INCOMPATIBLE' = breakingIssues.length > 0 ? 'INCOMPATIBLE' : warningIssues.length > 0 ? 'COMPATIBLE_WITH_DRIFT' : 'COMPATIBLE';
  await recordAudit({
    action: AuditAction.CONTRACT_VERIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'api_contracts',
    resourceId: contract.id,
    detail: { mode: 'consumer', name: contract.name, version: contract.version, verdict, breaking: breakingIssues.length, warnings: warningIssues.length },
  });
  return { verdict, breaking_issues: breakingIssues, warning_issues: warningIssues };
}