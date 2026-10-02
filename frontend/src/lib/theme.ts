/**
 * CodeConClave — theme application helper.
 * Theme comes from server-authoritative preferences (never localStorage).
 */
import { api } from './api';

export type Theme = 'light' | 'dark';

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark';
}

/** Current applied theme, defaulting to the premium dark identity. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * Persist the theme on the server (PUT /api/v1/workspace/preferences) and
 * apply it. Returns the server-confirmed theme, or null if the save failed
 * (the UI then keeps the previous theme — never a local-only claim).
 */
export async function persistTheme(next: Theme): Promise<Theme | null> {
  const res = await api<{ prefs: Record<string, unknown> }>('/api/v1/workspace/preferences', {
    method: 'PUT',
    body: { prefs: { theme: next } },
  });
  if (!isTheme(res.prefs.theme)) return null;
  applyTheme(res.prefs.theme);
  return res.prefs.theme;
}