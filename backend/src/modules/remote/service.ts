/**
 * CodeConClave — remote-control service (Phase 4B).
 * Remote sessions are explicit authorizations to drive a paired device:
 * 8-hour expiry, one ACTIVE session per device (idempotent reuse), immediate
 * revocation, and screenshot access gated by a fresh explicit grant.
 */
import { AuditAction, Timeouts } from '@codeconclave/shared';
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { requirePairedDevice } from '../agent/service.js';
import { assertScreenshotAuthorized, screenshotSource } from '../agent/screenshot.js';

export interface RemoteSessionJson {
  id: string;
  deviceId: string;
  deviceName: string;
  state: string;
  startedAt: string | null;
  expiresAt: string | null;
  lastActiveAt: string | null;
  screenshotAuthorized: boolean;
  screenshotAuthExpiresAt: string | null;
  revokedAt: string | null;
}

interface RemoteSessionRow {
  id: string;
  device_id: string;
  state: string;
  started_at: string | null;
  expires_at: string | null;
  last_active_at: string | null;
  screenshot_authorized: boolean;
  screenshot_auth_expires_at: string | null;
  revoked_at: string | null;
}

export async function createRemoteSession(userId: string, deviceId: string): Promise<RemoteSessionJson> {
  const device = await requirePairedDevice(userId, deviceId);
  const existing = await withTenant(userId, (q) => q.query<RemoteSessionRow>(
    `SELECT id, device_id, state, started_at, expires_at, last_active_at,
            screenshot_authorized, screenshot_auth_expires_at, revoked_at
     FROM remote_sessions
     WHERE owner_id = $1 AND device_id = $2 AND state = 'ACTIVE' AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, deviceId],
  ));
  if (existing.rows[0]) return toJson(existing.rows[0], device.name);

  const id = newId(PREFIX.REMOTE_SESSION);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO remote_sessions (id, owner_id, device_id, state, expires_at)
     VALUES ($1,$2,$3,'ACTIVE', now() + make_interval(msecs => $4))`,
    [id, userId, deviceId, Timeouts.REMOTE_SESSION_TTL_MS],
  ));
  await recordAudit({
    action: AuditAction.REMOTE_SESSION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'remote_session',
    resourceId: id,
    detail: { deviceId },
  });
  const row = await withTenant(userId, (q) => q.query<RemoteSessionRow>(
    `SELECT id, device_id, state, started_at, expires_at, last_active_at,
            screenshot_authorized, screenshot_auth_expires_at, revoked_at
     FROM remote_sessions WHERE id = $1 AND owner_id = $2`,
    [id, userId],
  ));
  return toJson(row.rows[0]!, device.name);
}

export async function listRemoteSessions(userId: string): Promise<RemoteSessionJson[]> {
  const result = await withTenant(userId, (q) => q.query<RemoteSessionRow & { name: string }>(
    `SELECT s.id, s.device_id, s.state, s.started_at, s.expires_at, s.last_active_at,
            s.screenshot_authorized, s.screenshot_auth_expires_at, s.revoked_at,
            d.name
     FROM remote_sessions s
     JOIN devices d ON d.id = s.device_id
     WHERE s.owner_id = $1
     ORDER BY s.created_at DESC`,
    [userId],
  ));
  return result.rows.map((row) => toJson(row, row.name));
}

export async function revokeRemoteSession(userId: string, sessionId: string): Promise<void> {
  const result = await withTenant(userId, (q) => q.query(
    `UPDATE remote_sessions
     SET state = 'REVOKED', revoked_at = now(), screenshot_authorized = false
     WHERE id = $1 AND owner_id = $2 AND state = 'ACTIVE'
     RETURNING id`,
    [sessionId, userId],
  ));
  if (!result.rows[0]) throw AppError.notFound('RemoteSession');
  await recordAudit({
    action: AuditAction.REMOTE_SESSION_REVOKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'remote_session',
    resourceId: sessionId,
  });
}

export async function authorizeScreenshot(userId: string, sessionId: string): Promise<void> {
  const result = await withTenant(userId, (q) => q.query(
    `UPDATE remote_sessions
     SET screenshot_authorized = true,
         screenshot_auth_expires_at = now() + make_interval(msecs => $3)
     WHERE id = $1 AND owner_id = $2 AND state = 'ACTIVE' AND expires_at > now() AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, userId, Timeouts.REMOTE_SCREENSHOT_AUTH_TTL_MS],
  ));
  if (!result.rows[0]) throw AppError.notFound('RemoteSession');
  await recordAudit({
    action: AuditAction.REMOTE_SCREENSHOT_AUTHORIZED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'remote_session',
    resourceId: sessionId,
  });
}

/**
 * Honest screenshot attempt: the privacy gate must pass, then the typed
 * source adapter runs. This platform has no real capture source, so the
 * adapter returns null and the caller reports the external limitation —
 * no simulated image is ever produced.
 */
export async function requestScreenshot(userId: string, sessionId: string): Promise<{ source: string; image: Uint8Array | null }> {
  const row = await withTenant(userId, (q) => q.query<{
    state: string;
    expires_at: string;
    revoked_at: string | null;
    screenshot_authorized: boolean;
    screenshot_auth_expires_at: string | null;
  }>(
    `SELECT state, expires_at, revoked_at, screenshot_authorized, screenshot_auth_expires_at
     FROM remote_sessions WHERE id = $1 AND owner_id = $2`,
    [sessionId, userId],
  ));
  const dbRow = row.rows[0];
  if (!dbRow) throw AppError.notFound('RemoteSession');
  assertScreenshotAuthorized({
    state: dbRow.state,
    expiresAt: dbRow.expires_at,
    revokedAt: dbRow.revoked_at,
    screenshotAuthorized: dbRow.screenshot_authorized,
    screenshotAuthExpiresAt: dbRow.screenshot_auth_expires_at,
  });
  const source = screenshotSource();
  return { source: source.name, image: await source.capture(sessionId, sessionId) };
}

function toJson(row: RemoteSessionRow, deviceName: string): RemoteSessionJson {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName,
    state: row.state,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    lastActiveAt: row.last_active_at,
    screenshotAuthorized: row.screenshot_authorized,
    screenshotAuthExpiresAt: row.screenshot_auth_expires_at,
    revokedAt: row.revoked_at,
  };
}