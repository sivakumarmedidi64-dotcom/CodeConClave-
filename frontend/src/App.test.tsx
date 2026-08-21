/**
 * CodeConClave — App shell tests (PHASE 11).
 * Unknown routes render the 404 page inside the shell; / redirects to /home;
 * the shell restores sidebar state and mounts the palette.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { shellHandler, stubFetch } from './testutils';

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
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument(), { timeout: 8000 });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('App shell', () => {
  it('redirects / to /home', async () => {
    renderApp(['/']);
    await waitAuthed();
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('Alice — FREE')).toBeInTheDocument());
  });
});