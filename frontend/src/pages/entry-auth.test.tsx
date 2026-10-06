/**
 * CodeConClave — public-entry authentication contract.
 *
 * The approved entry experience must authenticate customers through
 * CodeConClave's own zero-domain identity only:
 *
 *   LOGIN    -> identifier (email or handle) -> keyword -> account key when required
 *   REGISTER -> identifier -> handle -> keyword -> 32-character account key,
 *              shown once and confirmed by paste-back
 *
 * There must be no Google/OAuth customer choice anywhere in these pages. The
 * backend zero-domain implementation (scrypt, anti-enumeration, security-key
 * challenge, recovery, sessions, rate limits) is untouched by this UI work.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
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

const ACCOUNT_KEY = 'k'.repeat(32);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

function renderEntry(path: '/login' | '/register', handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/home" element={<div>HOME-CONTENT</div>} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { ...result, fetchFn };
}

/** Nothing anywhere on the auth pages may offer a third-party sign-in. */
function expectNoThirdPartyAuth(container: HTMLElement) {
  const text = (container.textContent ?? '').replace(/\s+/g, ' ');
  for (const banned of [
    /sign in with google/i,
    /continue with google/i,
    /log ?in with google/i,
    /\bgoogle\b/i,
    /\boauth\b/i,
  ]) {
    expect(text).not.toMatch(banned);
  }
  for (const role of ['link', 'button'] as const) {
    for (const name of [/google/i, /oauth/i]) {
      expect(screen.queryByRole(role, { name })).toBeNull();
    }
  }
}

describe('entry authentication — no customer Google/OAuth login', () => {
  it('login offers only the zero-domain identity form', () => {
    const { container } = renderEntry('/login', async () => jsonResponse({ data: { user: USER } }, 401));
    expectNoThirdPartyAuth(container);
  });

  it('register offers only the zero-domain identity form', () => {
    const { container } = renderEntry('/register', async () => jsonResponse({ data: { user: USER } }, 401));
    expectNoThirdPartyAuth(container);
  });
});

describe('login — identifier, keyword, account-key challenge', () => {
  it('leads with the identifier + keyword form', async () => {
    const { container } = renderEntry('/login', async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
      return jsonResponse({ data: {} });
    });

    await waitFor(() => expect(screen.getByLabelText('Email or handle')).toBeDefined());
    expect(screen.getByLabelText('Keyword')).toBeDefined();
    // The zero-domain form is the default, not a hidden alternative.
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(container.textContent).toMatch(/account key/i);
  });

  it('submits the identifier and keyword to the identity endpoint', async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderEntry('/login', async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
      if (url.includes('/auth/identity/login')) {
        expect(JSON.parse(String(init?.body))).toEqual({ handle: 'alice_01', keyword: 'CorrectHorse9Battery' });
        return jsonResponse({ data: { user: USER } });
      }
      return jsonResponse({ data: {} });
    });

    await user.type(await screen.findByLabelText('Email or handle'), 'alice_01');
    await user.type(screen.getByLabelText('Keyword'), 'CorrectHorse9Battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/identity/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('presents the account-key challenge when the server requires it', async () => {
    const user = userEvent.setup();
    renderEntry('/login', async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
      if (url.includes('/auth/identity/login')) {
        return jsonResponse({
          data: { mfaRequired: true, challengeToken: 'ct_1', method: 'security_key', reason: 'unknown_device' },
        });
      }
      if (url.includes('/auth/security-key/verify')) {
        expect(JSON.parse(String(init?.body))).toEqual({ challengeToken: 'ct_1', securityKey: ACCOUNT_KEY });
        return jsonResponse({ data: { user: USER } });
      }
      return jsonResponse({ data: {} });
    });

    await user.type(await screen.findByLabelText('Email or handle'), 'alice_01');
    await user.type(screen.getByLabelText('Keyword'), 'CorrectHorse9Battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const keyField = await screen.findByLabelText('Account key');
    expect(screen.getByText(/32-character account key/i)).toBeDefined();
    await user.type(keyField, ACCOUNT_KEY);
    await user.click(screen.getByRole('button', { name: 'Verify key' }));
    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
  });

  it('keeps email + password and the sign-in code as alternatives', async () => {
    const user = userEvent.setup();
    renderEntry('/login', async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
      return jsonResponse({ data: {} });
    });

    await user.click(await screen.findByRole('button', { name: /use email \+ password instead/i }));
    expect(screen.getByLabelText('Email')).toBeDefined();
    expect(screen.getByLabelText('Password')).toBeDefined();

    await user.click(screen.getByRole('button', { name: /use a sign-in code instead/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /send sign-in code/i })).toBeDefined());
  });

  it('offers direct login only — no create-account path from sign-in', async () => {
    const { container } = renderEntry('/login', async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ data: { user: USER } });
      return jsonResponse({ data: {} });
    });

    await waitFor(() => expect(screen.getByLabelText('Email or handle')).toBeDefined());
    expect(container.querySelectorAll('a[href*="/register"]')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /create an? account/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create an? account/i })).toBeNull();
  });
});

describe('register — identity, handle, keyword, one-time account key', () => {
  it('requires a handle and keyword, the inputs that issue the account key', async () => {
    const { fetchFn } = renderEntry('/register', async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized' } }, 401);
      return jsonResponse({ data: {} });
    });

    const handle = (await screen.findByLabelText('Handle')) as HTMLInputElement;
    const keyword = (await screen.findByLabelText('Keyword')) as HTMLInputElement;
    expect(handle.required).toBe(true);
    expect(keyword.required).toBe(true);
    expect(handle.getAttribute('maxlength')).toBe('20');
    expect(keyword.getAttribute('minlength')).toBe('12');

    // An empty identity cannot be submitted, so no keyless account is created.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(fetchFn).not.toHaveBeenCalledWith(
      '/api/v1/auth/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the identity alongside registration', async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderEntry('/register', async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized' } }, 401);
      if (url.includes('/auth/register')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          email: 'alice@example.com',
          identity: { handle: 'alice_01', keyword: 'CorrectHorse9Battery' },
        });
        return jsonResponse({ data: { user: USER, securityKey: ACCOUNT_KEY } }, 201);
      }
      if (url.includes('/verify-email/send')) return jsonResponse({ data: { sent: true } });
      if (url.includes('/auth/security-key/confirm')) return jsonResponse({ data: {} });
      return jsonResponse({ data: {} });
    });

    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Handle'), 'alice_01');
    await user.type(screen.getByLabelText('Keyword'), 'CorrectHorse9Battery');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/register', expect.objectContaining({ method: 'POST' })),
    );
  });

  it('shows the 32-character key once and requires paste-back before entry', async () => {
    const user = userEvent.setup();
    const { fetchFn } = renderEntry('/register', async (url, init) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized' } }, 401);
      if (url.includes('/auth/register')) return jsonResponse({ data: { user: USER, securityKey: ACCOUNT_KEY } }, 201);
      if (url.includes('/verify-email/send')) return jsonResponse({ data: { sent: true } });
      if (url.includes('/auth/security-key/confirm')) {
        expect(JSON.parse(String(init?.body))).toEqual({ securityKey: ACCOUNT_KEY });
        return jsonResponse({ data: {} });
      }
      return jsonResponse({ data: {} });
    });

    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Handle'), 'alice_01');
    await user.type(screen.getByLabelText('Keyword'), 'CorrectHorse9Battery');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    const shown = await screen.findByTestId('account-key-once');
    expect(shown.textContent).toBe(ACCOUNT_KEY);
    expect(shown.textContent).toHaveLength(32);
    // The one-time nature is stated in words, not implied by styling.
    expect(document.body.textContent).toMatch(/is shown\s*once/i);

    // Not in the workspace until the key is pasted back.
    expect(screen.queryByText('HOME-CONTENT')).toBeNull();

    await user.type(screen.getByLabelText(/paste key to confirm/i), ACCOUNT_KEY);
    await user.click(screen.getByRole('button', { name: /i've saved it/i }));

    await waitFor(() => expect(screen.getByText('HOME-CONTENT')).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/security-key/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a mismatched paste-back instead of entering the workspace', async () => {
    const user = userEvent.setup();
    renderEntry('/register', async (url) => {
      if (url.includes('/auth/me')) return jsonResponse({ error: { code: 'unauthorized' } }, 401);
      if (url.includes('/auth/register')) return jsonResponse({ data: { user: USER, securityKey: ACCOUNT_KEY } }, 201);
      if (url.includes('/verify-email/send')) return jsonResponse({ data: { sent: true } });
      if (url.includes('/auth/security-key/confirm')) {
        return jsonResponse({ error: { code: 'security_key_mismatch', message: 'That key does not match' } }, 400);
      }
      return jsonResponse({ data: {} });
    });

    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Handle'), 'alice_01');
    await user.type(screen.getByLabelText('Keyword'), 'CorrectHorse9Battery');
    await user.type(screen.getByLabelText('Password'), 'Secret123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await user.type(await screen.findByLabelText(/paste key to confirm/i), 'x'.repeat(32));
    await user.click(screen.getByRole('button', { name: /i've saved it/i }));

    await waitFor(() => expect(screen.getAllByText('That key does not match').length).toBeGreaterThan(0));
    expect(screen.queryByText('HOME-CONTENT')).toBeNull();
  });
});
