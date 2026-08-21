/**
 * CodeConClave — AuthProvider tests (PHASE 2).
 * Session restoration, login (incl. MFA challenge), logout, email
 * verification, and Google OAuth callback handling. fetch is mocked;
 * nothing here depends on a real backend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth, MfaRequiredError } from './AuthProvider';
import type { User } from '../lib/types';

const USER: User = {
  id: 'u1',
  email: 'alice@example.com',
  emailVerified: false,
  displayName: 'Alice',
  avatarUrl: null,
  mfaEnabled: false,
  rbacRole: 'member',
  planId: 'free',
  entitlementState: 'FREE',
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

function setupFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(handler);
  vi.stubGlobal('fetch', fn);
  return fn;
}

type AuthState = { status: string; user: User | null };
function Probe({ onState }: { onState: (s: AuthState) => void }) {
  const { status, user } = useAuth();
  onState({ status, user });
  return null;
}

/** Single AuthProvider harness so actions and the observed state share context. */
function renderHarness(
  url: string,
  children: ReactNode,
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  window.history.replaceState({}, '', url);
  let state: AuthState = { status: 'loading', user: null };
  const probe = vi.fn((s: AuthState) => {
    state = s;
  });
  const fetchFn = setupFetch(handler);
  render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <Probe onState={probe} />
        {children}
      </AuthProvider>
    </MemoryRouter>,
  );
  return { fetchFn, probe, getState: () => state };
}

function LoginButton({ email = 'alice@example.com', password = 'Secret123!' }: { email?: string; password?: string }) {
  const { login } = useAuth();
  return (
    <button
      onClick={async () => {
        try {
          await login(email, password);
        } catch {
          /* surfaced by caller */
        }
      }}
    >
      go
    </button>
  );
}

function MfaLoginButton({ onError }: { onError: (e: unknown) => void }) {
  const { login } = useAuth();
  return (
    <button
      onClick={async () => {
        try {
          await login('alice@example.com', 'Secret123!');
        } catch (err) {
          onError(err);
        }
      }}
    >
      go
    </button>
  );
}

function LogoutButton() {
  const { logout } = useAuth();
  return (
    <button
      onClick={async () => {
        await logout();
      }}
    >
      out
    </button>
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('session restoration', () => {
  it('restores an authenticated session from /auth/me', async () => {
    const { getState } = renderHarness('/home', null, async (url) =>
      url.includes('/auth/me') ? jsonResponse({ data: { user: USER } }) : jsonResponse({ data: {} }),
    );
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    expect(getState()?.user?.email).toBe('alice@example.com');
  });

  it('treats a 401 /me as anonymous (never crashes)', async () => {
    const { getState } = renderHarness('/home', null, async (url) =>
      url.includes('/auth/me')
        ? jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401)
        : jsonResponse({ data: {} }),
    );
    await waitFor(() => expect(getState()?.status).toBe('anon'));
    expect(getState()?.user).toBeNull();
  });
});

describe('login / logout', () => {
  it('logs in with valid credentials and stores the user', async () => {
    const { fetchFn } = renderHarness(
      '/login',
      <LoginButton />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/login')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ email: 'alice@example.com', password: 'Secret123!' });
          return jsonResponse({ data: { user: USER } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('go')).toBeInTheDocument());
    screen.getByText('go').click();
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST' })),
    );
  });

  it('raises MfaRequiredError when the server demands MFA', async () => {
    let error: unknown = null;
    renderHarness(
      '/login',
      <MfaLoginButton onError={(e) => (error = e)} />,
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/login')) return jsonResponse({ data: { mfaRequired: true, challengeToken: 'mfa_ch.zz' } });
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('go')).toBeInTheDocument());
    screen.getByText('go').click();
    await waitFor(() => expect(error).toBeInstanceOf(MfaRequiredError));
    expect((error as MfaRequiredError).challengeToken).toBe('mfa_ch.zz');
  });

  it('clears the session on logout even if the API call fails', async () => {
    const { getState } = renderHarness(
      '/home',
      <LogoutButton />,
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/auth/logout')) return jsonResponse({ error: { code: 'http_error', message: 'boom' } }, 500);
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    await waitFor(() => expect(screen.getByText('out')).toBeInTheDocument());
    screen.getByText('out').click();
    await waitFor(() => expect(getState()?.status).toBe('anon'));
  });
});

describe('email verification', () => {
  it('verifyEmail verifies server-side and refreshes the user (unverified → verified)', async () => {
    const verifiedUser = { ...USER, emailVerified: true };
    const { getState } = renderHarness(
      '/',
      <VerifyButton />,
      async (url) => {
        if (url.includes('/auth/verify-email') && !url.includes('/send') && !url.includes('/status')) {
          return jsonResponse({ data: { ok: true } });
        }
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: verifiedUser } });
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('verify')).toBeInTheDocument());
    screen.getByText('verify').click();
    await waitFor(() => expect(getState()?.user?.emailVerified).toBe(true));
  });

  it('does not fail anonymous verification (email link clicked while logged out)', async () => {
    let resolved = false;
    const { getState } = renderHarness(
      '/',
      <VerifyButton onDone={() => (resolved = true)} />,
      async (url) => {
        if (url.includes('/auth/verify-email') && !url.includes('/send') && !url.includes('/status')) {
          return jsonResponse({ data: { ok: true } });
        }
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('verify')).toBeInTheDocument());
    screen.getByText('verify').click();
    await waitFor(() => expect(resolved).toBe(true));
    expect(getState()?.status).toBe('anon');
  });
});

function VerifyButton({ onDone }: { onDone?: () => void }) {
  const { verifyEmail } = useAuth();
  return (
    <button
      onClick={async () => {
        await verifyEmail('tok123');
        onDone?.();
      }}
    >
      verify
    </button>
  );
}

describe('Google OAuth callback', () => {
  it('handles ?google=ok: restores the session and cleans the URL marker', async () => {
    const { getState } = renderHarness('/?google=ok', null, async (url) =>
      url.includes('/auth/me') ? jsonResponse({ data: { user: USER } }) : jsonResponse({ data: {} }),
    );
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    await waitFor(() => expect(window.location.search).not.toContain('google'));
  });
});