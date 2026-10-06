/**
 * CodeConClave — customer login.
 *
 * One sign-in path: identifier (email or handle) → keyword → the account key
 * when the account or an unrecognized device demands it. Legacy email+password,
 * the emailed sign-in code, and account-owner sign-in remain backend routes for
 * legacy clients but are intentionally not offered in the customer UI, so no
 * customer payload can trip the legacy schema that surfaced "Invalid request
 * payload".
 */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, MfaRequiredError } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { BrandLogo } from '../components/BrandLogo';

export function LoginPage() {
  const { loginWithHandle, verifySecurityKeyChallenge, beginRecovery, completeRecovery } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = ((location.state ?? {}) as { from?: string }).from ?? '/home';
  const [handle, setHandle] = useState('');
  const [keyword, setKeyword] = useState('');
  const [keyChallenge, setKeyChallenge] = useState<{ challengeToken: string; reason: string | null } | null>(null);
  const [accountKey, setAccountKey] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goHome = () => navigate(from, { replace: true });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setKeyChallenge(null);
    try {
      await loginWithHandle(handle, keyword);
      goHome();
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        if (err.method === 'security_key') {
          // Unknown device or enrolled second factor: key challenge required.
          setKeyChallenge({ challengeToken: err.challengeToken, reason: err.reason });
          return;
        }
        navigate('/mfa', { state: { challengeToken: err.challengeToken, email: handle, identityChallenge: true } });
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
      goHome();
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
        goHome();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Recovery failed');
      toast('Recovery failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const backToSignIn = () => {
    setRecovering(false);
    setKeyChallenge(null);
    setRecoveryToken(null);
    setError(null);
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
          {recovering ? (
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
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={backToSignIn}>
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
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={backToSignIn}>
                Back to sign in
              </button>
            </form>
          ) : (
            <form onSubmit={submit}>
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
                <button
                  type="button"
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  onClick={() => {
                    setRecovering(true);
                    setError(null);
                  }}
                >
                  Forgot keyword? Recover with account key
                </button>
              </p>
            </form>
          )}
          <p className="cc-auth__hint">
            <Link to="/register" className="cc-btn cc-btn--ghost cc-btn--sm">
              New here? Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}