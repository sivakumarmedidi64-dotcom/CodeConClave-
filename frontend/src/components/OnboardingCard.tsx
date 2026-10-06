/**
 * CodeConClave — OnboardingCard.
 * Minimal first-run profile completeness: display name (if missing), role and
 * primary use case. Sign-in already provides identity (email), so email is
 * never re-asked here. Values MUST match the server-side allow-lists
 * (shared/src/constants.ts ONBOARDING_ROLES / ONBOARDING_USE_CASES), which
 * validate every write. Persists via the existing account profile API so Web
 * and Desktop share the same data. Never blocks usage — dismissible.
 */
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useToast } from './Toast';

const ROLES = ['Developer', 'Founder', 'Student', 'Designer', 'Product', 'Other'] as const;
const USE_CASES = ['Build software', 'Debug/code', 'AI cowork', 'Automation', 'Research', 'Learning', 'Other'] as const;

export function OnboardingCard() {
  const { user, updateProfile } = useAuth();
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [role, setRole] = useState(user?.role ?? '');
  const [primaryUseCase, setPrimaryUseCase] = useState(user?.primaryUseCase ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!user) return null;
  const needsName = !user.displayName?.trim();
  const incomplete = needsName || !user.role || !user.primaryUseCase;
  if (!incomplete || done) return null;

  const canSave = (!needsName || displayName.trim().length >= 2) && role.trim().length > 0 && primaryUseCase.trim().length > 0;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      await updateProfile({
        displayName: needsName ? displayName.trim() : undefined,
        role,
        primaryUseCase,
      });
      setDone(true);
      toast('Profile saved. Welcome to CodeConClave!', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save profile', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cc-card cc-onboarding" aria-labelledby="onboarding-title">
      <h3 id="onboarding-title">Complete your profile</h3>
      <p className="cc-muted">A few details help CodeConClave tailor your experience. You can change these anytime in Settings.</p>
      <form onSubmit={save} noValidate>
        {needsName && (
          <div className="cc-field">
            <label htmlFor="onboarding-displayName">What should we call you?</label>
            <input
              id="onboarding-displayName"
              className="cc-input"
              maxLength={80}
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        )}
        <div className="cc-field">
          <label htmlFor="onboarding-role">Your role</label>
          <select id="onboarding-role" className="cc-input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Select a role…</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="cc-field">
          <label htmlFor="onboarding-useCase">Primary use case</label>
          <select id="onboarding-useCase" className="cc-input" value={primaryUseCase} onChange={(e) => setPrimaryUseCase(e.target.value)}>
            <option value="">Select a use case…</option>
            {USE_CASES.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
        <div className="cc-onboarding__actions">
          <button className="cc-btn cc-btn--primary" type="submit" disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
          <button className="cc-btn cc-btn--ghost" type="button" onClick={() => setDone(true)}>
            Skip for now
          </button>
        </div>
      </form>
    </section>
  );
}