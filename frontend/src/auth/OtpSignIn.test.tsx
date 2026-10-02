/**
 * CodeConClave — "sign in with a code" UI tests.
 * Covers the full request-code → enter-code → authenticated flow through the
 * real AuthProvider + api client + LoginPage, the MFA challenge handoff for
 * MFA-enabled accounts, and the exact backend endpoints hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './AuthProvider';
import { ToastProvider } from '../components/Toast';
import { LoginPage } from '../pages/LoginPage';
import { MfaPage } from '../pages/MfaPage';
import type { User } from '../lib/types';

const USER: User = {
  id: 'u1',
  email: 'alice@example.com',
  emailVerified: true,
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

function renderLogin(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = setupFetch(handler);
  const result = render(
    <MemoryRouter initialEntries={['/login']}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/mfa" element={<MfaPage />} />
            <Route path="/home" element={<div>HOME-CONTENT</div>} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

const anonMe = async (url: string, init?: RequestInit) => {
  if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
  return null;
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('sign in with a code (web)', () => {
  it('requests a code, verifies it, and lands on the protected home route', async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderLogin(async (url, init) => {
      const me = await anonMe(url, init);
      if (me) return me;
      if (url.includes('/auth/otp/request')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ email: 'alice@example.com' });
        return jsonResponse({ data: { sent: true, resendableAfterMs: 60000, expiresInSeconds: 600 } });
      }
      if (url.includes('/auth/otp/verify')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ email: 'alice@example.com', code: '123456' });
        return jsonResponse({ data: { user: USER } });
      }
      return jsonResponse({ data: {} });
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Use a sign-in code instead' }));

    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in code' }));

    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/otp/request', expect.objectContaining({ method: 'POST' }));
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/otp/verify', expect.objectContaining({ method: 'POST' }));
  });

  it('routes MFA-enabled accounts into the existing TOTP challenge instead of mocking a session', async () => {
    const user = userEvent.setup();
    renderLogin(async (url, init) => {
      const me = await anonMe(url, init);
      if (me) return me;
      if (url.includes('/auth/otp/request')) {
        return jsonResponse({ data: { sent: true, resendableAfterMs: 60000, expiresInSeconds: 600 } });
      }
      if (url.includes('/auth/otp/verify')) {
        return jsonResponse({ data: { mfaRequired: true, challengeToken: 'mfa_ch.abc' } });
      }
      return jsonResponse({ data: {} });
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Use a sign-in code instead' }));
    await user.type(screen.getByLabelText('Email'), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in code' }));
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() => expect(screen.getByText('Two-factor verification')).toBeInTheDocument());
    expect(screen.queryByText('HOME-CONTENT')).not.toBeInTheDocument();
  });

  it('clears the resend countdown interval when the component unmounts', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const user = userEvent.setup();
    try {
      const { unmount } = renderLogin(async (url, init) => {
        const me = await anonMe(url, init);
        if (me) return me;
        if (url.includes('/auth/otp/request')) {
          return jsonResponse({ data: { sent: true, resendableAfterMs: 60000, expiresInSeconds: 600 } });
        }
        return jsonResponse({ data: {} });
      });

      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'Use a sign-in code instead' }));
      await user.type(screen.getByLabelText('Email'), 'alice@example.com');
      await user.click(screen.getByRole('button', { name: 'Send sign-in code' }));

      await waitFor(() => expect(screen.getByText(/Resend available in 60s/)).toBeInTheDocument());
      const handle = setIntervalSpy.mock.results.at(-1)?.value;
      expect(handle).toBeDefined();

      unmount();
      expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});