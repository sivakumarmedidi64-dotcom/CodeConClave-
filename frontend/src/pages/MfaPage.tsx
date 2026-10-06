/**
 * CodeConClave — MFA verification (TOTP code or recovery code).
 * challengeToken is passed from /login via router state. Identity-login
 * challenges are single-use `imfa_` challenges verified by
 * /identity/mfa/verify; legacy challenges go to /auth/mfa/verify.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { BrandLogo } from '../components/BrandLogo';

export function MfaPage() {
  const { verifyMfa, verifyIdentityMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as { challengeToken?: string; email?: string; identityChallenge?: boolean };
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state.challengeToken) {
      setError('Missing challenge — sign in again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (state.identityChallenge) {
        await verifyIdentityMfa(state.challengeToken, recovery ? { recoveryCode: recovery } : { code: code || undefined });
      } else {
        await verifyMfa(state.challengeToken, code || undefined, recovery || undefined);
      }
      navigate('/home', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cc-auth">
      <div className="cc-auth__card">
        <div className="cc-auth__brand">
          <BrandLogo variant="lockup" height={44} />
        </div>
        <h2>Two-factor verification</h2>
        {state.email && <p className="cc-hint">{state.email}</p>}
        <form onSubmit={submit}>
          <div className="cc-field">
            <label htmlFor="code">Authenticator code</label>
            <input
              id="code"
              className="cc-input"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="cc-field">
            <label htmlFor="recovery">…or recovery code</label>
            <input
              id="recovery"
              className="cc-input"
              inputMode="text"
              placeholder="XXXX-XXXXXX"
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            />
          </div>
          {error && <p className="cc-error">{error}</p>}
          <button className="cc-btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </form>
      </div>
    </div>
  );
}