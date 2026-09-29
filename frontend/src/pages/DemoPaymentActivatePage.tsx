/**
 * CodeConClave — DEMO PAYMENT activation page (test-only, strictly
 * non-production). This page is reached from the DEMO activation email. It
 * consumes a one-time activation token that proves EMAIL OWNERSHIP only — it
 * does NOT and CANNOT prove a payment occurred. The banner is intentional and
 * visible: in production this page and the entire demo rail refuse to run.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';

type Outcome = 'verifying' | 'success' | 'error' | 'disabled';

interface DemoActivationResult {
  demo: boolean;
  method: string;
  is_real_payment: boolean;
  status: string;
  plan?: string;
  amountInr?: number;
  note?: string;
}

export function DemoPaymentActivatePage() {
  const { status, refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [outcome, setOutcome] = useState<Outcome>('verifying');
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DemoActivationResult | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (status === 'loading') return;
    if (!token) {
      setOutcome('error');
      setMessage('This demo activation link is missing a token. Use the link from your demo email.');
      return;
    }
    if (started.current) return;
    started.current = true;
    void api<DemoActivationResult>('/api/v1/payments/demo/activate', {
      method: 'POST',
      body: { token },
    })
      .then((data) => {
        setOutcome('success');
        setResult(data);
        void refresh();
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === 'demo_mode_disabled') {
          setOutcome('disabled');
          setMessage(err.message);
        } else {
          setOutcome('error');
          setMessage(err instanceof ApiError ? err.message : 'Demo activation failed. Please try again.');
        }
      });
  }, [token, status]);

  return (
    <div className="cc-panel cc-panel--pad" style={{ maxWidth: 640, margin: '0 auto', marginTop: 24 }}>
      <div
        style={{
          background: '#f59e0b',
          color: '#111',
          padding: '10px 14px',
          borderRadius: 6,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span aria-hidden><Icon name="shield" size={16} /></span>
        <span>DEMO MODE — NO REAL PAYMENT VERIFICATION</span>
      </div>
      <p style={{ marginTop: 12 }}>
        This is a <strong>test-flow / demo activation only</strong>. Clicking the link confirms you own this email
        address. It does <strong>not</strong> verify that any payment was made and grants <strong>no production
        entitlement</strong>.
      </p>

      {outcome === 'verifying' && (
        <p className="cc-hint">
          <span className="cc-spinner" style={{ display: 'inline-block', marginRight: 8 }} />
          Checking demo activation…
        </p>
      )}

      {outcome === 'disabled' && (
        <>
          <p className="cc-error" style={{ marginTop: 12 }}>
            {message}
          </p>
          <p className="cc-hint">Redirect-only payment verification is never enabled in production.</p>
        </>
      )}

      {outcome === 'error' && (
        <p className="cc-error" style={{ marginTop: 12 }}>
          {message}
        </p>
      )}

      {outcome === 'success' && result && (
        <>
          <p style={{ marginTop: 12 }}>
            <strong>DEMO ACTIVATION COMPLETE.</strong> Intended plan:{' '}
            <strong>{String(result.plan ?? 'n/a').toUpperCase()}</strong>
            {typeof result.amountInr === 'number' ? ` (₹${result.amountInr.toLocaleString('en-IN')})` : ''}.
          </p>
          <p className="cc-hint" style={{ marginTop: 8 }}>
            method = {result.method} · is_real_payment = {String(result.is_real_payment)}. No charge was made; this is a
            demonstration only.
          </p>
        </>
      )}

      {outcome !== 'verifying' && (
        <p className="cc-hint" style={{ marginTop: 16 }}>
          <Link to="/home">Back to demo home</Link>
        </p>
      )}
    </div>
  );
}
