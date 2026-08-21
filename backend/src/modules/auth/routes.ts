/**
 * CodeConClave — auth routes.
 * Signup, login, MFA, recovery, sessions, devices, profile.
 */
import { Router } from 'express';
import { loginSchema, registerSchema, mfaVerifySchema } from '@codeconclave/shared';
import { jsonResult } from './schemas.js';
import {
  completeMfa,
  confirmMfa,
  createDevice,
  disableMfa,
  getUserById,
  listDevices,
  listSessions,
  login,
  logout,
  register,
  revokeDevice,
  revokeSession,
  rotateRecoveryCodes,
  setupMfa,
  verifyDevicePairing,
  applyAuthResponse,
} from './service.js';
import { requireAuth } from '../../middleware/auth.js';
import { clearSessionCookie, setSessionCookie } from '../../middleware/auth.js';
import { authLimit } from '../../middleware/rate-limit.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { randomToken } from '../../shared/crypto.js';
import { env } from '../../config/env.js';
import { sendVerificationEmail, verifyEmailToken, verificationStatus } from './verification.js';

export const authRoutes = (): Router => {
  const router = Router();

  router.post(
    '/register',
    authLimit(),
    asyncRoute(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const result = await register(
        { email: input.email, password: input.password, displayName: input.displayName },
        req,
      );
      applyAuthResponse(res, result);
      res.status(201).json(jsonResult({ user: result.user }));
    }),
  );

  router.post(
    '/login',
    authLimit(),
    asyncRoute(async (req, res) => {
      const input = loginSchema.parse(req.body);
      const result = await login({ email: input.email, password: input.password }, req);
      if ('mfaRequired' in result) {
        res.json(jsonResult({ mfaRequired: true, challengeToken: result.challengeToken }));
        return;
      }
      applyAuthResponse(res, result);
      res.json(jsonResult({ user: result.user }));
    }),
  );

  router.post(
    '/mfa/verify',
    authLimit(),
    asyncRoute(async (req, res) => {
      const input = mfaVerifySchema.parse({
        code: req.body.code,
        rememberDevice: req.body.rememberDevice,
      });
      const result = await completeMfa(
        {
          challengeToken: String(req.body.challengeToken ?? ''),
          code: (input as { code?: string }).code,
          recoveryCode: req.body.recoveryCode,
        },
        req,
      );
      applyAuthResponse(res, result);
      res.json(jsonResult({ user: result.user }));
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    asyncRoute(async (req, res) => {
      if (req.ctx.user && req.ctx.sessionId) {
        await logout(req.ctx.user.id, req.ctx.sessionId, req);
      }
      clearSessionCookie(res);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncRoute(async (req, res) => {
      const user = await getUserById(req.ctx.user!.id);
      res.json(jsonResult({ user }));
    }),
  );

  router.post(
    '/mfa/setup',
    requireAuth,
    asyncRoute(async (req, res) => {
      const result = await setupMfa(req.ctx.user!.id);
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/mfa/confirm',
    requireAuth,
    asyncRoute(async (req, res) => {
      const code = String(req.body.code ?? '');
      if (!/^\d{6}$/.test(code)) throw AppError.badRequest('mfa_code_invalid', 'Invalid TOTP code');
      const { recoveryCodes, sessionToken } = await confirmMfa(req.ctx.user!.id, code, req);
      // MFA enablement rotates the session: the new cookie replaces the old one.
      setSessionCookie(res, sessionToken);
      res.status(201).json(jsonResult({ recoveryCodes }));
    }),
  );

  router.post(
    '/mfa/disable',
    requireAuth,
    asyncRoute(async (req, res) => {
      const code = String(req.body.code ?? '');
      const rotated = await disableMfa(req.ctx.user!.id, code, req);
      if (rotated) setSessionCookie(res, rotated.sessionToken);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/mfa/recovery-codes/rotate',
    requireAuth,
    asyncRoute(async (req, res) => {
      const code = String(req.body.code ?? '');
      const codes = await rotateRecoveryCodes(req.ctx.user!.id, code, req);
      res.json(jsonResult({ recoveryCodes: codes }));
    }),
  );

  router.get(
    '/sessions',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ sessions: await listSessions(req.ctx.user!.id) }));
    }),
  );

  router.delete(
    '/sessions/:id',
    requireAuth,
    asyncRoute(async (req, res) => {
      await revokeSession(req.ctx.user!.id, req.params.id!, req);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/devices',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ devices: await listDevices(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/devices',
    requireAuth,
    asyncRoute(async (req, res) => {
      const name = String(req.body.name ?? 'Device').slice(0, 80);
      const result = await createDevice(req.ctx.user!.id, name);
      res.status(201).json(jsonResult(result));
    }),
  );

  router.post(
    '/devices/verify',
    requireAuth,
    asyncRoute(async (req, res) => {
      const deviceId = String(req.body.deviceId ?? '');
      const code = String(req.body.code ?? '');
      if (!/^\d{6}$/.test(code)) throw AppError.badRequest('pairing_code_invalid', 'Pairing code must be 6 digits');
      await verifyDevicePairing(req.ctx.user!.id, deviceId, code);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/devices/:id',
    requireAuth,
    asyncRoute(async (req, res) => {
      await revokeDevice(req.ctx.user!.id, req.params.id!, req);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // Email verification: send (rate-limited + throttled), status, single-use verify.
  router.post(
    '/verify-email/send',
    requireAuth,
    authLimit(),
    asyncRoute(async (req, res) => {
      const result = await sendVerificationEmail(req.ctx.user!.id, req);
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/verify-email/status',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await verificationStatus(req.ctx.user!.id)));
    }),
  );

  router.post(
    '/verify-email',
    authLimit(),
    asyncRoute(async (req, res) => {
      const token = String(req.body.token ?? '');
      if (!token) throw AppError.badRequest('verification_invalid', 'Missing verification token');
      await verifyEmailToken(token, req);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/google/authorize',
    authLimit(),
    asyncRoute(async (req, res) => {
      const mod = await import('./google.js');
      if (!mod.googleConfigured()) {
        throw AppError.unavailable('google_not_configured', 'Google OAuth is not configured');
      }
      const state = mod.googleStateToken(randomToken(8));
      res.redirect(mod.authorizeUrl(state));
    }),
  );

  router.get(
    '/google/callback',
    authLimit(),
    asyncRoute(async (req, res) => {
      const mod = await import('./google.js');
      const code = String(req.query.code ?? '');
      const state = String(req.query.state ?? '');
      if (!code || !state) throw AppError.badRequest('google_callback_invalid', 'Missing OAuth code or state');
      // Plugin OAuth reuses the SAME Google application + registered redirect
      // URI; the state token identifies the plugin flow (Phase 10).
      const pluginMod = await import('../plugins/engine.js');
      if (pluginMod.isPluginOAuthState(state)) {
        const { pluginOAuthCallback } = await import('../plugins/routes.js');
        const { redirectUrl } = await pluginOAuthCallback(code, state);
        res.redirect(redirectUrl);
        return;
      }
      mod.verifyGoogleState(state);
      const { userId } = await mod.googleCallback(code);
      const modAuth = await import('./service.js');
      const cookieMod = await import('../../middleware/auth.js');
      const token = await mod.createSessionForGoogleUser(userId, req);
      cookieMod.setSessionCookie(res, token);
      res.redirect(`${env.APP_URL}/?google=ok`);
    }),
  );

  return router;
};