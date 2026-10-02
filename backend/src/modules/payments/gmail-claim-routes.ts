/**
 * CodeConClave — Gmail claim routes.
 *
 * Two unauthenticated endpoints (HMAC/token-verified, not session-verified):
 *   POST /request   — Apps Script sends HMAC-signed payment detection payload
 *   POST /activate  — Customer clicks one-time claim link to activate plan
 *
 * Mounted at /api/v1/payments/gmail-claim BEFORE the auth-gated payment
 * router so requireAuth does not intercept these requests. CSRF is also
 * exempt (HMAC/token authenticated, not browser-cookie authenticated).
 */
import { Router } from 'express';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  requestGmailClaim,
  activateGmailClaim,
  gmailClaimEnabled,
  type GmailClaimPayload,
} from './gmail-claim.js';

export const gmailClaimRoutes = (): Router => {
  const router = Router();

  /**
   * POST /request — Apps Script → Backend
   * Body: { payload: GmailClaimPayload, timestamp: number, signature: string }
   * Auth: HMAC-SHA256 signature over timestamp:JSON.stringify(payload)
   */
  router.post(
    '/request',
    asyncRoute(async (req, res) => {
      if (!gmailClaimEnabled()) {
        throw AppError.notFound('gmail_claim_disabled', 'Gmail claim rail is not enabled');
      }

      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw AppError.badRequest('invalid_body', 'Request body must be a JSON object');
      }

      const payload = body.payload as GmailClaimPayload | undefined;
      const timestamp = body.timestamp as number | undefined;
      const signature = body.signature as string | undefined;

      if (!payload || typeof payload !== 'object') {
        throw AppError.badRequest('invalid_payload', 'payload is required and must be an object');
      }
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        throw AppError.badRequest('invalid_timestamp', 'timestamp is required and must be a number');
      }
      if (typeof signature !== 'string' || signature.trim().length === 0) {
        throw AppError.badRequest('invalid_signature', 'signature is required and must be a non-empty string');
      }

      const result = await requestGmailClaim({ payload, timestamp, signature: signature.trim() });
      res.status(200).json({ ok: true, ...result });
    }),
  );

  /**
   * POST /activate — Customer click → Backend
   * Body: { token: string, id: string }
   * Auth: One-time claim token (SHA-256 verified server-side)
   */
  router.post(
    '/activate',
    asyncRoute(async (req, res) => {
      if (!gmailClaimEnabled()) {
        throw AppError.notFound('gmail_claim_disabled', 'Gmail claim rail is not enabled');
      }

      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        throw AppError.badRequest('invalid_body', 'Request body must be a JSON object');
      }

      const token = typeof body.token === 'string' ? body.token : '';
      const id = typeof body.id === 'string' ? body.id : '';

      if (!token || token.trim().length === 0) {
        throw AppError.badRequest('invalid_token', 'token is required');
      }
      if (!id || id.trim().length === 0) {
        throw AppError.badRequest('invalid_claim_id', 'id is required');
      }

      const result = await activateGmailClaim(token.trim(), id.trim());
      res.status(200).json({ ok: true, ...result });
    }),
  );

  return router;
};
