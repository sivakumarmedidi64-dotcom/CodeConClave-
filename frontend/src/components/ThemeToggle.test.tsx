/**
 * CodeConClave — ThemeToggle tests. A real light/dark switch (Claude-style):
 * it flips the theme at once and persists it on the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle } from './ThemeToggle';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('shows a switch to light when the theme is dark', () => {
    render(<ThemeToggle />);
    expect(screen.getByLabelText('Switch to light theme')).toBeInTheDocument();
  });

  it('switches to light and persists the choice on the server', async () => {
    let putBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        putBody = init?.body ? JSON.parse(String(init.body)) : null;
        return json({ prefs: { theme: 'light' } });
      }),
    );
    render(<ThemeToggle />);
    await userEvent.click(screen.getByLabelText('Switch to light theme'));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(putBody).toEqual({ prefs: { theme: 'light' } });
    // The button now offers the way back.
    expect(screen.getByLabelText('Switch to dark theme')).toBeInTheDocument();
  });

  it('reverts when the save fails (no local-only claim)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    render(<ThemeToggle />);
    await userEvent.click(screen.getByLabelText('Switch to light theme'));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });
});
