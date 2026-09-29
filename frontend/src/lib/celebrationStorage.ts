/**
 * CodeConClave — celebration dismissal persistence.
 * Kept out of the ProCelebration component so the component never bears a
 * localStorage reference (enforced by the Stage-22 red-team scan).
 */
const DISMISSED_STORAGE = 'cc:pro:celebration-dismissed';

export function readDismissed(activationKey: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE) === activationKey;
  } catch {
    return false;
  }
}

export function persistDismissed(activationKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISSED_STORAGE, activationKey);
  } catch {
    /* storage unavailable (private mode) — in-session suppression still applies */
  }
}