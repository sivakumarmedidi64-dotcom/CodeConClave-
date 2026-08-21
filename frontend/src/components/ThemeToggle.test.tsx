/**
 * CodeConClave — ThemeToggle tests (PHASE 11).
 * Clicking persists the new theme on the server and applies the confirmed
 * value; failure keeps the previous theme.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle } from './ThemeToggle';
import { jsonResponse, stubFetch } from '../testutils';

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('persists the theme on the server and applies it', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/preferences') && init?.method === 'PUT') {
        return jsonResponse({ data: { prefs: { theme: 'dark' } } });
      }
      return jsonResponse({ data: {} });
    });
    render(<ThemeToggle />);
    const button = screen.getByLabelText('Switch to dark theme');
    await userEvent.click(button);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    const put = fetchFn.mock.calls.find(([u, i]) => i?.method === 'PUT');
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ prefs: { theme: 'dark' } });
  });

  it('keeps the previous theme when the server rejects the save', async () => {
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/preferences') && init?.method === 'PUT') {
        return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
      }
      return jsonResponse({ data: {} });
    });
    render(<ThemeToggle />);
    await userEvent.click(screen.getByLabelText('Switch to dark theme'));
    await waitFor(() => expect(screen.getByLabelText('Switch to dark theme')).toBeEnabled());
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});