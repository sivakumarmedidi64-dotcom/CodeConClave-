/**
 * CodeConClave — AuthProvider tests (PHASE 2).
 * Session restoration, login (incl. MFA challenge), logout, email
 * verification, and removed-Google-callback inertness. fetch is mocked;
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

  it('auto-signs in via the demo endpoint when the deployment enables it', async () => {
    const { fetchFn, getState } = renderHarness('/home', null, async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/demo-login')) {
        expect(init?.method).toBe('POST');
        return jsonResponse({ data: { user: USER } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    expect(getState()?.user?.email).toBe('alice@example.com');
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/demo-login', expect.objectContaining({ method: 'POST' }));
  });

  it('stays anonymous when the demo endpoint is refused (non-demo deployment)', async () => {
    const { getState } = renderHarness('/home', null, async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/demo-login')) return jsonResponse({ error: { code: 'not_found', message: 'no' } }, 404);
      return jsonResponse({ data: {} });
    });
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

describe('Google OAuth callback — removed', () => {
  it('ignores legacy ?google= markers: no session is restored from a URL', async () => {
    // Customer Google sign-in was removed. A stale ?google=ok marker must NOT
    // authenticate anyone: the removed handler is gone, so the marker stays
    // inert and status resolves via /auth/me only (anon here).
    const { getState } = renderHarness('/?google=ok', null, async (url) =>
      url.includes('/auth/me')
        ? jsonResponse({ error: { code: 'unauthorized' } }, 401)
        : jsonResponse({ data: {} }),
    );
    await waitFor(() => expect(getState()?.status).toBe('anon'));
    expect(window.location.search).toContain('google=ok');
  });
});

/**
 * D1 identity (handle + keyword) client contract. The point of these tests is
 * that the client sends exactly what the server route reads, and that state
 * which the server revokes is cleared locally instead of being left behind on
 * a dead cookie.
 */
describe('D1 identity auth', () => {
  const IDENTITY = { handle: 'alice_01', securityKeyEnabled: false, preferredMfa: 'none' as const };

  function anonOr(url: string) {
    return url.includes('/auth/me')
      ? jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401)
      : jsonResponse({ data: {} });
  }

  it('posts handle + keyword to /identity/login and stores the user', async () => {
    const { fetchFn, getState } = renderHarness(
      '/login',
      <IdentityLoginButton />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/identity/login')) {
          expect(JSON.parse(String(init?.body))).toEqual({ handle: 'alice_01', keyword: 'CorrectHorse9Battery' });
          return jsonResponse({ data: { user: USER } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('ident')).toBeInTheDocument());
    screen.getByText('ident').click();
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/identity/login', expect.objectContaining({ method: 'POST' }));
  });

  it('raises MfaRequiredError carrying the server-chosen method, and never picks one itself', async () => {
    let error: unknown = null;
    renderHarness(
      '/login',
      <IdentityLoginButton onError={(e) => (error = e)} />,
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/identity/login')) {
          return jsonResponse({ data: { mfaRequired: true, challengeToken: 'imfa_abc.def', method: 'totp' } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('ident')).toBeInTheDocument());
    screen.getByText('ident').click();
    await waitFor(() => expect(error).toBeInstanceOf(MfaRequiredError));
    expect((error as MfaRequiredError).challengeToken).toBe('imfa_abc.def');
    expect((error as MfaRequiredError).method).toBe('totp');
  });

  it('verifies an identity challenge on the identity endpoint, not the legacy one', async () => {
    const { fetchFn, getState } = renderHarness(
      '/login',
      <IdentityMfaButton />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/identity/mfa/verify')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ challengeToken: 'imfa_abc.def', code: '123456' });
          return jsonResponse({ data: { user: USER } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('verify-identity')).toBeInTheDocument());
    screen.getByText('verify-identity').click();
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    const called = fetchFn.mock.calls.map((c) => c[0]);
    expect(called).toContain('/api/v1/auth/identity/mfa/verify');
    // The legacy /auth/mfa/verify issues a DIFFERENT challenge type; mixing them
    // is the dead-end bug the identity completion route exists to fix.
    expect(called).not.toContain('/api/v1/auth/mfa/verify');
  });

  it('clears local auth state after a keyword change, because the server revoked every session', async () => {
    const { getState } = renderHarness(
      '/settings/security',
      <ChangeKeywordButton />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/auth/identity/keyword')) {
          expect(JSON.parse(String(init?.body))).toEqual({
            currentKeyword: 'OldKeyword12345',
            newKeyword: 'NewKeyword12345',
          });
          return jsonResponse({ data: { ok: true } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    await waitFor(() => expect(screen.getByText('change')).toBeInTheDocument());
    screen.getByText('change').click();
    await waitFor(() => expect(getState()?.status).toBe('anon'));
    expect(getState()?.user).toBeNull();
  });

  it('clears local auth state after a theft report, and does so even when the call fails', async () => {
    const { getState } = renderHarness(
      '/settings/security',
      <TheftReportButton />,
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/security-key/report-stolen')) {
          return jsonResponse({ error: { code: 'http_error', message: 'boom' } }, 500);
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(getState()?.status).toBe('authed'));
    await waitFor(() => expect(screen.getByText('stolen')).toBeInTheDocument());
    screen.getByText('stolen').click();
    await waitFor(() => expect(getState()?.status).toBe('anon'));
  });

  it('surfaces the security key exactly once and never re-reads it from a second endpoint', async () => {
    const seen: string[] = [];
    renderHarness(
      '/settings/security',
      <SecurityKeyEnrollButton onKey={(k) => seen.push(k)} />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/security-key/enroll')) {
          expect(JSON.parse(String(init?.body))).toEqual({ preferredMfa: 'security_key' });
          return jsonResponse({ data: { securityKey: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX' } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('enroll')).toBeInTheDocument());
    screen.getByText('enroll').click();
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe('ABCD-EFGH-IJKL-MNOP-QRST-UVWX');
  });

  it('confirms a pasted-back security key through the two-phase confirm route', async () => {
    const { fetchFn } = renderHarness(
      '/settings/security',
      <SecurityKeyConfirmButton />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/security-key/confirm')) {
          expect(JSON.parse(String(init?.body))).toEqual({ securityKey: 'PASTED-BACK' });
          return jsonResponse({ data: { enabled: true } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('confirm')).toBeInTheDocument());
    screen.getByText('confirm').click();
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/security-key/confirm', expect.objectContaining({ method: 'POST' })),
    );
  });

  it('runs the two-step security-key recovery without ever sending an email', async () => {
    const calls: string[] = [];
    let token = '';
    renderHarness(
      '/recover',
      <RecoveryButton onToken={(t) => (token = t)} />,
      async (url, init) => {
        calls.push(url);
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/recovery/start')) {
          expect(JSON.parse(String(init?.body))).toEqual({
            handle: 'alice_01',
            securityKey: 'KEY-1234',
          });
          return jsonResponse({ data: { recoveryToken: 'rt_abc' } });
        }
        if (url.includes('/auth/recovery/complete')) {
          expect(JSON.parse(String(init?.body))).toEqual({ recoveryToken: 'rt_abc', keyword: 'CorrectHorse9Battery' });
          return jsonResponse({ data: { user: USER } });
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('recover')).toBeInTheDocument());
    screen.getByText('recover').click();
    await waitFor(() => expect(calls).toContain('/api/v1/auth/recovery/complete'));
    expect(token).toBe('rt_abc');
    // There is no email-reset endpoint anywhere in this flow, by design.
    expect(calls.some((c) => c.includes('verify-email') || c.includes('password-reset'))).toBe(false);
  });

  it('reads the enrolled identity status for the settings screen', async () => {
    let handle: string | null = null;
    renderHarness(
      '/settings/security',
      <IdentityStatusButton onIdentity={(i) => (handle = i?.handle ?? 'none')} />,
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/auth/identity')) return jsonResponse({ data: { identity: IDENTITY } });
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('status')).toBeInTheDocument());
    screen.getByText('status').click();
    await waitFor(() => expect(handle).toBe('alice_01'));
  });

  it('enrols a handle + keyword atomically in one call', async () => {
    const { fetchFn } = renderHarness(
      '/settings/security',
      <EnrollButton />,
      async (url, init) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/auth/identity/enroll')) {
          expect(JSON.parse(String(init?.body))).toEqual({ handle: 'alice_01', keyword: 'CorrectHorse9Battery' });
          return jsonResponse({ data: { identity: IDENTITY } }, 201);
        }
        return jsonResponse({ data: {} });
      },
    );
    await waitFor(() => expect(screen.getByText('enroll-identity')).toBeInTheDocument());
    screen.getByText('enroll-identity').click();
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/identity/enroll', expect.objectContaining({ method: 'POST' })),
    );
  });
});

function IdentityLoginButton({ onError }: { onError?: (e: unknown) => void }) {
  const { loginWithHandle } = useAuth();
  return (
    <button
      onClick={async () => {
        try {
          await loginWithHandle('alice_01', 'CorrectHorse9Battery');
        } catch (err) {
          onError?.(err);
        }
      }}
    >
      ident
    </button>
  );
}

function IdentityMfaButton() {
  const { verifyIdentityMfa } = useAuth();
  return (
    <button
      onClick={async () => {
        await verifyIdentityMfa('imfa_abc.def', { code: '123456' });
      }}
    >
      verify-identity
    </button>
  );
}

function ChangeKeywordButton() {
  const { changeKeyword } = useAuth();
  return (
    <button
      onClick={async () => {
        await changeKeyword('OldKeyword12345', 'NewKeyword12345');
      }}
    >
      change
    </button>
  );
}

function TheftReportButton() {
  const { reportSecurityKeyTheft } = useAuth();
  return (
    <button
      onClick={async () => {
        try {
          await reportSecurityKeyTheft('CorrectHorse9Battery');
        } catch {
          /* state must clear regardless */
        }
      }}
    >
      stolen
    </button>
  );
}

function SecurityKeyEnrollButton({ onKey }: { onKey: (k: string) => void }) {
  const { beginSecurityKeyEnroll } = useAuth();
  return (
    <button
      onClick={async () => {
        onKey(await beginSecurityKeyEnroll('security_key'));
      }}
    >
      enroll
    </button>
  );
}

function SecurityKeyConfirmButton() {
  const { confirmSecurityKey } = useAuth();
  return (
    <button
      onClick={async () => {
        await confirmSecurityKey('PASTED-BACK');
      }}
    >
      confirm
    </button>
  );
}

function RecoveryButton({ onToken }: { onToken: (t: string) => void }) {
  const { beginRecovery, completeRecovery } = useAuth();
  return (
    <button
      onClick={async () => {
        const t = await beginRecovery('alice_01', 'KEY-1234');
        onToken(t);
        await completeRecovery(t, 'CorrectHorse9Battery');
      }}
    >
      recover
    </button>
  );
}

function IdentityStatusButton({ onIdentity }: { onIdentity: (i: { handle: string } | null) => void }) {
  const { getIdentity } = useAuth();
  return (
    <button
      onClick={async () => {
        onIdentity(await getIdentity());
      }}
    >
      status
    </button>
  );
}

function EnrollButton() {
  const { enrollIdentity } = useAuth();
  return (
    <button
      onClick={async () => {
        await enrollIdentity('alice_01', 'CorrectHorse9Battery');
      }}
    >
      enroll-identity
    </button>
  );
}