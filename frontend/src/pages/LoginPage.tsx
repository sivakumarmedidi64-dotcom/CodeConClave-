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
  const { login, founderAccess, loginWithHandle, verifySecurityKeyChallenge, beginRecovery, completeRecovery } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = ((location.state ?? {}) as { from?: string }).from ?? '/home';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Zero-domain identity is the primary customer sign-in path: identifier
  // (email or handle) -> keyword -> account-key challenge when required.
  // Email+password and the emailed sign-in code remain available as
  // alternatives; there is no third-party identity-provider choice.
  const [mode, setMode] = useState<'password' | 'otp' | 'handle'>('handle');
  const [handle, setHandle] = useState('');
  const [keyword, setKeyword] = useState('');
  const [keyChallenge, setKeyChallenge] = useState<{ challengeToken: string; reason: string | null } | null>(null);
  const [accountKey, setAccountKey] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState('');
  const [ownerVisible, setOwnerVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onOtpDone = () => navigate(from, { replace: true });
  const onOtpMfa = (challengeToken: string, otpEmail: string) => navigate('/mfa', { state: { challengeToken, email: otpEmail } });

  const submitHandle = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setKeyChallenge(null);
    try {
      await loginWithHandle(handle, keyword);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        if (err.method === 'security_key') {
          // Unknown device or enrolled second factor: key challenge required.
          setKeyChallenge({ challengeToken: err.challengeToken, reason: err.reason });
          return;
        }
        navigate('/mfa', { state: { challengeToken: err.challengeToken, email: handle } });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Login failed');
      toast('Login failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitKeyChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyChallenge) return;
    setBusy(true);
    setError(null);
    try {
      await verifySecurityKeyChallenge(keyChallenge.challengeToken, accountKey);
      setKeyChallenge(null);
      setAccountKey('');
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Key verification failed — login again for a fresh challenge');
      setKeyChallenge(null);
      toast('Key verification failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!recoveryToken) {
        // Step 1: handle + account key → single-use recovery token.
        const token = await beginRecovery(handle, accountKey);
        setRecoveryToken(token);
        setAccountKey('');
      } else {
        // Step 2: token + new keyword → session (all sessions revoked server-side).
        await completeRecovery(recoveryToken, newKeyword);
        setRecoveryToken(null);
        setNewKeyword('');
        navigate(from, { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Recovery failed');
      toast('Recovery failed', 'error');
    } finally {
      setBusy(false);
    }
  };

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
          <p className="cc-auth__sub">
            Sign in with your CodeConClave identity — your email or handle, plus your keyword.
          </p>
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
          ) : mode === 'otp' ? (
            <OtpSignIn onAuthenticated={onOtpDone} onMfaRequired={onOtpMfa} />
          ) : recovering ? (
            <form onSubmit={submitRecovery}>
              <p className="cc-auth__sub">
                {!recoveryToken
                  ? 'Enter your handle and account key. No email reset exists by design.'
                  : 'Key verified. Set a new keyword — all sessions are revoked.'}
              </p>
              {!recoveryToken ? (
                <>
                  <div className="cc-field">
                    <label htmlFor="rec-handle">Handle</label>
                    <input
                      id="rec-handle"
                      className="cc-input"
                      required
                      autoComplete="username"
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                    />
                  </div>
                  <div className="cc-field">
                    <label htmlFor="rec-key">Account key</label>
                    <input
                      id="rec-key"
                      className="cc-input"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      value={accountKey}
                      onChange={(e) => setAccountKey(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="cc-field">
                  <label htmlFor="rec-newkeyword">New keyword</label>
                  <input
                    id="rec-newkeyword"
                    className="cc-input"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                  />
                </div>
              )}
              {error && <p className="cc-error">{error}</p>}
              <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Working…' : !recoveryToken ? 'Verify key' : 'Set new keyword'}
              </button>
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => { setRecovering(false); setRecoveryToken(null); setError(null); }}>
                Back to sign in
              </button>
            </form>
          ) : keyChallenge ? (
            <form onSubmit={submitKeyChallenge}>
              <p className="cc-auth__sub">
                {keyChallenge.reason === 'unknown_device'
                  ? 'Unrecognized device — enter your 32-character account key to continue. This device is not blocked.'
                  : 'Your account requires its account key on this device.'}
              </p>
              <div className="cc-field">
                <label htmlFor="challenge-key">Account key</label>
                <input
                  id="challenge-key"
                  className="cc-input"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  value={accountKey}
                  onChange={(e) => setAccountKey(e.target.value)}
                />
              </div>
              {error && <p className="cc-error">{error}</p>}
              <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Verifying…' : 'Verify key'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitHandle}>
              <div className="cc-field">
                <label htmlFor="handle">Email or handle</label>
                <input
                  id="handle"
                  className="cc-input"
                  required
                  autoComplete="username"
                  placeholder="you@example.com or your_handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                />
              </div>
              <div className="cc-field">
                <label htmlFor="keyword">Keyword</label>
                <input
                  id="keyword"
                  className="cc-input"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                <span className="cc-hint">Your account key may be requested on an unrecognized device.</span>
              </div>
              {error && <p className="cc-error">{error}</p>}
              <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="cc-auth__hint">
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => { setRecovering(true); setError(null); }}>
                  Forgot keyword? Recover with account key
                </button>
              </p>
            </form>
          )}
          <p className="cc-auth__hint">
            {mode === 'password' ? (
              <>
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('otp')}>
                  Use a sign-in code instead
                </button>{' '}
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('handle')}>
                  Use handle + keyword instead
                </button>
              </>
            ) : mode === 'otp' ? (
              <>
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('password')}>
                  Use email + password instead
                </button>{' '}
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('handle')}>
                  Use handle + keyword instead
                </button>
              </>
            ) : (
              <>
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => { setMode('password'); setRecovering(false); setKeyChallenge(null); }}>
                  Use email + password instead
                </button>{' '}
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('otp')}>
                  Use a sign-in code instead
                </button>
              </>
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