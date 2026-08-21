/**
 * CodeConClave — Local Agent status & authorization helpers.
 * Presence is derived, never guessed: ONLINE requires a live agent socket
 * (isOnline), STALE means heartbeats stopped recently, OFFLINE is anything
 * else. Remote-control actions additionally require an ACTIVE remote session
 * (explicit, expiring authorization — spec 8h).
 */
import { Timeouts, type DevicePresence } from '@codeconclave/shared';
import { pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';

export type IsOnlineFn = (userId: string, deviceId: string) => boolean;

export function devicePresence(
  lastSeenAt: string | Date | null,
  online: boolean,
  now = Date.now(),
): DevicePresence {
  if (online) return 'ONLINE';
  if (!lastSeenAt) return 'OFFLINE';
  const age = now - new Date(lastSeenAt).getTime();
  if (!Number.isFinite(age)) return 'OFFLINE';
  return age <= Timeouts.AGENT_PRESENCE_STALE_MS ? 'STALE' : 'OFFLINE';
}

export interface DeviceStatus {
  id: string;
  name: string;
  state: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  capabilities: string[];
  presence: DevicePresence;
  remoteCapable: boolean;
}

export async function listDeviceStatus(userId: string, isOnline: IsOnlineFn): Promise<DeviceStatus[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    state: string;
    paired_at: string | null;
    last_seen_at: string | null;
    created_at: string;
    capabilities: unknown;
  }>(
    `SELECT id, name, state, paired_at, last_seen_at, created_at, capabilities
     FROM devices WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => {
    const caps = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      capabilities: caps,
      presence: devicePresence(row.last_seen_at, isOnline(userId, row.id)),
      remoteCapable: caps.includes('terminal_exec'),
    };
  });
}

export async function requirePairedDevice(userId: string, deviceId: string): Promise<{ id: string; name: string; capabilities: string[] }> {
  const result = await pool.query<{ id: string; name: string; state: string; capabilities: unknown }>(
    'SELECT id, name, state, capabilities FROM devices WHERE id = $1 AND user_id = $2',
    [deviceId, userId],
  );
  const row = result.rows[0];
  if (!row) throw AppError.notFound('Device');
  if (row.state !== 'PAIRED') {
    throw AppError.badRequest('device_not_paired', 'Device is not paired');
  }
  return {
    id: row.id,
    name: row.name,
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
  };
}

export function requireAgentOnline(userId: string, deviceId: string, isOnline: IsOnlineFn): void {
  if (!isOnline(userId, deviceId)) {
    throw AppError.unavailable(
      'local_agent_offline',
      'Local Agent is offline — no local execution is active and none is claimed',
    );
  }
}

export async function hasActiveRemoteSession(userId: string, deviceId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM remote_sessions
     WHERE owner_id = $1 AND device_id = $2 AND state = 'ACTIVE' AND expires_at > now()
     LIMIT 1`,
    [userId, deviceId],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function requireRemoteSession(userId: string, deviceId: string): Promise<void> {
  if (!(await hasActiveRemoteSession(userId, deviceId))) {
    throw AppError.forbidden(
      'remote_session_required',
      'An active remote-control session (8-hour expiry) is required for this device',
    );
  }
}