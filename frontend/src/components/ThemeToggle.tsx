/**
 * CodeConClave — theme toggle (header), Claude-style.
 * A real light/dark switch: sun when dark (click → light), moon when light
 * (click → dark). It applies the new theme at once for a snappy feel, then
 * persists it on the server; if the save fails it reverts (never a local-only
 * claim). Stays in sync when the theme is changed elsewhere (Settings).
 */
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { applyTheme, currentTheme, persistTheme, THEME_CHANGED, type Theme } from '../lib/theme';

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  const [busy, setBusy] = useState(false);

  // Follow theme changes made anywhere else (e.g. Settings → personalization).
  useEffect(() => {
    const sync = () => setThemeState(currentTheme());
    window.addEventListener(THEME_CHANGED, sync);
    return () => window.removeEventListener(THEME_CHANGED, sync);
  }, []);

  const toggle = async () => {
    if (busy) return;
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setBusy(true);
    applyTheme(next); // optimistic — the switch feels instant
    setThemeState(next);
    const saved = await persistTheme(next).catch(() => null);
    if (saved === null) {
      applyTheme(theme); // save failed → go back, no false claim
      setThemeState(theme);
    }
    setBusy(false);
  };

  const toLight = theme === 'dark';
  return (
    <button
      type="button"
      className="cc-icon-btn cc-theme-toggle"
      onClick={() => void toggle()}
      disabled={busy}
      aria-label={toLight ? 'Switch to light theme' : 'Switch to dark theme'}
      title={toLight ? 'Light theme' : 'Dark theme'}
    >
      <Icon name={toLight ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
