/**
 * CodeConClave — theme indicator (header).
 * The app ships a single premium dark theme; this control communicates that
 * state rather than switching themes. Theme persistence helpers remain in
 * lib/theme for compatibility.
 */
import { Icon } from './Icon';

export function ThemeToggle() {
  return (
    <span
      className="cc-plan-pill"
      role="status"
      aria-label="Dark theme"
      title="Premium dark theme"
      style={{ color: 'var(--cc-text-muted)' }}
    >
      <Icon name="moon" size={12} />
      Dark
    </span>
  );
}