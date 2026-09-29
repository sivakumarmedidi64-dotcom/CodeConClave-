/**
 * CodeConClave — Superpowers: AGENT SANDBOX ISOLATION (Master Feature #44).
 *
 * Every agent action is adjudicated against a sandbox policy: network egress
 * only to an allowlist, filesystem access jailed to a root, credentials only
 * available through a vault, and every call written to an audit trail. Autonomy
 * without containment is malpractice — this makes granting agents real power
 * safe.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type SandboxActionKind = 'NETWORK_CALL' | 'FILE_ACCESS' | 'CREDENTIAL_READ' | 'SYS_CALL';
export type SandboxDecision = 'ALLOWED' | 'BLOCKED';

const ACTION_KINDS: SandboxActionKind[] = ['NETWORK_CALL', 'FILE_ACCESS', 'CREDENTIAL_READ', 'SYS_CALL'];

export interface SandboxPolicyRow {
  id: string;
  owner_id: string;
  agent_name: string;
  egress_allowlist: string[];
  fs_jail_root: string;
  credentials_vault: boolean;
  syscall_logging: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SandboxActionRow {
  id: string;
  owner_id: string;
  policy_id: string;
  run_ref: string;
  kind: SandboxActionKind;
  target: string;
  decision: SandboxDecision;
  created_at: Date;
}

const asStringList = (v: unknown): string[] => {
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(String); } catch { /* keep */ }
  }
  if (Array.isArray(v)) return v.map(String);
  return [];
};

const truthy = (v: unknown): boolean => v === true || v === 'true';

const policyRowOf = (r: Record<string, unknown>): SandboxPolicyRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  agent_name: String(r.agent_name),
  egress_allowlist: asStringList(r.egress_allowlist),
  fs_jail_root: String(r.fs_jail_root ?? '/'),
  credentials_vault: truthy(r.credentials_vault),
  syscall_logging: truthy(r.syscall_logging),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const actionRowOf = (r: Record<string, unknown>): SandboxActionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  policy_id: String(r.policy_id),
  run_ref: String(r.run_ref),
  kind: r.kind as SandboxActionKind,
  target: String(r.target),
  decision: r.decision as SandboxDecision,
  created_at: new Date(r.created_at as string),
});

const posix = (p: string): string => String(p).replace(/\\/g, '/');

const hostOf = (target: string): string => {
  let s = String(target).trim();
  const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) s = s.slice(scheme[0]!.length);
  return s.split(/[/?#:]/)[0]!;
};

function matchesAllowlist(allowlist: string[], host: string): boolean {
  return allowlist.some((entryRaw) => {
    const entry = String(entryRaw).trim();
    if (entry === host) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      return host === suffix || host.endsWith(suffix);
    }
    const entryHost = hostOf(entry);
    return entryHost === host;
  });
}

function withinJail(target: string, root: string): boolean {
  const t = posix(target).replace(/\/+$/, '') || '/';
  const r = posix(root).replace(/\/+$/, '');
  if (r === '' || r === '/') return true;
  return t === r || t.startsWith(`${r}/`);
}

function findPolicy(userId: string, input: { policyId?: string | null; agentName?: string | null }): Promise<SandboxPolicyRow> {
  if (input.policyId) return findPolicyById(userId, input.policyId);
  if (input.agentName) return findPolicyByAgent(userId, input.agentName);
  return Promise.reject(AppError.badRequest('policy_reference_missing', 'provide a policyId or agentName to resolve the sandbox policy'));
}

export async function findPolicyById(userId: string, id: string): Promise<SandboxPolicyRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM sandbox_policies WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('sandbox_policy_not_found', 'no sandbox policy found for that id');
  return policyRowOf(row);
}

export async function findPolicyByAgent(userId: string, agentName: string): Promise<SandboxPolicyRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM sandbox_policies WHERE owner_id = $1 AND agent_name = $2', [userId, agentName]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('sandbox_policy_not_found', `no sandbox policy found for agent ${agentName}`);
  return policyRowOf(row);
}

export async function registerSandboxPolicy(userId: string, input: {
  agentName: string;
  egressAllowlist: string[];
  fsJailRoot: string;
  credentialsVault?: boolean;
  syscallLogging?: boolean;
}): Promise<SandboxPolicyRow> {
  const { agentName, egressAllowlist, fsJailRoot } = input;
  if (!agentName || typeof agentName !== 'string') throw AppError.badRequest('invalid_agent_name', 'a sandbox policy needs an agent name');
  if (!fsJailRoot || typeof fsJailRoot !== 'string') throw AppError.badRequest('invalid_jail_root', 'a sandbox policy needs a filesystem jail root');
  const allowlist = Array.isArray(egressAllowlist) ? egressAllowlist.map(String) : [];
  if (allowlist.length === 0) throw AppError.badRequest('empty_allowlist', 'a sandbox policy needs at least one allowlisted egress domain');
  for (const entry of allowlist) {
    if (/\s/.test(entry)) throw AppError.badRequest('invalid_allowlist_entry', `allowlist entry "${entry}" must not contain whitespace`);
  }
  const vault = input.credentialsVault !== false;
  const logging = input.syscallLogging !== false;
  const existing = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM sandbox_policies WHERE owner_id = $1 AND agent_name = $2', [userId, agentName]).then((r) => r.rows[0] ?? null),
  );
  if (existing) {
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE sandbox_policies SET egress_allowlist = $3, fs_jail_root = $4, credentials_vault = $5, syscall_logging = $6, updated_at = now() WHERE id = $1 AND owner_id = $2',
        [String(existing.id), userId, JSON.stringify(allowlist), fsJailRoot, vault, logging],
      ),
    );
  } else {
    const id = newId(PREFIX.SANDBOX_POLICY);
    await withTenant(userId, (q) =>
      q.query(
        'INSERT INTO sandbox_policies (id, owner_id, agent_name, egress_allowlist, fs_jail_root, credentials_vault, syscall_logging) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, userId, agentName, JSON.stringify(allowlist), fsJailRoot, vault, logging],
      ),
    );
  }
  await recordAudit({
    action: AuditAction.SANDBOX_POLICY_REGISTERED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'sandbox_policies',
    resourceId: null,
    detail: { agentName, egressEntries: allowlist.length, jailRoot: fsJailRoot, vault, logging },
  });
  return findPolicyByAgent(userId, agentName);
}

export interface EnforcementResult {
  id: string;
  decision: SandboxDecision;
  reason: string;
  agentName: string;
  policyId: string;
}

export async function enforceSandbox(userId: string, input: {
  policyId?: string | null;
  agentName?: string | null;
  runRef: string;
  kind: SandboxActionKind;
  target: string;
}): Promise<EnforcementResult> {
  const { runRef, kind, target } = input;
  if (!runRef || typeof runRef !== 'string') throw AppError.badRequest('invalid_run_ref', 'sandbox enforcement needs a run reference');
  if (!ACTION_KINDS.includes(kind)) throw AppError.badRequest('invalid_kind', `kind must be one of: ${ACTION_KINDS.join(', ')}`);
  if (!target || typeof target !== 'string') throw AppError.badRequest('invalid_target', 'sandbox enforcement needs a target');
  const policy = await findPolicy(userId, input);

  let decision: SandboxDecision;
  let reason: string;
  switch (kind) {
    case 'NETWORK_CALL': {
      const host = hostOf(target);
      if (matchesAllowlist(policy.egress_allowlist, host)) {
        decision = 'ALLOWED';
        reason = `egress host "${host}" is allowlisted`;
      } else {
        decision = 'BLOCKED';
        reason = `egress host "${host}" is not in the allowlist`;
      }
      break;
    }
    case 'FILE_ACCESS': {
      if (withinJail(target, policy.fs_jail_root)) {
        decision = 'ALLOWED';
        reason = `path "${target}" is inside the jail root "${policy.fs_jail_root}"`;
      } else {
        decision = 'BLOCKED';
        reason = `path "${target}" escapes the jail root "${policy.fs_jail_root}"`;
      }
      break;
    }
    case 'CREDENTIAL_READ': {
      if (policy.credentials_vault) {
        decision = 'ALLOWED';
        reason = 'credentials injected at runtime via the secure vault';
      } else {
        decision = 'BLOCKED';
        reason = 'policy forbids credential access (no secure vault)';
      }
      break;
    }
    case 'SYS_CALL': {
      if (policy.syscall_logging) {
        decision = 'ALLOWED';
        reason = 'syscall recorded in the sandbox audit trail';
      } else {
        decision = 'BLOCKED';
        reason = 'policy requires syscall audit logging before execution';
      }
      break;
    }
  }

  const id = newId(PREFIX.SANDBOX_ACTION);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO sandbox_actions (id, owner_id, policy_id, run_ref, kind, target, decision) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, policy.id, runRef, kind, target, decision],
    ),
  );
  await recordAudit({
    action: decision === 'ALLOWED' ? AuditAction.SANDBOX_ENFORCED : AuditAction.SANDBOX_BLOCKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'sandbox_actions',
    resourceId: id,
    detail: { agentName: policy.agent_name, runRef, kind, target, decision, reason },
  });
  return { id, decision, reason, agentName: policy.agent_name, policyId: policy.id };
}

export async function listSandboxPolicies(userId: string): Promise<SandboxPolicyRow[]> {
  const rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM sandbox_policies WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(policyRowOf);
  return rows.sort((a, b) => a.agent_name.localeCompare(b.agent_name));
}

export async function listSandboxActions(userId: string, filter: { runRef?: string; decision?: SandboxDecision } = {}): Promise<SandboxActionRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM sandbox_actions WHERE owner_id = $1', [userId]).then((r) => r.rows),
  )).map(actionRowOf);
  if (filter.runRef) rows = rows.filter((a) => a.run_ref === filter.runRef);
  if (filter.decision) rows = rows.filter((a) => a.decision === filter.decision);
  return rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function sandboxReport(userId: string): Promise<{
  policies: number;
  actions: number;
  allowed: number;
  blocked: number;
  egress_rule_count: number;
  jails_active: number;
}> {
  const policies = await listSandboxPolicies(userId);
  const actions = await listSandboxActions(userId);
  return {
    policies: policies.length,
    actions: actions.length,
    allowed: actions.filter((a) => a.decision === 'ALLOWED').length,
    blocked: actions.filter((a) => a.decision === 'BLOCKED').length,
    egress_rule_count: policies.reduce((n, p) => n + p.egress_allowlist.length, 0),
    jails_active: policies.filter((p) => p.fs_jail_root !== '/').length,
  };
}