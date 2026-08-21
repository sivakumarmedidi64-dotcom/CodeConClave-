/**
 * CodeConClave — auth UI integration tests (PHASE 2).
 * Login, registration, logout, protected-route redirect, MFA challenge
 * flow, email verification page, and resend throttling display. fetch is
 * mocked end-to-end (real AuthProvider + api client + pages).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { MfaPage } from './MfaPage';
import { VerifyEmailPage } from './VerifyEmailPage';
import { SettingsPage } from './SettingsPage';
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

/** Render the auth routes with protected routes for redirect assertions. */
function renderAuthApp(
  initialEntries: string[],
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  extraRoutes?: React.ReactNode,
) {
  const fetchFn = setupFetch(handler);
  const result = render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/mfa" element={<MfaPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route
              path="/home"
              element={
                <Protected>
                  <div>HOME-CONTENT</div>
                </Protected>
              }
            />
            {extraRoutes}
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

function Protected({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div>loading</div>;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

const anonMe = async (url: string) =>
  url.includes('/auth/me') ? jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401) : null;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('route protection', () => {
  it('redirects anonymous users away from protected routes to /login', async () => {
    renderAuthApp(['/home'], async (url) => (await anonMe(url)) ?? jsonResponse({ data: {} }));
    await waitFor(() => expect(screen.queryByText('HOME-CONTENT')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
  });

  it('lets an authenticated user reach the protected route', async () => {
    renderAuthApp(['/home'], async (url) => (url.includes('/auth/me') ? jsonResponse({ data: { user: USER } }) : jsonResponse({ data: {} })));
    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
  });
});

describe('login UI', () => {
  it('submits credentials and navigates to the protected route', async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderAuthApp(['/login'], async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/login')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ email: 'alice@example.com', password: 'Secret123!' });
        return jsonResponse({ data: { user: USER } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces invalid credentials without navigating', async () => {
    const user = userEvent.setup();
    renderAuthApp(['/login'], async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/login')) {
        return jsonResponse({ error: { code: 'bad_credentials', message: 'Incorrect email or password' } }, 401);
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Wrong123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Incorrect email or password')).toBeInTheDocument());
    expect(screen.queryByText('HOME-CONTENT')).not.toBeInTheDocument();
  });

  it('redirects to the originally requested route after login (from state)', async () => {
    const user = userEvent.setup();
    renderAuthApp(
      ['/chat'],
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
        if (url.includes('/auth/login')) return jsonResponse({ data: { user: USER } });
        return jsonResponse({ data: {} });
      },
      <Route
        path="/chat"
        element={
          <Protected>
            <div>CHAT-CONTENT</div>
          </Protected>
        }
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('CHAT-CONTENT')).toBeInTheDocument());
  });
});

describe('MFA challenge flow', () => {
  it('steps through login → MFA code → authenticated home', async () => {
    const user = userEvent.setup();
    renderAuthApp(['/login'], async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/login')) {
        return jsonResponse({ data: { mfaRequired: true, challengeToken: 'mfa_ch.abc' } });
      }
      if (url.includes('/auth/mfa/verify')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ challengeToken: 'mfa_ch.abc', code: '123456' });
        return jsonResponse({ data: { user: { ...USER, mfaEnabled: true } } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Two-factor verification')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
  });

  it('accepts a recovery code in the challenge flow', async () => {
    const user = userEvent.setup();
    renderAuthApp(['/login'], async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/login')) return jsonResponse({ data: { mfaRequired: true, challengeToken: 'mfa_ch.abc' } });
      if (url.includes('/auth/mfa/verify')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ recoveryCode: 'ABCD1234EF' });
        return jsonResponse({ data: { user: { ...USER, mfaEnabled: true } } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Two-factor verification')).toBeInTheDocument());
    await user.type(screen.getByLabelText('…or recovery code'), 'ABCD1234EF');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
  });

  it('shows an MFA failure and stays on the challenge page', async () => {
    const user = userEvent.setup();
    renderAuthApp(['/login'], async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/login')) return jsonResponse({ data: { mfaRequired: true, challengeToken: 'mfa_ch.abc' } });
      if (url.includes('/auth/mfa/verify')) {
        return jsonResponse({ error: { code: 'mfa_failed', message: 'MFA verification failed' } }, 401);
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Two-factor verification')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Authenticator code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByText('MFA verification failed')).toBeInTheDocument());
    expect(screen.queryByText('HOME-CONTENT')).not.toBeInTheDocument();
  });
});

describe('registration UI', () => {
  it('registers, navigates home, and fires a best-effort verification email', async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderAuthApp(['/register'], async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
      if (url.includes('/auth/register')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ email: 'alice@example.com', displayName: 'Alice' });
        return jsonResponse({ data: { user: USER } }, 201);
      }
      if (url.includes('/verify-email/send')) return jsonResponse({ data: { sent: true, alreadyVerified: false } });
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Display name'), 'Alice');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/verify-email/send', expect.objectContaining({ method: 'POST' })),
    );
  });

  it('surfaces duplicate-email errors', async () => {
    const user = userEvent.setup();
    renderAuthApp(['/register'], async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      if (url.includes('/auth/register')) {
        return jsonResponse({ error: { code: 'email_taken', message: 'An account with this email already exists' } }, 409);
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(screen.getAllByText('An account with this email already exists').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('HOME-CONTENT')).not.toBeInTheDocument();
  });
});

describe('email verification page', () => {
  it('verifies a fresh token and shows success', async () => {
    renderAuthApp(['/verify-email?token=abc123'], async (url) => {
      if (url.includes('/auth/verify-email') && !url.includes('/send') && !url.includes('/status')) {
        return jsonResponse({ data: { ok: true } });
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByText(/Email verified/i)).toBeInTheDocument());
  });

  it('shows the expiry message for an expired token', async () => {
    renderAuthApp(['/verify-email?token=expired-token'], async (url) => {
      if (url.includes('/auth/verify-email') && !url.includes('/send') && !url.includes('/status')) {
        return jsonResponse({ error: { code: 'verification_expired', message: 'This verification link has expired. Request a new one.' } }, 400);
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByText(/This verification link has expired/i)).toBeInTheDocument());
  });

  it('shows the reused-token message for a one-time token that was already used', async () => {
    renderAuthApp(['/verify-email?token=used-token'], async (url) => {
      if (url.includes('/auth/verify-email') && !url.includes('/send') && !url.includes('/status')) {
        return jsonResponse({ error: { code: 'verification_used', message: 'This verification link has already been used.' } }, 400);
      }
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByText(/This verification link has already been used/i)).toBeInTheDocument());
  });

  it('complains about a missing token', async () => {
    renderAuthApp(['/verify-email'], async (url) => (url.includes('/auth/me') ? jsonResponse({ data: { user: USER } }) : jsonResponse({ data: {} })));
    await waitFor(() => expect(screen.getByText(/missing a token/i)).toBeInTheDocument());
  });
});

describe('resend verification — throttling UX', () => {
  it('shows the server throttle message when resending too quickly', async () => {
    const user = userEvent.setup();
    const settingsRoutes = (
      <Route
        path="/settings"
        element={
          <Protected>
            <SettingsPage />
          </Protected>
        }
      />
    );
    renderAuthApp(
      ['/settings'],
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/auth/sessions')) return jsonResponse({ data: { sessions: [] } });
        if (url.includes('/auth/devices')) return jsonResponse({ data: { devices: [] } });
        if (url.includes('/payments/capabilities')) return jsonResponse({ data: { mode: 'PAYMENT_LINK', razorpayConfigured: true, razorpayMode: 'payment_link', currency: 'INR' } });
        if (url.includes('/payments/entitlements')) return jsonResponse({ data: { entitlements: [] } });
        if (url.includes('/payments/sessions')) return jsonResponse({ data: { sessions: [] } });
        if (url.includes('/verify-email/send')) {
          return jsonResponse(
            { error: { code: 'verification_throttled', message: 'A verification email was just sent. Try again shortly.' } },
            429,
          );
        }
        return jsonResponse({ data: {} });
      },
      settingsRoutes,
    );
    await waitFor(() => expect(screen.getByText(/Send verification email/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Send verification email' }));
    await waitFor(() =>
      expect(screen.getAllByText(/A verification email was just sent/i).length).toBeGreaterThan(0),
    );
  });

  it('confirms a successful resend', async () => {
    const user = userEvent.setup();
    renderAuthApp(
      ['/settings'],
      async (url) => {
        if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
        if (url.includes('/auth/sessions')) return jsonResponse({ data: { sessions: [] } });
        if (url.includes('/auth/devices')) return jsonResponse({ data: { devices: [] } });
        if (url.includes('/payments/capabilities')) return jsonResponse({ data: { mode: 'PAYMENT_LINK', razorpayConfigured: true, razorpayMode: 'payment_link', currency: 'INR' } });
        if (url.includes('/payments/entitlements')) return jsonResponse({ data: { entitlements: [] } });
        if (url.includes('/payments/sessions')) return jsonResponse({ data: { sessions: [] } });
        if (url.includes('/verify-email/send')) {
          return jsonResponse({ data: { sent: true, alreadyVerified: false } });
        }
        return jsonResponse({ data: {} });
      },
      <Route
        path="/settings"
        element={
          <Protected>
            <SettingsPage />
          </Protected>
        }
      />,
    );
    await waitFor(() => expect(screen.getByText(/Send verification email/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Send verification email' }));
    await waitFor(() => expect(screen.getAllByText(/Verification email sent/i).length).toBeGreaterThan(0));
  });
});