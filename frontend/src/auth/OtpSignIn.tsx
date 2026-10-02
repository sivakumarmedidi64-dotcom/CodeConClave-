/**
 * CodeConClave — passwordless "sign in with a code" flow.
 * Two steps in one card: request a code, then enter the 6 digits.
 * MFA-enabled accounts are handed off to the existing /mfa challenge.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth, MfaRequiredError } from './AuthProvider';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';

interface OtpSignInProps {
  onAuthenticated: () => void;
  onMfaRequired: (challengeToken: string, email: string) => void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function OtpSignIn({ onAuthenticated, onMfaRequired }: OtpSignInProps) {
  const { requestOtp, verifyOtp } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  // Tracked so the countdown is always cleared: on completion, on a resend
  // restart, and crucially on unmount (a leaked interval keeps ticking after
  // the user leaves the card / logs in).
  const countdownRef = useRef<number | null>(null);

  const stopCountdown = () => {
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  };

  useEffect(() => () => stopCountdown(), []);

  const startResendCountdown = (ms: number) => {
    stopCountdown();
    const secs = Math.max(1, Math.ceil(ms / 1000));
    setResendIn(secs);
    countdownRef.current = window.setInterval(() => {
      setResendIn((prev) => {
        if (prev <= 1) {
          stopCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const send = async () => {
    if (!EMAIL_RE.test(email)) {
      setError('Enter a valid email address');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await requestOtp(email);
      setStep('code');
      startResendCountdown(res.resendableAfterMs);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send a code';
      setError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(email, code);
      onAuthenticated();
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        onMfaRequired(err.challengeToken, email);
        return;
      }
      const msg = err instanceof ApiError ? err.message : 'Could not verify the code';
      setError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'email') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="cc-field">
          <label htmlFor="otpEmail">Email</label>
          <input
            id="otpEmail"
            className="cc-input"
            type="email"
            required
            autoComplete="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {error && <p className="cc-error">{error}</p>}
        <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Sending…' : 'Send sign-in code'}
        </button>
        <p className="cc-hint">We will email a one-time code. No password needed.</p>
      </form>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="cc-field">
        <label htmlFor="otpEmail">Email</label>
        <input id="otpEmail" type="email" className="cc-input" value={email} disabled />
      </div>
      <div className="cc-field">
        <label htmlFor="otpCode">6-digit code</label>
        <input
          id="otpCode"
          className="cc-input"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </div>
      {error && <p className="cc-error">{error}</p>}
      <button
        className="cc-btn cc-btn--gradient"
        type="submit"
        disabled={busy || !/^\d{6}$/.test(code)}
        style={{ width: '100%' }}
      >
        {busy ? 'Verifying…' : 'Verify code'}
      </button>
      <p className="cc-auth__hint">
        {resendIn > 0 ? (
          <span>Resend available in {resendIn}s</span>
        ) : (
          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void send()}>
            Resend code
          </button>
        )}
        <span className="cc-hint"> · Code expires in 10 minutes and works once.</span>
      </p>
    </form>
  );
}