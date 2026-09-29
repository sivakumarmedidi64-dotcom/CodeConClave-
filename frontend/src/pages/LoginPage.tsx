/**
 * CodeConClave — login (email+password, email sign-in code, MFA challenge redirection).
 * Discreet account-owner sign-in: the designated owner authenticates with their
 * account password (no OTP). It is never triggered by typing an email alone.
 */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, MfaRequiredError } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { BrandLogo } from '../components/BrandLogo';
import { OtpSignIn } from '../auth/OtpSignIn';

const FOUNDER_EMAIL = 'medidisaharsh@gmail.com';

export function LoginPage() {
  const { login, founderAccess } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = ((location.state ?? {}) as { from?: string }).from ?? '/home';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [ownerVisible, setOwnerVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onOtpDone = () => navigate(from, { replace: true });
  const onOtpMfa = (challengeToken: string, otpEmail: string) => navigate('/mfa', { state: { challengeToken, email: otpEmail } });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        navigate('/mfa', { state: { challengeToken: err.challengeToken, email } });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Login failed');
      toast('Login failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const ownerSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const emailValue = email.trim();
    if (!emailValue || !password) {
      setError('Email and password are required');
      return;
    }
    setOwnerBusy(true);
    setError(null);
    try {
      await founderAccess(emailValue, password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        navigate('/mfa', { state: { challengeToken: err.challengeToken, email: emailValue } });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Account owner sign-in failed');
      toast('Account owner sign-in failed', 'error');
    } finally {
      setOwnerBusy(false);
    }
  };

  return (
    <div className="cc-auth">
      <div className="cc-auth__panel">
        <div className="cc-auth__card">
          <div className="cc-auth__brand">
            <BrandLogo variant="lockup" height={44} />
          </div>
          <h2>Welcome back</h2>
          <p className="cc-auth__sub">Sign in to your CodeConClave workspace to keep building.</p>
          {mode === 'password' ? (
            <form onSubmit={submit}>
              <div className="cc-field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  className="cc-input"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="user@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="cc-field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  className="cc-input"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && <p className="cc-error">{error}</p>}
              <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : (
            <OtpSignIn onAuthenticated={onOtpDone} onMfaRequired={onOtpMfa} />
          )}
          <p className="cc-auth__hint">
            {mode === 'password' ? (
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('otp')}>
                Use a sign-in code instead
              </button>
            ) : (
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('password')}>
                Use email + password instead
              </button>
            )}
          </p>
          <p className="cc-auth__hint">
            New here? <Link to="/register">Create an account</Link>
          </p>
          {ownerVisible || (
            <button
              type="button"
              className="cc-btn cc-btn--ghost cc-btn--sm"
              style={{ width: '100%', color: 'var(--cc-text-tertiary, #8a93a6)' }}
              onClick={() => {
                setOwnerVisible(true);
                setError(null);
              }}
            >
              Account owner sign-in
            </button>
          )}
          {ownerVisible && (
            <form onSubmit={ownerSignIn} style={{ marginTop: '0.25rem' }}>
              <div className="cc-field">
                <label htmlFor="owner-email">Owner email</label>
                <input
                  id="owner-email"
                  className="cc-input"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="owner@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="cc-field">
                <label htmlFor="owner-password">Password</label>
                <input
                  id="owner-password"
                  className="cc-input"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && <p className="cc-error">{error}</p>}
              <button className="cc-btn cc-btn--gradient" type="submit" disabled={ownerBusy} style={{ width: '100%' }}>
                {ownerBusy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
          <p className="cc-auth__hint" style={{ marginTop: '1rem' }}>
            <a className="cc-btn cc-btn--ghost cc-btn--sm" href={`mailto:${FOUNDER_EMAIL}`}>
              Contact the founder
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}