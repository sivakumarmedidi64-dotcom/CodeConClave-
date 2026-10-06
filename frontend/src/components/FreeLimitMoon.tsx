/**
 * CodeConClave — Free Limit Moon (Phase 12).
 * A separate Moon moment triggered ONLY by a server-reported transition into
 * the free usage limit (SSE `limit_reached` with `showMoon: true`) — never
 * guessed client-side and never replayed on refresh. A subtle ~1s darkening
 * overlay frames the crescent, then the UI returns to normal brightness while
 * the moon + message remain. Display state is persisted server-side
 * (workspace_state `free_limit_moon`) so a refresh cannot re-show the same
 * moment. Keyboard accessible: dialog semantics, focus moves into the
 * overlay, Escape closes. prefers-reduced-motion → fade only.
 */
import { useEffect, useRef } from 'react';
import { api } from '../lib/api';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function FreeLimitMoon({
  name,
  onOpenBilling,
  onClose,
  earlyAccess = false,
}: {
  name: string | null | undefined;
  onOpenBilling: () => void;
  onClose: () => void;
  /**
   * Early access: there is no paid tier to upgrade to, so the moon must never
   * sell one. The primary action simply dismisses the moment instead of
   * routing to the (dormant) billing surface.
   */
  earlyAccess?: boolean;
}) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const reduced = useRef(prefersReducedMotion());

  useEffect(() => {
    primaryRef.current?.focus();
    void api('/api/v1/workspace/state/free_limit_moon', {
      method: 'PUT',
      body: { value: { shownAt: new Date().toISOString(), date: new Date().toISOString().slice(0, 10) } },
    }).catch(() => {
      /* display tracking is best-effort */
    });
  }, []);

  return (
    <div
      className="cc-free-limit-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cc-free-limit-title"
      data-testid="free-limit-moon"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className={`cc-free-limit-card${reduced.current ? ' cc-free-limit-card--static' : ''}`}>
        <div className="cc-moon--free-limit" aria-hidden="true" />
        <h2 id="cc-free-limit-title">You&apos;ve reached your usage limit for this rolling window.</h2>
        <p className="cc-hint">Your work is safe.</p>
        <div className="cc-free-limit-actions">
          {earlyAccess ? (
            <button ref={primaryRef} className="cc-btn cc-btn--primary" onClick={onClose}>
              Continue
            </button>
          ) : (
            <button ref={primaryRef} className="cc-btn cc-btn--primary" onClick={() => onOpenBilling()}>
              Continue with Pro
            </button>
          )}
          <button className="cc-btn cc-btn--ghost" onClick={onClose}>
            Maybe Later
          </button>
        </div>
        {name ? <p className="cc-hint">Signed in as {name}</p> : null}
      </div>
    </div>
  );
}