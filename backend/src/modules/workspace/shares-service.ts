/**
 * CodeConClave — workspace share links.
 *
 * Share co-working spaces via unique public or private links. Public links
 * require no authentication — anyone with the URL can view the shared project
 * state. Private links only work for team members who are already authenticated.
 *
 * Security: tokens are cryptographically random (24 bytes hex). Only the token
 * (never the owner's identity) is exposed on public routes. Share links carry
 * a mode (WATCH / COMMENT / CO_CONTROL) and optional TTL / one-time-use.
 */
import { randomBytes } from 'node:crypto';
import { withSystem, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

export const ShareVisibility = {
  PUBLIC: 'PUBLIC',
  PRIVATE: 'PRIVATE',
} as const;
export type ShareVisibility = (typeof ShareVisibility)[keyof typeof ShareVisibility];

export const ShareMode = {
  WATCH: 'WATCH',
  COMMENT: 'COMMENT',
  CO_CONTROL: 'CO_CONTROL',
} as const;
export type ShareMode = (typeof ShareMode)[keyof typeof ShareMode];

export interface WorkspaceShareView {
  id: string;
  projectId: string;
  token: string;
  visibility: ShareVisibility;
  mode: ShareMode;
  createdAt: string;
  expiresAt: string | null;
  oneTime: boolean;
  revokedAt: string | null;
  redeemedBy: string | null;
  redeemedAt: string | null;
  url: string;
}

interface WorkspaceShareRow {
  id: string;
  owner_id: string;
  project_id: string;
  token: string;
  visibility: ShareVisibility;
  mode: ShareMode;
  created_at: Date;
  expires_at: Date | null;
  one_time: boolean;
  revoked_at: Date | null;
  redeemed_by: string | null;
  redeemed_at: Date | null;
}

function makeToken(): string {
  return randomBytes(24).toString('hex');
}

function toView(row: WorkspaceShareRow): WorkspaceShareView {
  return {
    id: row.id,
    projectId: row.project_id,
    token: row.token,
    visibility: row.visibility,
    mode: row.mode,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    oneTime: row.one_time,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at ? row.redeemed_at.toISOString() : null,
    url: `/share/${row.token}`,
  };
}

export async function createWorkspaceShare(
  ownerId: string,
  projectId: string,
  opts: { visibility?: ShareVisibility; mode?: ShareMode; expiresInDays?: number; oneTime?: boolean } = {},
): Promise<WorkspaceShareView> {
  const id = newId('wsh');
  const token = makeToken();
  const visibility = opts.visibility ?? ShareVisibility.PUBLIC;
  const mode = opts.mode ?? ShareMode.WATCH;
  const expiresAt = opts.expiresInDays && opts.expiresInDays > 0
    ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  // P0-2: insert and the post-insert re-read share ONE tenant transaction, and
  // the re-read is owner-filtered. It previously selected by id alone, which
  // relied entirely on the generated id never being attacker-supplied.
  const row = await withTenant<WorkspaceShareRow | null>(ownerId, async (q) => {
    await q.query(
      `INSERT INTO workspace_shares (id, owner_id, project_id, token, visibility, mode, expires_at, one_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, ownerId, projectId, token, visibility, mode, expiresAt, opts.oneTime ?? false],
    );
    const inserted = await q.query<WorkspaceShareRow>(
      `SELECT * FROM workspace_shares WHERE id = $1 AND owner_id = $2`,
      [id, ownerId],
    );
    return inserted.rows[0] ?? null;
  });
  if (!row) throw AppError.conflict('share_create_conflict', 'Could not create share link.');

  await recordAudit({
    action: 'workspace_share.created',
    actorUserId: ownerId,
    scope: 'USER',
    tenantId: ownerId,
    resourceType: 'project',
    resourceId: projectId,
    detail: { shareId: id, visibility, mode },
  });

  return toView(row);
}

export async function listWorkspaceShares(ownerId: string, projectId: string): Promise<WorkspaceShareView[]> {
  const rows = await withTenant(ownerId, (q) =>
    q.query<WorkspaceShareRow>(
      `SELECT * FROM workspace_shares WHERE owner_id = $1 AND project_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [ownerId, projectId],
    ),
  ).then((r) => r.rows);
  return rows.map(toView);
}

export async function revokeWorkspaceShare(ownerId: string, shareId: string): Promise<void> {
  // P0-2: the existence check, the revoke and the audit-relevant read share one
  // tenant transaction so the owner filter cannot be lost between statements.
  const result = await withTenant<{ row: WorkspaceShareRow; alreadyRevoked: boolean } | null>(
    ownerId,
    async (q) => {
      const existing = await q.query<WorkspaceShareRow>(
        `SELECT * FROM workspace_shares WHERE id = $1 AND owner_id = $2`,
        [shareId, ownerId],
      );
      const found = existing.rows[0] ?? null;
      if (!found) return null;
      if (found.revoked_at) return { row: found, alreadyRevoked: true };
      await q.query(
        `UPDATE workspace_shares SET revoked_at = now() WHERE id = $1 AND owner_id = $2`,
        [shareId, ownerId],
      );
      return { row: found, alreadyRevoked: false };
    },
  );
  if (!result) throw AppError.notFound('Share link');
  const { row, alreadyRevoked } = result;
  if (alreadyRevoked) return;

  await recordAudit({
    action: 'workspace_share.revoked',
    actorUserId: ownerId,
    scope: 'USER',
    tenantId: ownerId,
    resourceType: 'project',
    resourceId: row.project_id,
    detail: { shareId },
  });
}

/**
 * Resolve a public share token — unauthenticated. Returns minimal project
 * info so the client can render a read-only view. NEVER returns the owner's
 * identity, email, or internal ids beyond the project id.
 */
export async function resolvePublicShare(token: string): Promise<{
  projectId: string;
  mode: ShareMode;
  visibility: ShareVisibility;
} | null> {
  // P0-2: this route is deliberately UNAUTHENTICATED (that is the public-share
  // contract), so it is explicitly system-scoped rather than accidentally
  // un-scoped. Every safety check stays in application code, and the token is
  // the only selector — no owner id is read or exposed.
  const row = await withSystem((q) =>
    q.query<WorkspaceShareRow>(`SELECT * FROM workspace_shares WHERE token = $1`, [token]),
  ).then((r) => r.rows[0] ?? null);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.visibility !== 'PUBLIC') return null;
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null;
  if (row.one_time && row.redeemed_at) return null;

  // Mark one-time redemption if applicable (fire-and-forget, non-blocking)
  if (row.one_time) {
    withSystem((q) =>
      q.query(
        `UPDATE workspace_shares SET redeemed_at = now(), redeemed_by = 'anonymous' WHERE id = $1`,
        [row.id],
      ),
    ).catch(() => undefined);
  }

  return { projectId: row.project_id, mode: row.mode, visibility: row.visibility };
}