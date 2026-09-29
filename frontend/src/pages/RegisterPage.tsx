/**
 * CodeConClave — registration (displayName optional).
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { BrandLogo } from '../components/BrandLogo';
import { OtpSignIn } from '../auth/OtpSignIn';

export function RegisterPage() {
  const { register, sendVerificationEmail } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('');
  const [useCase, setUseCase] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'register' | 'otp'>('register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onOtpDone = () => navigate('/home', { replace: true });
  const onOtpMfa = (challengeToken: string, otpEmail: string) => navigate('/mfa', { state: { challengeToken, email: otpEmail } });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, password, displayName || undefined, role ? { role, primaryUseCase: useCase || undefined } : undefined);
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
      <div className="cc-auth__panel">
        <div className="cc-auth__card">
          <div className="cc-auth__brand">
            <BrandLogo variant="lockup" height={44} />
          </div>
          <h2>Create account</h2>
          <p className="cc-auth__sub">Start building with CodeConClave — your AI developer coworker.</p>
          {mode === 'register' ? (
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
              <label htmlFor="role">Your role</label>
              <select id="role" className="cc-input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">Select a role…</option>
                {['Developer', 'Founder', 'Student', 'Designer', 'Product', 'Other'].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="cc-field">
              <label htmlFor="useCase">Primary use case</label>
              <select id="useCase" className="cc-input" value={useCase} onChange={(e) => setUseCase(e.target.value)}>
                <option value="">Select a use case…</option>
                {['Build software', 'Debug/code', 'AI cowork', 'Automation', 'Research', 'Learning', 'Other'].map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
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
            <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
            </form>
          ) : (
            <OtpSignIn onAuthenticated={onOtpDone} onMfaRequired={onOtpMfa} />
          )}
          <p className="cc-auth__hint">
            {mode === 'register' ? (
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('otp')}>
                Have a sign-in code? Use it instead
              </button>
            ) : (
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setMode('register')}>
                Create an account with email instead
              </button>
            )}
          </p>
          <p className="cc-auth__hint">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}