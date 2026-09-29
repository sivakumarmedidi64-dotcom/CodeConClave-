/**
 * CodeConClave — auth routes.
 * Signup, login, MFA, recovery, sessions, devices, profile.
 */
import { Router } from 'express';
import { loginSchema, registerSchema, mfaVerifySchema, otpRequestSchema, otpVerifySchema } from '@codeconclave/shared';
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
  updateProfile,
  verifyDevicePairing,
  applyAuthResponse,
  founderAccess,
} from './service.js';
import { requireAuth } from '../../middleware/auth.js';
import { clearSessionCookie, setSessionCookie } from '../../middleware/auth.js';
import { authLimit } from '../../middleware/rate-limit.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { randomToken } from '../../shared/crypto.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { sendVerificationEmail, verifyEmailToken, verificationStatus } from './verification.js';
import { requestOtp, verifyOtp } from './otp.js';
import {
  beginRecovery,
  beginSecurityKeyEnrollment,
  changeKeyword,
  completeIdentityTotpChallenge,
  completeRecovery,
  completeSecurityKeyChallenge,
  confirmSecurityKey,
  disableSecurityKey,
  enrollIdentity,
  getIdentity,
  loginWithKeyword,
  reportSecurityKeyTheft,
  revokeAllSessions,
  rotateSecurityKey,
} from './identity.js';

export const authRoutes = (): Router => {
  const router = Router();

  /**
 * @openapi
 * /api/v1/auth/register:
 *   post:
 *     summary: User registration
 *     description: Register a new user account with email, password, and display name
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, displayName]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *               displayName:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 80
 *     responses:
 *       '201':
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *       '400':
 *         description: Validation error or email already exists
 *       '429':
 *         description: Rate limited
 */
router.post(
    '/register',
    authLimit(),
    asyncRoute(async (req, res) => {
      const input = registerSchema.parse(req.body);
      const result = await register(
        {
          email: input.email,
          password: input.password,
          handle: input.handle,
          keyword: input.keyword,
          displayName: input.displayName,
          role: input.role,
          primaryUseCase: input.primaryUseCase,
        },
        req,
      );
      applyAuthResponse(res, result);
      res.status(201).json(jsonResult({ user: result.user }));
    }),
  );

  /**
 * @openapi
 * /api/v1/auth/login:
 *   post:
 *     summary: User login
 *     description: Authenticate user with email and password. Returns session cookie on success.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *               rememberMe:
 *                 type: boolean
 *     responses:
 *       '200':
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *       '400':
 *         description: Invalid credentials
 *       '429':
 *         description: Rate limited
 */
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
    '/founder-access',
    authLimit(),
    asyncRoute(async (req, res) => {
      const email = String(req.body.email ?? '').trim();
      const password = String(req.body.password ?? '');
      if (!email || !password) throw AppError.badRequest('credentials_required', 'Email and password are required');
      const result = await founderAccess({ email, password }, req);
      if ('mfaRequired' in result) {
        res.json(jsonResult({ mfaRequired: true, challengeToken: result.challengeToken }));
        return;
      }
      applyAuthResponse(res, result);
      res.json(jsonResult({ user: result.user }));
    }),
  );

  router.post(
    '/otp/request',
    authLimit(),
    asyncRoute(async (req, res) => {
      const input = otpRequestSchema.parse(req.body);
      const result = await requestOtp({ email: input.email }, req);
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/otp/verify',
    authLimit(),
    asyncRoute(async (req, res) => {
      const input = otpVerifySchema.parse(req.body);
      const result = await verifyOtp({ email: input.email, code: input.code }, req);
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

  router.patch(
    '/profile',
    requireAuth,
    asyncRoute(async (req, res) => {
      const displayName = req.body.displayName === undefined ? undefined : String(req.body.displayName ?? '');
      if (displayName !== undefined && displayName.trim() === '') {
        throw AppError.badRequest('display_name_empty', 'Display name cannot be empty');
      }
      const role = req.body.role === undefined ? undefined : (req.body.role === null ? null : String(req.body.role));
      const primaryUseCase = req.body.primaryUseCase === undefined ? undefined : (req.body.primaryUseCase === null ? null : String(req.body.primaryUseCase));
      const user = await updateProfile(req.ctx.user!.id, { displayName, role, primaryUseCase });
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

  // ---------------------------------------------------------------- identity
  // D1/D5: handle + keyword is the PRIMARY sign-in path. The legacy
  // email/password, OTP, and Google OAuth routes above stay exactly as they
  // are so no existing user loses access.

  router.get(
    '/identity',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ identity: await getIdentity(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/identity/enroll',
    requireAuth,
    asyncRoute(async (req, res) => {
      const result = await enrollIdentity(req.ctx.user!.id, {
        handle: String(req.body.handle ?? ''),
        keyword: String(req.body.keyword ?? ''),
      });
      res.status(201).json(jsonResult(result));
    }),
  );

  router.post(
    '/identity/login',
    authLimit(),
    asyncRoute(async (req, res) => {
      const result = await loginWithKeyword(
        { handle: String(req.body.handle ?? ''), keyword: String(req.body.keyword ?? '') },
        req,
      );
      if (result.kind === 'mfa_required') {
        // Exactly one method is demanded. preferred_mfa already resolved it.
        res.json(
          jsonResult({
            mfaRequired: true,
            method: result.method,
            challengeToken: result.challengeToken,
          }),
        );
        return;
      }
      setSessionCookie(res, result.sessionToken);
      res.json(jsonResult({ user: await getUserById(result.userId) }));
    }),
  );

  router.post(
    '/identity/mfa/verify',
    authLimit(),
    asyncRoute(async (req, res) => {
      // Completes the `imfa_...` challenge returned by /identity/login. TOTP is
      // verified exactly as the legacy path does; recovery codes are accepted
      // for parity so a TOTP-only identity user is never locked out.
      const result = await completeIdentityTotpChallenge(
        String(req.body.challengeToken ?? ''),
        {
          code: req.body.code === undefined ? undefined : String(req.body.code),
          recoveryCode: req.body.recoveryCode === undefined ? undefined : String(req.body.recoveryCode),
        },
        req,
      );
      setSessionCookie(res, result.sessionToken);
      res.json(jsonResult({ user: await getUserById(result.userId), via: result.via }));
    }),
  );

  router.post(
    '/identity/keyword',
    requireAuth,
    asyncRoute(async (req, res) => {
      const result = await changeKeyword(
        req.ctx.user!.id,
        {
          currentKeyword: String(req.body.currentKeyword ?? ''),
          newKeyword: String(req.body.newKeyword ?? ''),
        },
        req,
      );
      // A keyword change revokes every session, including this one, so the
      // caller must sign in again.
      clearSessionCookie(res);
      res.json(jsonResult(result));
    }),
  );

  // ------------------------------------------------------- security key (B4)
  // The key is a SECOND FACTOR that coexists with TOTP, not a replacement.
  // When a user has both, preferred_mfa decides which one is demanded.

  router.post(
    '/security-key/enroll',
    requireAuth,
    asyncRoute(async (req, res) => {
      const preferred = req.body.preferredMfa === 'totp' ? 'totp' : 'security_key';
      const result = await beginSecurityKeyEnrollment(req.ctx.user!.id, preferred);
      // Shown exactly once. Only the hash was persisted.
      res.status(201).json(jsonResult(result));
    }),
  );

  router.post(
    '/security-key/confirm',
    requireAuth,
    asyncRoute(async (req, res) => {
      const result = await confirmSecurityKey(req.ctx.user!.id, String(req.body.securityKey ?? ''));
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/security-key/disable',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await disableSecurityKey(req.ctx.user!.id)));
    }),
  );

  router.post(
    '/security-key/rotate',
    requireAuth,
    asyncRoute(async (req, res) => {
      const preferred = req.body.preferredMfa === 'totp' ? 'totp' : 'security_key';
      const result = await rotateSecurityKey(
        req.ctx.user!.id,
        String(req.body.currentSecurityKey ?? ''),
        preferred,
      );
      // Rotation invalidates the old key and requires paste-back confirmation,
      // so the new key is returned once and must be confirmed to take effect.
      res.status(201).json(jsonResult(result));
    }),
  );

  router.post(
    '/security-key/report-stolen',
    requireAuth,
    asyncRoute(async (req, res) => {
      const result = await reportSecurityKeyTheft(
        req.ctx.user!.id,
        String(req.body.currentKeyword ?? ''),
        req,
      );
      // Every session is revoked by a theft report, including the caller's.
      clearSessionCookie(res);
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/security-key/verify',
    authLimit(),
    asyncRoute(async (req, res) => {
      const result = await completeSecurityKeyChallenge(
        String(req.body.challengeToken ?? ''),
        String(req.body.securityKey ?? ''),
        req,
      );
      setSessionCookie(res, result.sessionToken);
      res.json(jsonResult({ user: await getUserById(result.userId) }));
    }),
  );

  // ---------------------------------------------------------------- recovery
  // There is no email-based password reset. Recovery requires handle + the
  // Security Key, returns a short-lived single-use token, and revokes all
  // sessions on completion.

  router.post(
    '/recovery/start',
    authLimit(),
    asyncRoute(async (req, res) => {
      const result = await beginRecovery({
        handle: String(req.body.handle ?? ''),
        securityKey: String(req.body.securityKey ?? ''),
      });
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/recovery/complete',
    authLimit(),
    asyncRoute(async (req, res) => {
      const result = await completeRecovery(
        {
          recoveryToken: String(req.body.recoveryToken ?? ''),
          keyword: String(req.body.keyword ?? ''),
        },
        req,
      );
      setSessionCookie(res, result.sessionToken);
      res.json(jsonResult({ user: await getUserById(result.userId) }));
    }),
  );

  // Sign out everywhere. Required because every other credential-change and
  // theft-report path revokes all sessions, so a user must be able to do the
  // same on demand.
  router.post(
    '/sessions/revoke-all',
    requireAuth,
    asyncRoute(async (req, res) => {
      const revoked = await revokeAllSessions(req.ctx.user!.id);
      clearSessionCookie(res);
      res.json(jsonResult({ revoked }));
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
      const errorParam = String(req.query.error ?? '');
      const appUrl = env.APP_URL || '/';
      if (errorParam) {
        logger.warn('google.oauth_denied', { error: errorParam });
        res.redirect(`${appUrl}?google=error=${encodeURIComponent(errorParam)}`);
        return;
      }
      if (!code || !state) {
        logger.warn('google.callback_missing_params');
        res.redirect(`${appUrl}?google=error=missing_params`);
        return;
      }
      // Plugin OAuth reuses the SAME Google application + registered redirect
      // URI; the state token identifies the plugin flow (Phase 10).
      const pluginMod = await import('../plugins/engine.js');
      if (pluginMod.isPluginOAuthState(state)) {
        const { pluginOAuthCallback } = await import('../plugins/routes.js');
        const { redirectUrl } = await pluginOAuthCallback(code, state);
        res.redirect(redirectUrl);
        return;
      }
      try {
        mod.verifyGoogleState(state);
        const { userId } = await mod.googleCallback(code);
        const cookieMod = await import('../../middleware/auth.js');
        const token = await mod.createSessionForGoogleUser(userId, req);
        cookieMod.setSessionCookie(res, token);
        res.redirect(`${appUrl}/?google=ok`);
      } catch (err: any) {
        const code = err?.errorCode ?? err?.code ?? 'google_callback_failed';
        logger.error('google.callback_failed', { err: String(err?.message ?? err), code });
        res.redirect(`${appUrl}?google=error=${encodeURIComponent(code)}`);
      }
    }),
  );

  return router;
};