/**
 * CodeConClave — session bootstrap + auth actions.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { User } from '../lib/types';

export class MfaRequiredError extends Error {
  readonly challengeToken: string;
  constructor(challengeToken: string) {
    super('MFA required');
    this.challengeToken = challengeToken;
  }
}

interface AuthContextValue {
  status: 'loading' | 'anon' | 'authed';
  user: User | null;
  refresh: () => Promise<void>;
  login: (email: string, password: string, remember?: boolean) => Promise<User | 'mfa'>;
  verifyMfa: (challengeToken: string, code?: string, recoveryCode?: string, rememberDevice?: boolean) => Promise<User>;
  register: (email: string, password: string, displayName?: string) => Promise<User>;
  logout: () => Promise<void>;
  sendVerificationEmail: () => Promise<{ sent: boolean; alreadyVerified: boolean }>;
  verifyEmail: (token: string) => Promise<void>;
  verificationStatus: () => Promise<VerificationStatus>;
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

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User }>('/api/v1/auth/me');
      setUser(me.user);
      setStatus('authed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setStatus('anon');
        return;
      }
      setUser(null);
      setStatus('anon');
    }
  }, []);

  // Google OAuth callback: the backend redirects to /?google=ok after
  // completing the exchange. Restore the session and clean the marker —
  // the URL is never used as proof of authentication (server cookie is).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('google') === 'ok') {
      window.history.replaceState({}, '', window.location.pathname);
      void refresh();
    }
  }, [refresh]);

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

  const register = useCallback(async (email: string, password: string, displayName?: string) => {
    const res = await api<{ user: User }>('/api/v1/auth/register', {
      method: 'POST',
      body: { email, password, displayName },
    });
    setUser(res.user);
    setStatus('authed');
    return res.user;
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

  const value = useMemo(
    () => ({
      status,
      user,
      refresh,
      login,
      verifyMfa,
      register,
      logout,
      sendVerificationEmail,
      verifyEmail,
      verificationStatus,
    }),
    [status, user, refresh, login, verifyMfa, register, logout, sendVerificationEmail, verifyEmail, verificationStatus],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}