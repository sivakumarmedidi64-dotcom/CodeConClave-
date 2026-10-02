/**
 * CodeConClave — cowork conversation share links + invitations.
 *
 * Share links are ephemeral access tokens for a conversation deep link. They
 * are persisted in the EXISTING `conversations.sharing` jsonb column (no new
 * table, no migration) and enforce expiry, revocation, and one-time
 * redemption. Identity federation (external, unauthenticated guests) is NOT
 * enabled: redemption requires the caller to already be the owner or an ACTIVE
 * team member of the conversation's workspace — anything else FAILS CLOSED
 * with `aios_share_access_denied` (a token never silently grants access).
 *
 * Team invitations reuse the existing teams `inviteMember` flow — this module
 * only stores an informational invite ledger alongside the share tokens.
 */
import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { getConversation } from './service.js';
import { withTenant, queryMany } from '../../shared/db.js';

export const ShareMode = {
  WATCH: 'WATCH',
  COMMENT: 'COMMENT',
  CO_CONTROL: 'CO_CONTROL',
} as const;
export type ShareMode = (typeof ShareMode)[keyof typeof ShareMode];

export interface ShareTokenEntry {
  id: string;
  mode: ShareMode;
  createdAt: number;
  expiresAt: number | null;
  oneTime: boolean;
  revokedAt?: number;
  redeemedBy?: string | null;
  redeemedAt?: number | null;
}

export interface ShareInviteEntry {
  userId: string;
  role: string;
  at: number;
}

export interface StoredSharing {
  shareTokens?: ShareTokenEntry[];
  invites?: ShareInviteEntry[];
}

export interface CreateShareLinkInput {
  mode?: ShareMode;
  expiresInMs?: number;
  oneTime?: boolean;
}

export interface ShareLinkView {
  conversationId: string;
  token: string;
  mode: ShareMode;
  createdAt: number;
  expiresAt: number | null;
  oneTime: boolean;
  revokedAt?: number;
  redeemedBy?: string | null;
  redeemedAt?: number | null;
  url: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function newShareToken(): string {
  return randomBytes(18).toString('hex');
}

/** Tolerant parse of the `sharing` jsonb column (null / '' / string / object). */
export function parseStoredSharing(raw: unknown): StoredSharing {
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      return parseStoredSharing(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const out: StoredSharing = {};
  if (Array.isArray(obj.shareTokens)) {
    out.shareTokens = obj.shareTokens.filter(isShareTokenEntry);
  }
  if (Array.isArray(obj.invites)) {
    out.invites = obj.invites.filter(isShareInviteEntry);
  }
  return out;
}

function isShareTokenEntry(v: unknown): v is ShareTokenEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    (e.mode === ShareMode.WATCH || e.mode === ShareMode.COMMENT || e.mode === ShareMode.CO_CONTROL) &&
    typeof e.createdAt === 'number' &&
    (e.expiresAt === null || typeof e.expiresAt === 'number')
  );
}

function isShareInviteEntry(v: unknown): v is ShareInviteEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.userId === 'string' && typeof e.role === 'string' && typeof e.at === 'number';
}

// ---------------------------------------------------------- pure domain core

export function createShareToken(input: CreateShareLinkInput, now = Date.now(), token = newShareToken()): ShareTokenEntry {
  return {
    id: token,
    mode: input.mode ?? ShareMode.WATCH,
    createdAt: now,
    expiresAt: input.expiresInMs && input.expiresInMs > 0 ? now + input.expiresInMs : DEFAULT_TTL_MS + now,
    oneTime: input.oneTime ?? false,
    redeemedBy: null,
    redeemedAt: null,
  };
}

/** Validates + applies one-time redemption. THROWS for expired/revoked/used. */
export function redeemShareToken(
  entries: ShareTokenEntry[],
  token: string,
  userId: string,
  now = Date.now(),
): ShareTokenEntry {
  const entry = entries.find((e) => e.id === token);
  if (!entry) throw AppError.notFound('Share link');
  if (entry.revokedAt !== undefined) {
    throw AppError.forbidden('aios_share_revoked', 'This share link has been revoked.');
  }
  if (entry.expiresAt !== null && now > entry.expiresAt) {
    throw AppError.conflict('aios_share_expired', 'This share link has expired.');
  }
  if (entry.oneTime && entry.redeemedAt !== null && entry.redeemedAt !== undefined) {
    throw AppError.conflict('aios_share_consumed', 'This one-time share link has already been used.');
  }
  if (entry.oneTime) {
    entry.redeemedBy = userId;
    entry.redeemedAt = now;
  }
  return entry;
}

/** Marks a token revoked. Returns true when it existed. */
export function revokeShareToken(entries: ShareTokenEntry[], token: string): boolean {
  const entry = entries.find((e) => e.id === token);
  if (!entry) return false;
  entry.revokedAt = Date.now();
  return true;
}

/** Sweep expired/revoked tokens; returns the number removed (keep the ledger honest). */
export function purgeShareTokens(entries: ShareTokenEntry[], now = Date.now()): number {
  const before = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.revokedAt !== undefined) entries.splice(i, 1);
    else if (e.expiresAt !== null && now > e.expiresAt) entries.splice(i, 1);
  }
  return before - entries.length;
}

// ---------------------------------------------------------- db adapter

type SharingRow = { sharing: string | null | Record<string, unknown> };

async function loadSharing(userId: string, conversationId: string): Promise<StoredSharing> {
  const conversation = await getConversation(userId, conversationId);
  return parseStoredSharing((conversation as unknown as SharingRow).sharing);
}

async function saveSharing(userId: string, conversationId: string, sharing: StoredSharing): Promise<void> {
  await withTenant(userId, (q) =>
    q.query('UPDATE conversations SET sharing = $2::jsonb WHERE id = $1', [
      conversationId,
      JSON.stringify(sharing),
    ]),
  );
}

export async function createConversationShareLink(
  userId: string,
  conversationId: string,
  input: CreateShareLinkInput = {},
): Promise<ShareLinkView> {
  const sharing = await loadSharing(userId, conversationId);
  const entries = sharing.shareTokens ?? [];
  const entry = createShareToken(input);
  entries.push(entry);
    await saveSharing(userId, conversationId, { ...sharing, shareTokens: entries });
  await recordAudit({
    action: 'conversation.share_link_created',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'conversation',
    resourceId: conversationId,
    detail: { tokenId: entry.id, mode: entry.mode, oneTime: entry.oneTime },
  });
  return toView(conversationId, entry);
}

export async function listConversationShareLinks(userId: string, conversationId: string): Promise<ShareLinkView[]> {
  const sharing = await loadSharing(userId, conversationId);
  return (sharing.shareTokens ?? []).map((e) => toView(conversationId, e));
}

export async function getShareLink(userId: string, token: string): Promise<ShareLinkView> {
  // Resolve through the caller's own conversation access: a token alone never
  // exposes conversation info. Iterate the caller's conversations (bounded,
  // read-mostly list) to find the token without a second token->conv table.
  const rows = await withTenant<RowWithSharing[]>(userId, async (q) =>
    (
      await q.query<RowWithSharing>(
        "SELECT * FROM conversations WHERE deleted_at IS NULL AND sharing::text LIKE $1 AND (owner_id = $2 OR team_id IN (SELECT team_id FROM team_members WHERE user_id = $2 AND status = 'ACTIVE')) LIMIT 1",
        [`%${token}%`, userId],
      )
    ).rows,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Share link');
  const sharing = parseStoredSharing(row.sharing);
  const entry = (sharing.shareTokens ?? []).find((e) => e.id === token);
  if (!entry) throw AppError.notFound('Share link');
  return toView(row.id, entry);
}

type RowWithSharing = {
  id: string;
  sharing: string | null | Record<string, unknown>;
};

/**
 * Redeem a share link. The token must be valid AND the caller must already be
 * a collaborator (owner or active team member) — external identity federation
 * is out of scope, so redemption for non-collaborators FAILS CLOSED rather
 * than silently granting anything.
 */
export async function redeemConversationShareLink(userId: string, token: string): Promise<ShareLinkView> {
  const view = await getShareLink(userId, token);
  const sharing = await loadSharing(userId, view.conversationId);
  const entries = sharing.shareTokens ?? [];
  redeemShareToken(entries, token, userId); // validates + applies one-time consumption
  await saveSharing(userId, view.conversationId, { ...sharing, shareTokens: entries });
  await recordAudit({
    action: 'conversation.share_link_redeemed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'conversation',
    resourceId: view.conversationId,
    detail: { tokenId: token, mode: view.mode },
  });
  return view;
}

export async function revokeConversationShareLink(userId: string, conversationId: string, token: string): Promise<void> {
  const sharing = await loadSharing(userId, conversationId);
  const entries = sharing.shareTokens ?? [];
  if (revokeShareToken(entries, token)) {
  await saveSharing(userId, conversationId, { ...sharing, shareTokens: entries });
    await recordAudit({
      action: 'conversation.share_link_revoked',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'conversation',
      resourceId: conversationId,
      detail: { tokenId: token },
    });
  } else {
    throw AppError.notFound('Share link');
  }
}

function toView(conversationId: string, e: ShareTokenEntry): ShareLinkView {
  return {
    conversationId,
    token: e.id,
    mode: e.mode,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    oneTime: e.oneTime,
    revokedAt: e.revokedAt,
    redeemedBy: e.redeemedBy,
    redeemedAt: e.redeemedAt,
    url: `/cowork/share/${conversationId}/${e.id}`,
  };
}