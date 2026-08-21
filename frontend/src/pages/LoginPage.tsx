/**
 * CodeConClave — login (email+password, Google, MFA challenge redirection).
 */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, MfaRequiredError } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';

export function LoginPage() {
  const { login } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = ((location.state ?? {}) as { from?: string }).from ?? '/home';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="cc-auth">
      <div className="cc-auth__card">
        <div className="cc-auth__brand">
          <span className="cc-logo">C</span> CodeConClave
        </div>
        <h2>Sign in</h2>
        <form onSubmit={submit}>
          <div className="cc-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="cc-input"
              type="email"
              required
              autoComplete="email"
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
          <button className="cc-btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="cc-hint" style={{ marginTop: 14 }}>
          <a href="/api/v1/auth/google/authorize">Continue with Google</a>
        </p>
        <p className="cc-hint">
          New here? <Link to="/register">Create an account</Link>
        </p>
      </div>
    </div>
  );
}