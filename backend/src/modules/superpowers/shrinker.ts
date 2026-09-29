/**
 * CodeConClave — Superpowers: PRIVILEGE SHRINKER (Master Feature #41).
 *
 * Continuously audits grants — service accounts, IAM roles, API tokens, file
 * permissions — and flags anything over-permissioned. Every flag carries the
 * minimal-privilege rewrite ready to apply, so the attack surface shrinks over
 * time instead of growing.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type PrivilegeScope = 'read' | 'write' | 'admin' | 'ALL';
export type PrivilegeSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type PrivilegeStatus = 'OPEN' | 'SHRUNK';

const VALID_SCOPES: PrivilegeScope[] = ['read', 'write', 'admin', 'ALL'];

export interface GrantInput {
  principal: string;
  resource: string;
  action: string;
  scope: PrivilegeScope;
}

export interface PrivilegeFlagRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  principal: string;
  resource: string;
  action: string;
  scope: PrivilegeScope;
  severity: PrivilegeSeverity;
  minimal_rewrite: string;
  status: PrivilegeStatus;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PrivilegeFlagRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  principal: String(r.principal),
  resource: String(r.resource),
  action: String(r.action),
  scope: r.scope as PrivilegeScope,
  severity: r.severity as PrivilegeSeverity,
  minimal_rewrite: String(r.minimal_rewrite),
  status: (r.status ?? 'OPEN') as PrivilegeStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const SENSITIVE_RESOURCE = /secret|credential|api[_-]?key|access[_-]?token|prod(-|_|$)|database|payment|billing|password|private[-_]?key/i;

function flagFor(grant: GrantInput): { severity: PrivilegeSeverity; minimalRewrite: string } | null {
  if (grant.scope === 'ALL') {
    return {
      severity: 'CRITICAL',
      minimalRewrite: `${grant.action.toLowerCase()} on "${grant.resource}" only (wildcard scope narrowed)`,
    };
  }
  if (grant.principal === '*') {
    return {
      severity: 'HIGH',
      minimalRewrite: `individual principal scoped to "${grant.resource}" ${grant.action} (wildcard principal removed)`,
    };
  }
  if (/admin/i.test(grant.action) && SENSITIVE_RESOURCE.test(grant.resource)) {
    return {
      severity: 'HIGH',
      minimalRewrite: `read-only on "${grant.resource}" (admin narrowed for sensitive resource)`,
    };
  }
  return null;
}

export async function auditPermissions(userId: string, input: { projectId?: string | null; grants: GrantInput[] }): Promise<{
  grants: number;
  flagged: number;
  findings: PrivilegeFlagRow[];
}> {
  const grants = Array.isArray(input.grants) ? input.grants : [];
  if (grants.length === 0) throw AppError.badRequest('empty_grants', 'privilege shrinker needs at least one grant to audit');
  const findings: PrivilegeFlagRow[] = [];
  for (const grant of grants) {
    if (!grant.principal || typeof grant.principal !== 'string') throw AppError.badRequest('invalid_principal', 'each grant needs a principal');
    if (!grant.resource || typeof grant.resource !== 'string') throw AppError.badRequest('invalid_resource', 'each grant needs a resource');
    if (!VALID_SCOPES.includes(grant.scope)) throw AppError.badRequest('invalid_scope', `scope must be one of: ${VALID_SCOPES.join(', ')}`);
    const flag = flagFor(grant);
    if (!flag) continue;
    const id = newId(PREFIX.PRIVILEGE_FLAG);
    await withTenant(userId, (q) => q.query(
      'INSERT INTO privilege_flags (id, owner_id, project_id, principal, resource, action, scope, severity, minimal_rewrite, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, userId, input.projectId ?? null, grant.principal, grant.resource, grant.action, grant.scope, flag.severity, flag.minimalRewrite, 'OPEN'],
    ));
    findings.push(await getPrivilegeFlag(userId, id));
  }
  await recordAudit({
    action: AuditAction.PRIVILEGE_FLAGGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'privilege_flags',
    resourceId: null,
    detail: { grants: grants.length, flagged: findings.length },
  });
  return { grants: grants.length, flagged: findings.length, findings };
}

export async function getPrivilegeFlag(userId: string, id: string): Promise<PrivilegeFlagRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM privilege_flags WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('privilege_flag_not_found', 'no privilege flag found for that id');
  return rowOf(row);
}

export async function shrinkPrivilege(userId: string, id: string): Promise<PrivilegeFlagRow> {
  const flag = await getPrivilegeFlag(userId, id);
  if (flag.status === 'SHRUNK') return flag;
  await withTenant(userId, (q) => q.query('UPDATE privilege_flags SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'SHRUNK']));
  await recordAudit({
    action: AuditAction.PRIVILEGE_SHRUNK,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'privilege_flags',
    resourceId: id,
    detail: { principal: flag.principal, resource: flag.resource, action: flag.action, minimalRewrite: flag.minimal_rewrite },
  });
  return getPrivilegeFlag(userId, id);
}

export async function listPrivilegeFlags(userId: string, filter: { severity?: PrivilegeSeverity; status?: PrivilegeStatus } = {}): Promise<PrivilegeFlagRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM privilege_flags WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.severity) rows = rows.filter((f) => f.severity === filter.severity);
  if (filter.status) rows = rows.filter((f) => f.status === filter.status);
  return rows.sort((a, b) => a.status.localeCompare(b.status) || b.created_at.getTime() - a.created_at.getTime());
}

export async function privilegeReport(userId: string): Promise<{
  total: number;
  open: number;
  shrunk: number;
  by_severity: Record<PrivilegeSeverity, number>;
  shrinkable: number;
}> {
  const rows = await listPrivilegeFlags(userId);
  const by_severity: Record<PrivilegeSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of rows) by_severity[r.severity] += 1;
  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'OPEN').length,
    shrunk: rows.filter((r) => r.status === 'SHRUNK').length,
    by_severity,
    shrinkable: rows.filter((r) => r.status === 'OPEN').length,
  };
}