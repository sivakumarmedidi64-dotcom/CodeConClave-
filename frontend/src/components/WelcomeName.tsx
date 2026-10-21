/**
 * First-run welcome: "What should CodeConClave call you?" Shown once on Home
 * until the user answers or skips. Saved to preferences (call_me), which the
 * greeting and every chat use.
 */
import { useEffect, useState } from 'react';
import { loadPrefs, savePrefs } from '../lib/prefs';
import { BrandLogo } from './BrandLogo';

export function WelcomeName() {
  // null until preferences have actually loaded (missing ≠ loading).
  const [needed, setNeeded] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPrefs().then((p) => {
      const named = typeof p.call_me === 'string' && p.call_me.trim().length > 0;
      if (alive) setNeeded(!named && p.welcome_done !== true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [closed, setClosed] = useState(false);

  // Answered or skipped → never again.
  if (closed || needed !== true) return null;

  const finish = async (value: string) => {
    setSaving(true);
    try {
      await savePrefs(value ? { call_me: value.slice(0, 60), welcome_done: true } : { welcome_done: true });
    } catch {
      // Not saved (offline/server error): close for now; it asks again next visit.
    } finally {
      setSaving(false);
      setClosed(true);
    }
  };

  return (
    <div className="sp-overlay lf-overlay" role="dialog" aria-modal="true" aria-label="Welcome to CodeConClave">
      <form
        className="sp-modal cc-welcome"
        onSubmit={(e) => {
          e.preventDefault();
          void finish(name.trim());
        }}
      >
        <BrandLogo variant="lockup" height={70} />
        <h2 className="cc-welcome__title">Welcome. What should we call you?</h2>
        <p className="cc-hint">Your bots will use it, and so will every answer. Change it any time in Settings → General.</p>
        <input className="cc-input" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
        <div className="lf-permission__actions">
          <button type="submit" className="cc-btn cc-btn--primary" disabled={saving || !name.trim()}>
            Continue
          </button>
          <button type="button" className="cc-btn cc-btn--ghost" disabled={saving} onClick={() => void finish('')}>
            Skip
          </button>
        </div>
      </form>
    </div>
  );
}
