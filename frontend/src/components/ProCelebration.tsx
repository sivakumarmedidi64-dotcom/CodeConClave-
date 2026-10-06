/**
 * CodeConClave — post-payment success celebration (client-only, observational).
 * Follows the server's payment status; it NEVER activates anything. Shows once
 * per confirmed Pro unlock: either when the payment-status poll observes the
 * pro entitlement flip to PRO_VERIFIED live, or when a fresh activation
 * (activatedAt within the last 10 minutes) is seen on load. Dismissal is
 * persisted locally against the same activation.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { readDismissed, persistDismissed } from '../lib/celebrationStorage';
import type { PaymentStatusView } from '../lib/types';

const PRO = 'pro';
const RECENT_ACTIVATION_MS = 10 * 60 * 1000;
const POLL_MS = 20_000;

export function ProCelebration() {
  const { status, user } = useAuth();
  const [visible, setVisible] = useState(false);
  const [activatedAt, setActivatedAt] = useState<string | null>(null);
  const celebratedKey = useRef<string | null>(null);
  const prevProEntitlement = useRef<string | null>(null);

  useEffect(() => {
    if (status !== 'authed' || !user) {
      setVisible(false);
      return;
    }
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const view = await api<PaymentStatusView>('/api/v1/payments/status');
        if (cancelled) return;
        const pro = (view.plans ?? []).find((p) => p.planId === PRO) ?? null;
        const state = pro?.entitlementState ?? null;
        if (state !== 'PRO_VERIFIED') {
          prevProEntitlement.current = state;
          setVisible(false);
          return;
        }
        const key = pro?.activatedAt ? `at:${pro.activatedAt}` : `u:${user.id}`;
        if (celebratedKey.current === key) return;
        const flipped = prevProEntitlement.current !== null && prevProEntitlement.current !== 'PRO_VERIFIED';
        const fresh =
          pro !== null &&
          pro.activatedAt !== null &&
          Date.now() - new Date(pro.activatedAt).getTime() < RECENT_ACTIVATION_MS;
        if ((flipped || fresh) && !readDismissed(key)) {
          setActivatedAt(pro?.activatedAt ?? null);
          setVisible(true);
          celebratedKey.current = key;
        }
        prevProEntitlement.current = state;
      } catch {
        /* transient — keep current state, retry on next tick */
      }
    };

    void poll();
    timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status, user]);

  if (!visible) return null;

  const dismiss = () => {
    const key = activatedAt ? `at:${activatedAt}` : user ? `u:${user.id}` : '';
    if (key) persistDismissed(key);
    setVisible(false);
  };

  return (
    <section className="cc-pro-celebration" role="status" aria-live="polite" aria-label="Pro plan activated">
      <div className="cc-pro-celebration__mark" aria-hidden="true">
        ✓
      </div>
      <div className="cc-pro-celebration__body">
        <h2>You're on CodeConClave Pro</h2>
        <p>Your payment was confirmed and Pro is active on this account.</p>
        {activatedAt && (
          <p className="cc-pro-celebration__meta">Activated {new Date(activatedAt).toLocaleString()}</p>
        )}
        <p className="cc-pro-celebration__meta">
          Questions about your payment?{' '}
          <a href="mailto:medidisaharsh@gmail.com" style={{ color: 'var(--cc-accent)' }}>
            Contact support
          </a>
        </p>
      </div>
      <button type="button" className="cc-pro-celebration__dismiss" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </section>
  );
}