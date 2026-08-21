/**
 * CodeConClave — registration (displayName optional).
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';

export function RegisterPage() {
  const { register, sendVerificationEmail } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, password, displayName || undefined);
      // Best-effort verification email; never blocks registration.
      sendVerificationEmail().catch(() => undefined);
      navigate('/home', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        toast(err.message, 'error');
      } else {
        setError('Registration failed');
        toast('Registration failed', 'error');
      }
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
        <h2>Create account</h2>
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
            <label htmlFor="displayName">Display name</label>
            <input
              id="displayName"
              className="cc-input"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="cc-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="cc-input"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="cc-hint">At least 10 chars, upper + lower + digit.</span>
          </div>
          {error && <p className="cc-error">{error}</p>}
          <button className="cc-btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
        <p className="cc-hint" style={{ marginTop: 14 }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}