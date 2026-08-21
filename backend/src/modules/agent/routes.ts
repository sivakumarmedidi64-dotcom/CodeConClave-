/**
 * CodeConClave — Local Agent REST surface (/api/v1/agent).
 * - POST /pair  : agent-facing pairing (deviceId + 6-digit code) → device token.
 *                 The pairing code IS the authenticator (10-min expiry, attempt
 *                 cap); the issued token is the long-lived /agent WS credential.
 * - GET  /status: paired devices with online/capability state for the browser.
 */
import { Router } from 'express';
import { asyncRoute } from '../../middleware/security.js';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimit } from '../../middleware/rate-limit.js';
import { verifyDevicePairing } from '../auth/service.js';
import { agentWs } from './ws.js';
import { listDeviceStatus } from './service.js';
import { AppError } from '../../shared/errors.js';

export const agentRoutes = (): Router => {
  const router = Router();

  router.post(
    '/pair',
    authLimit(),
    asyncRoute(async (req, res) => {
      const deviceId = String(req.body.deviceId ?? '');
      const code = String(req.body.code ?? '');
      if (!/^\d{6}$/.test(code)) {
        throw AppError.badRequest('pairing_code_invalid', 'Pairing code must be 6 digits');
      }
      const deviceIdOk = /^dev_[a-z0-9]{20}$/.test(deviceId);
      if (!deviceIdOk) {
        throw AppError.badRequest('device_id_invalid', 'Invalid device id');
      }
      const owner = await findDeviceOwner(deviceId);
      if (!owner) throw AppError.badRequest('device_not_found', 'Device not found');
      const { token } = await verifyDevicePairing(owner.userId, deviceId, code, { grantToken: true });
      if (!token) throw AppError.unavailable('token_unavailable', 'Device token could not be issued');
      await recordPairAudit(owner.userId, deviceId);
      res.status(201).json(jsonResult({ token, backend: `${req.protocol}://${req.get('host')}`, expiresInSeconds: 0 }));
    }),
  );

  router.get(
    '/status',
    requireAuth,
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const hub = agentWs();
      const devices = await listDeviceStatus(userId, (u, d) => hub.isOnline(u, d));
      res.json(jsonResult({ devices }));
    }),
  );

  return router;
};

async function findDeviceOwner(deviceId: string): Promise<{ userId: string } | null> {
  const { pool } = await import('../../shared/db.js');
  const result = await pool.query<{ user_id: string }>('SELECT user_id FROM devices WHERE id = $1', [deviceId]);
  return result.rows[0] ? { userId: result.rows[0].user_id } : null;
}

async function recordPairAudit(userId: string, deviceId: string): Promise<void> {
  const { recordAudit } = await import('../audit/service.js');
  const { AuditAction } = await import('@codeconclave/shared');
  await recordAudit({
    action: AuditAction.DEVICE_PAIRED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'device',
    resourceId: deviceId,
    detail: { via: 'agent_pair' },
  });
}