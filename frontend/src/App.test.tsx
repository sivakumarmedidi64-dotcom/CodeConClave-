/**
 * CodeConClave — App shell tests (PHASE 11).
 * Unknown routes render the 404 page inside the shell; / redirects to /home;
 * the shell restores sidebar state and mounts the palette.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { shellHandler, stubFetch, jsonResponse } from './testutils';

function renderApp(initialEntries: string[]) {
  const fetchFn = stubFetch(shellHandler);
  const result = render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

async function waitAuthed() {
  // Phase 18: generous deadline for the router mount. Under full-suite CPU
  // contention the shell's Navigate → page mount occasionally exceeded the
  // default 1s waitFor window (flake, not an assertion change — same as the
  // backend testTimeout bump). Assertions are unchanged.
  await waitFor(() => expect(screen.getByRole('heading', { name: /Good (morning|afternoon|evening|night),/ })).toBeInTheDocument(), { timeout: 8000 });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('App shell', () => {
  it('renders the public landing page at /', async () => {
    renderApp(['/']);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/AI Developer & Founder Operating System/i);
    expect(screen.getByText('What is CodeConClave?')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Choose how you want to use CodeConClave/i })).toBeInTheDocument();
  });

  it('renders the zero-domain create-account form on /register', async () => {
    renderApp(['/register']);
    expect(await screen.findByRole('heading', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Handle')).toBeInTheDocument();
    expect(screen.getByLabelText('Keyword')).toBeInTheDocument();
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).not.toMatch(/sign in with google/i);
    expect(text).not.toMatch(/continue with google/i);
    expect(document.querySelectorAll('a[href*="google"]').length).toBe(0);
  });

  it('renders the 404 page for unknown routes', async () => {
    renderApp(['/does-not-exist']);
    await waitFor(() => expect(screen.getByText('404 — page not found')).toBeInTheDocument());
    expect(screen.getByText('Back to Home')).toBeInTheDocument();
  });

  it('applies the server theme preference on mount', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/auth/me')) return shellHandler(url);
      if (url.includes('/api/v1/workspace/preferences')) {
        return { ok: true, status: 200, json: async () => ({ data: { prefs: { theme: 'dark' } } }) } as unknown as Response;
      }
      if (url.includes('/api/v1/workspace/state')) return shellHandler(url);
      return { ok: true, status: 200, json: async () => ({ data: {} }) } as unknown as Response;
    });
    render(
      <MemoryRouter initialEntries={['/home']}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('restores the collapsed sidebar state from the server', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/auth/me')) return shellHandler(url);
      if (url.includes('/api/v1/access')) {
        return jsonResponse({ data: { access: { unlocked: true, effectivePlan: 'pro', planId: 'pro', entitlementState: 'PRO_VERIFIED', reason: 'ACTIVE' } } });
      }
      if (url.includes('/api/v1/workspace/state')) {
        return { ok: true, status: 200, json: async () => ({ data: { state: [{ key: 'sidebar_state', value: { collapsed: true } }] } }) } as unknown as Response;
      }
      if (url.includes('/api/v1/workspace/preferences')) return shellHandler(url);
      return { ok: true, status: 200, json: async () => ({ data: {} }) } as unknown as Response;
    });
    const { container } = render(
      <MemoryRouter initialEntries={['/home']}>
        <App />
      </MemoryRouter>,
    );
    await waitAuthed();
    await waitFor(() => expect(container.querySelector('.cc-shell--collapsed')).not.toBeNull());
  });

  it('shows the profile name in the top bar', async () => {
    renderApp(['/home']);
    await waitFor(() => expect(screen.getAllByText('Alice').length).toBeGreaterThan(0));
    expect(screen.getByTestId('plan-badge')).toHaveTextContent('FREE');
  });

  it('locks the workspace behind the Early Access notice while early access is open', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/auth/me')) return shellHandler(url);
      if (url.includes('/api/v1/access')) {
        return jsonResponse({
          data: {
            access: { unlocked: false, effectivePlan: 'free', planId: 'free', entitlementState: 'FREE', reason: 'NO_ENTITLEMENT' },
            mode: { temporaryDemoMode: true },
          },
        });
      }
      return shellHandler(url);
    });
    render(
      <MemoryRouter initialEntries={['/home']}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('early-access-gate')).toBeInTheDocument());
    // The workspace heading must NOT render for a locked account.
    expect(screen.queryByRole('heading', { name: /Good (morning|afternoon|evening|night),/ })).not.toBeInTheDocument();
    // Early access is not a commercial surface: no prices, no checkout, no plan.
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no free application tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument();
  });

  it('never shows payment chrome when the access reply carries no mode (fail closed)', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/auth/me')) return shellHandler(url);
      if (url.includes('/api/v1/access')) {
        return jsonResponse({ data: { access: { unlocked: false, effectivePlan: 'free', planId: 'free', entitlementState: 'FREE', reason: 'NO_ENTITLEMENT' } } });
      }
      return shellHandler(url);
    });
    render(
      <MemoryRouter initialEntries={['/home']}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('early-access-gate')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no free application tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument();
  });

  it('keeps the server-authoritative payment gate when demo mode is explicitly off', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/auth/me')) return shellHandler(url);
      if (url.includes('/api/v1/access')) {
        return jsonResponse({
          data: {
            access: { unlocked: false, effectivePlan: 'free', planId: 'free', entitlementState: 'FREE', reason: 'NO_ENTITLEMENT' },
            mode: { temporaryDemoMode: false },
          },
        });
      }
      if (url.includes('/api/v1/payments/capabilities')) {
        return jsonResponse({ data: { plans: { pro: 999, team: 4999, api: 9999 }, unlockMode: 'MANUAL', currency: 'INR' } });
      }
      if (url.includes('/api/v1/payments/status')) {
        return jsonResponse({ data: { effectivePlan: 'free', accountEmail: 'alice@example.com', plans: [] } });
      }
      if (url.includes('/api/v1/payments/intents')) return jsonResponse({ data: { intents: [] } });
      if (url.includes('/api/v1/payments/claims')) return jsonResponse({ data: { claims: [] } });
      return shellHandler(url);
    });
    render(
      <MemoryRouter initialEntries={['/home']}>
        <App />
      </MemoryRouter>,
    );
    // The billing gate explains the requirement instead. Wait for it — the
    // access fetch resolves asynchronously after first paint.
    await waitFor(() => expect(screen.getByText(/no free application tier/i)).toBeInTheDocument());
    // The workspace heading must NOT render for a locked account.
    expect(screen.queryByRole('heading', { name: /Good (morning|afternoon|evening|night),/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('early-access-gate')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Upgrade \(₹999\)/i })).toBeInTheDocument(), { timeout: 5000 });
  });

  it('grants the workspace when the server reports an active paid entitlement', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/auth/me')) return shellHandler(url);
      if (url.includes('/api/v1/access')) {
        return jsonResponse({ data: { access: { unlocked: true, effectivePlan: 'pro', planId: 'pro', entitlementState: 'PRO_VERIFIED', reason: 'ACTIVE' } } });
      }
      return shellHandler(url);
    });
    render(
      <MemoryRouter initialEntries={['/home']}>
        <App />
      </MemoryRouter>,
    );
    await waitAuthed();
    expect(screen.getByRole('heading', { name: /Good (morning|afternoon|evening|night),/ })).toBeInTheDocument();
  });
});