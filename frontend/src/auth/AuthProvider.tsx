/**
 * CodeConClave — session bootstrap + auth actions.
 *
 * Two login paths live side by side on purpose:
 *   - `login`/`register`  : legacy email + password. `users.email` is a contact
 *     LABEL, not the primary credential.
 *   - `loginWithHandle`   : D1 primary credentials, handle + keyword, with an
 *     optional second factor and a no-email recovery path.
 * The legacy path is retained because removing it would lock out existing
 * accounts; nothing in the new path may assume the old one was used.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { User } from '../lib/types';

export class MfaRequiredError extends Error {
  readonly challengeToken: string;
  readonly method: 'totp' | 'security_key' | null;
  readonly reason: string | null;
  constructor(challengeToken: string, method: 'totp' | 'security_key' | null = null, reason: string | null = null) {
    super('MFA required');
    this.challengeToken = challengeToken;
    this.method = method;
    this.reason = reason;
  }
}

/** `preferred_mfa` decides which single factor is demanded when both exist. */
export type PreferredMfa = 'totp' | 'security_key';

export interface EnrolledIdentity {
  handle: string;
  securityKeyEnabled: boolean;
  preferredMfa: 'none' | PreferredMfa;
  createdAt?: string;
}

interface AuthContextValue {
  status: 'loading' | 'anon' | 'authed';
  user: User | null;
  refresh: () => Promise<void>;
  login: (email: string, password: string, remember?: boolean) => Promise<User | 'mfa'>;
  founderAccess: (email: string, password: string) => Promise<User | 'mfa'>;
  requestOtp: (email: string) => Promise<{ sent: boolean; resendableAfterMs: number; expiresInSeconds: number }>;
  verifyOtp: (email: string, code: string) => Promise<User>;
  verifyMfa: (challengeToken: string, code?: string, recoveryCode?: string, rememberDevice?: boolean) => Promise<User>;
  register: (email: string, password: string, displayName?: string, onboarding?: { role?: string; primaryUseCase?: string }, identity?: { handle: string; keyword: string }) => Promise<{ user: User; securityKey?: string }>;
  logout: () => Promise<void>;
  updateProfile: (input: { displayName?: string | null; role?: string | null; primaryUseCase?: string | null }) => Promise<User>;
  sendVerificationEmail: () => Promise<{ sent: boolean; alreadyVerified: boolean }>;
  verifyEmail: (token: string) => Promise<void>;
  verificationStatus: () => Promise<VerificationStatus>;
  // ---- D1 identity (handle + keyword) ----
  getIdentity: () => Promise<EnrolledIdentity | null>;
  enrollIdentity: (handle: string, keyword: string) => Promise<EnrolledIdentity>;
  loginWithHandle: (handle: string, keyword: string) => Promise<User | 'mfa'>;
  verifyIdentityMfa: (challengeToken: string, input: { code?: string; recoveryCode?: string }) => Promise<User>;
  verifySecurityKeyChallenge: (challengeToken: string, securityKey: string) => Promise<User>;
  changeKeyword: (currentKeyword: string, newKeyword: string) => Promise<void>;
  beginRecovery: (handle: string, securityKey: string) => Promise<string>;
  completeRecovery: (recoveryToken: string, keyword: string) => Promise<User>;
  // ---- Security Key (optional second factor / recovery factor) ----
  beginSecurityKeyEnroll: (preferredMfa: PreferredMfa) => Promise<string>;
  confirmSecurityKey: (securityKey: string) => Promise<void>;
  rotateSecurityKey: (currentSecurityKey: string, preferredMfa: PreferredMfa) => Promise<string>;
  disableSecurityKey: () => Promise<void>;
  reportSecurityKeyTheft: (currentKeyword: string) => Promise<void>;
  revokeAllSessions: () => Promise<number>;
}

export interface VerificationStatus {
  emailVerified: boolean;
  lastSentAt: string | null;
  lastExpiresAt: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'anon' | 'authed'>('loading');
  const [user, setUser] = useState<User | null>(null);
  const demoLoginAttempted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User }>('/api/v1/auth/me');
      setUser(me.user);
      setStatus('authed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // TEMPORARY DEMO / EARLY ACCESS: with no session, try the silent demo
        // sign-in so the app opens straight into the workspace with no email,
        // password or registration. The server only honours it while its
        // temporary-demo flag is on — otherwise it 404s and this stays truly
        // anonymous, so production behaviour is unchanged. Attempt once per
        // provider instance to avoid a retry loop.
        if (!demoLoginAttempted.current) {
          demoLoginAttempted.current = true;
          try {
            const res = await api<{ user: User }>('/api/v1/auth/demo-login', { method: 'POST' });
            if (res.user) {
              setUser(res.user);
              setStatus('authed');
              return;
            }
          } catch {
            /* not a demo deployment — fall through to anonymous */
          }
        }
        setUser(null);
        setStatus('anon');
        return;
      }
      setUser(null);
      setStatus('anon');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string, remember?: boolean) => {
    const res = await api<{ user?: User; mfaRequired?: boolean; challengeToken?: string }>(
      '/api/v1/auth/login',
      { method: 'POST', body: { email, password, remember } },
    );
    if (res.mfaRequired && res.challengeToken) {
      throw new MfaRequiredError(res.challengeToken);
    }
    const u = res.user;
    if (!u) throw new Error('Unexpected login response');
    setUser(u);
    setStatus('authed');
    return u;
  }, []);

  const founderAccess = useCallback(async (email: string, password: string) => {
    const res = await api<{ user?: User; mfaRequired?: boolean; challengeToken?: string }>(
      '/api/v1/auth/founder-access',
      { method: 'POST', body: { email, password } },
    );
    if (res.mfaRequired && res.challengeToken) {
      throw new MfaRequiredError(res.challengeToken);
    }
    const u = res.user;
    if (!u) throw new Error('Unexpected founder access response');
    setUser(u);
    setStatus('authed');
    return u;
  }, []);

  const requestOtp = useCallback(async (email: string) => {
    return api<{ sent: boolean; resendableAfterMs: number; expiresInSeconds: number }>('/api/v1/auth/otp/request', {
      method: 'POST',
      body: { email },
    });
  }, []);

  const verifyOtp = useCallback(async (email: string, code: string) => {
    const res = await api<{ user?: User; mfaRequired?: boolean; challengeToken?: string }>('/api/v1/auth/otp/verify', {
      method: 'POST',
      body: { email, code },
    });
    if (res.mfaRequired && res.challengeToken) {
      throw new MfaRequiredError(res.challengeToken);
    }
    const u = res.user;
    if (!u) throw new Error('Unexpected OTP verify response');
    setUser(u);
    setStatus('authed');
    return u;
  }, []);

  const verifyMfa = useCallback(
    async (challengeToken: string, code?: string, recoveryCode?: string, rememberDevice?: boolean) => {
      const res = await api<{ user: User }>('/api/v1/auth/mfa/verify', {
        method: 'POST',
        body: { challengeToken, code, recoveryCode, rememberDevice },
      });
      setUser(res.user);
      setStatus('authed');
      return res.user;
    },
    [],
  );

  const register = useCallback(async (email: string, password: string, displayName?: string, onboarding?: { role?: string; primaryUseCase?: string }, identity?: { handle: string; keyword: string }) => {
    const res = await api<{ user: User; securityKey?: string }>('/api/v1/auth/register', {
      method: 'POST',
      body: { email, password, displayName, role: onboarding?.role, primaryUseCase: onboarding?.primaryUseCase, ...(identity ? { handle: identity.handle, keyword: identity.keyword } : {}) },
    });
    setUser(res.user);
    setStatus('authed');
    // securityKey (when present) is shown exactly once by the caller and
    // never persisted client-side.
    return { user: res.user, ...(res.securityKey ? { securityKey: res.securityKey } : {}) };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // The server session may already be revoked; local state must still clear.
    } finally {
      setUser(null);
      setStatus('anon');
    }
  }, []);

  const updateProfile = useCallback(async (input: { displayName?: string | null; role?: string | null; primaryUseCase?: string | null }) => {
    const res = await api<{ user: User }>('/api/v1/auth/profile', {
      method: 'PATCH',
      body: input,
    });
    setUser(res.user);
    return res.user;
  }, []);

  const sendVerificationEmail = useCallback(async () => {
    const res = await api<{ sent: boolean; alreadyVerified: boolean }>('/api/v1/auth/verify-email/send', {
      method: 'POST',
    });
    if (res.alreadyVerified) {
      const me = await api<{ user: User }>('/api/v1/auth/me');
      setUser(me.user);
    }
    return res;
  }, []);

  const verifyEmail = useCallback(async (token: string) => {
    await api('/api/v1/auth/verify-email', { method: 'POST', body: { token } });
    try {
      const me = await api<{ user: User }>('/api/v1/auth/me');
      setUser(me.user);
      setStatus('authed');
    } catch {
      // Anonymous verification is fine — the server already marked the email.
    }
  }, []);

  const verificationStatus = useCallback(async () => {
    return api<VerificationStatus>('/api/v1/auth/verify-email/status');
  }, []);

  // ---------------------------------------------------------------- D1 identity

  const getIdentity = useCallback(async () => {
    const res = await api<{ identity: EnrolledIdentity | null }>('/api/v1/auth/identity');
    return res.identity;
  }, []);

  const enrollIdentity = useCallback(async (handle: string, keyword: string) => {
    const res = await api<{ identity: EnrolledIdentity }>('/api/v1/auth/identity/enroll', {
      method: 'POST',
      body: { handle, keyword },
    });
    return res.identity;
  }, []);

  const loginWithHandle = useCallback(async (handle: string, keyword: string) => {
    const res = await api<{ user?: User; mfaRequired?: boolean; challengeToken?: string; method?: PreferredMfa | null; reason?: string }>(
      '/api/v1/auth/identity/login',
      { method: 'POST', body: { handle, keyword } },
    );
    // Exactly one method is demanded, chosen server-side by preferred_mfa. The
    // client must not choose: asking for a factor the account did not register
    // is a dead end, and asking for both defeats the rule.
    if (res.mfaRequired && res.challengeToken) {
      throw new MfaRequiredError(res.challengeToken, res.method ?? null, res.reason ?? null);
    }
    const u = res.user;
    if (!u) throw new Error('Unexpected identity login response');
    setUser(u);
    setStatus('authed');
    return u;
  }, []);

  const verifySecurityKeyChallenge = useCallback(async (challengeToken: string, securityKey: string) => {
    // Completes an unknown-device / security-key challenge. Same single-use
    // semantics as verifyIdentityMfa: the challenge burns on first use.
    const res = await api<{ user: User }>('/api/v1/auth/security-key/verify', {
      method: 'POST',
      body: { challengeToken, securityKey },
    });
    setUser(res.user);
    setStatus('authed');
    return res.user;
  }, []);

  const verifyIdentityMfa = useCallback(
    async (challengeToken: string, input: { code?: string; recoveryCode?: string }) => {
      // The `imfa_` challenge is single-use: it is burned by this request
      // whether the code is right or wrong, so a failed attempt cannot be
      // retried with a new guess on the same token. A rejected code therefore
      // means starting the login over, which is what the UI must show.
      const res = await api<{ user: User }>('/api/v1/auth/identity/mfa/verify', {
        method: 'POST',
        body: { challengeToken, code: input.code, recoveryCode: input.recoveryCode },
      });
      setUser(res.user);
      setStatus('authed');
      return res.user;
    },
    [],
  );

  const changeKeyword = useCallback(async (currentKeyword: string, newKeyword: string) => {
    await api('/api/v1/auth/identity/keyword', {
      method: 'POST',
      body: { currentKeyword, newKeyword },
    });
    // The server revokes EVERY session, this one included, so local auth state
    // must go rather than linger on a cookie that is already dead.
    setUser(null);
    setStatus('anon');
  }, []);

  const beginRecovery = useCallback(async (handle: string, securityKey: string) => {
    const res = await api<{ recoveryToken: string }>('/api/v1/auth/recovery/start', {
      method: 'POST',
      body: { handle, securityKey },
    });
    return res.recoveryToken;
  }, []);

  const completeRecovery = useCallback(async (recoveryToken: string, keyword: string) => {
    const res = await api<{ user: User }>('/api/v1/auth/recovery/complete', {
      method: 'POST',
      body: { recoveryToken, keyword },
    });
    setUser(res.user);
    setStatus('authed');
    return res.user;
  }, []);

  // ---------------------------------------------------------------- security key

  const beginSecurityKeyEnroll = useCallback(async (preferredMfa: PreferredMfa) => {
    const res = await api<{ securityKey: string }>('/api/v1/auth/security-key/enroll', {
      method: 'POST',
      body: { preferredMfa },
    });
    // Shown exactly once. The UI must NOT persist this anywhere.
    return res.securityKey;
  }, []);

  const confirmSecurityKey = useCallback(async (securityKey: string) => {
    await api('/api/v1/auth/security-key/confirm', { method: 'POST', body: { securityKey } });
  }, []);

  const rotateSecurityKey = useCallback(async (currentSecurityKey: string, preferredMfa: PreferredMfa) => {
    const res = await api<{ securityKey: string }>('/api/v1/auth/security-key/rotate', {
      method: 'POST',
      body: { currentSecurityKey, preferredMfa },
    });
    return res.securityKey;
  }, []);

  const disableSecurityKey = useCallback(async () => {
    await api('/api/v1/auth/security-key/disable', { method: 'POST' });
  }, []);

  const reportSecurityKeyTheft = useCallback(async (currentKeyword: string) => {
    try {
      await api('/api/v1/auth/security-key/report-stolen', { method: 'POST', body: { currentKeyword } });
    } finally {
      // Every session is revoked server-side, including the caller's.
      setUser(null);
      setStatus('anon');
    }
  }, []);

  const revokeAllSessions = useCallback(async () => {
    const res = await api<{ revoked: number }>('/api/v1/auth/sessions/revoke-all', { method: 'POST' });
    setUser(null);
    setStatus('anon');
    return res.revoked;
  }, []);

  const value = useMemo(
    () => ({
      status,
      user,
      refresh,
      login,
      founderAccess,
      requestOtp,
      verifyOtp,
      verifyMfa,
      register,
      logout,
      updateProfile,
      sendVerificationEmail,
      verifyEmail,
      verificationStatus,
      getIdentity,
      enrollIdentity,
      loginWithHandle,
      verifyIdentityMfa,
      verifySecurityKeyChallenge,
      changeKeyword,
      beginRecovery,
      completeRecovery,
      beginSecurityKeyEnroll,
      confirmSecurityKey,
      rotateSecurityKey,
      disableSecurityKey,
      reportSecurityKeyTheft,
      revokeAllSessions,
    }),
    [
      status, user, refresh, login, founderAccess, requestOtp, verifyOtp, verifyMfa, register, logout,
      updateProfile, sendVerificationEmail, verifyEmail, verificationStatus, getIdentity, enrollIdentity,
      loginWithHandle, verifyIdentityMfa, verifySecurityKeyChallenge, changeKeyword, beginRecovery, completeRecovery,
      beginSecurityKeyEnroll, confirmSecurityKey, rotateSecurityKey, disableSecurityKey,
      reportSecurityKeyTheft, revokeAllSessions,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}