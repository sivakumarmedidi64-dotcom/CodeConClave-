/**
 * CodeConClave — server-side RBAC enforcement.
 * Roles: OWNER > ADMIN > MEMBER > VIEWER. The server is the single authority;
 * every membership-sensitive operation resolves the caller's role from the
 * database (never from client input) before acting.
 */
import { pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import type { AuthUser } from '../../middleware/context.js';

export type Role = 'owner' | 'admin' | 'editor' | 'member' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'member', 'viewer'];

const RANK: Record<Role, number> = { viewer: 0, member: 1, editor: 2, admin: 3, owner: 4 };

/** Strongest role the caller holds on a project (owner wins over a membership). */
export async function projectRoleFor(userId: string, projectId: string): Promise<Role | null> {
  const result = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2) AS is_owner,
       (SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2) AS member_role`,
    [projectId, userId],
  );
  const row = result.rows[0] as { is_owner: boolean; member_role: Role | null } | undefined;
  if (!row) return null;
  if (row.is_owner) return 'owner';
  return row.member_role ?? null;
}

/** Throw unless the caller's project role is at least one of `allowed`. */
export async function requireProjectRole(
  userId: string,
  projectId: string,
  allowed: readonly Role[],
): Promise<Role> {
  const role = await projectRoleFor(userId, projectId);
  if (!role || !allowed.includes(role)) {
    throw AppError.forbidden('insufficient_permission', 'You do not have permission to perform this action');
  }
  return role;
}

/** Check a user-level role carried on the account (rbac_role). */
export function hasUserRole(user: AuthUser | null | undefined, allowed: readonly Role[]): boolean {
  if (!user) return false;
  return allowed.includes(user.rbacRole);
}

/** Throw unless the authenticated account role is at least one of `allowed`. */
export function requireUserRole(user: AuthUser, allowed: readonly Role[]): void {
  if (!allowed.includes(user.rbacRole)) {
    throw AppError.forbidden('insufficient_permission', 'You do not have permission to perform this action');
  }
}

/** Compare roles: returns true when `role` is at least as strong as `minimum`. */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}