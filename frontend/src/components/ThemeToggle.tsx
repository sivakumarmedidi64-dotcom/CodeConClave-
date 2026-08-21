/**
 * CodeConClave — theme toggle (header).
 * Theme is server-authoritative: PUT /api/v1/workspace/preferences and apply
 * the confirmed value; on failure the previous theme is kept.
 */
import { useState } from 'react';
import { currentTheme, persistTheme, type Theme } from '../lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      const confirmed = await persistTheme(next);
      if (confirmed) setTheme(confirmed);
    } catch {
      /* keep previous theme */
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="cc-btn cc-btn--ghost cc-btn--sm"
      onClick={() => void toggle()}
      disabled={busy}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}