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
  const { register, sendVerificationEmail, confirmSecurityKey } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('');
  const [useCase, setUseCase] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'register' | 'otp'>('register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Zero-domain account key: shown exactly once, never persisted client-side.
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState('');
  const onOtpDone = () => navigate('/home', { replace: true });
  const onOtpMfa = (challengeToken: string, otpEmail: string) => navigate('/mfa', { state: { challengeToken, email: otpEmail } });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const identity = handle.trim() && keyword ? { handle: handle.trim(), keyword } : undefined;
      const res = await register(email, password, displayName || undefined, role ? { role, primaryUseCase: useCase || undefined } : undefined, identity);
      // Best-effort verification email; never blocks registration.
      sendVerificationEmail().catch(() => undefined);
      if (res.securityKey) {
        // Zero-domain: show the account key once and require paste-back
        // confirmation before entering the app.
        setIssuedKey(res.securityKey);
        return;
      }
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

  const submitConfirmKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmSecurityKey(confirmKey);
      setIssuedKey(null);
      setConfirmKey('');
      navigate('/home', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Key confirmation failed — paste the exact key shown');
      toast('Key confirmation failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (issuedKey) {
    return (
      <div className="cc-auth">
        <div className="cc-auth__panel">
          <div className="cc-auth__card">
            <div className="cc-auth__brand">
              <BrandLogo variant="lockup" height={44} />
            </div>
            <h2>Save your account key</h2>
            <p className="cc-auth__sub">
              This 32-character key is shown <strong>once</strong>. It is your only recovery
              if you forget your keyword — there is no email reset. Store it somewhere safe,
              then paste it back to confirm.
            </p>
            <p className="cc-key-once" data-testid="account-key-once">{issuedKey}</p>
            <form onSubmit={submitConfirmKey}>
              <div className="cc-field">
                <label htmlFor="confirm-key">Paste key to confirm you saved it</label>
                <input
                  id="confirm-key"
                  className="cc-input"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmKey}
                  onChange={(e) => setConfirmKey(e.target.value)}
                />
              </div>
              {error && <p className="cc-error">{error}</p>}
              <button className="cc-btn cc-btn--gradient" type="submit" disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Confirming…' : "I've saved it — continue"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-auth">
      <div className="cc-auth__panel">
        <div className="cc-auth__card">
          <div className="cc-auth__brand">
            <BrandLogo variant="lockup" height={44} />
          </div>
          <h2>Create account</h2>
          <p className="cc-auth__sub">
            Create your CodeConClave identity. We generate a 32-character account key, show it once, and ask you to paste
            it back to confirm.
          </p>
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
              <span className="cc-hint">Used for account notices and recovery contact.</span>
            </div>
            <fieldset className="cc-field" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="cc-hint" style={{ padding: 0, marginBottom: 10 }}>
                Your CodeConClave identity — these issue your 32-character account key.
              </legend>
              <div className="cc-field">
                <label htmlFor="handle">Handle</label>
                <input
                  id="handle"
                  className="cc-input"
                  required
                  minLength={3}
                  maxLength={20}
                  autoComplete="username"
                  placeholder="your_handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                />
                <span className="cc-hint">3–20 chars, letters/numbers/underscore. This is your primary sign-in name.</span>
              </div>
              <div className="cc-field">
                <label htmlFor="keyword">Keyword</label>
                <input
                  id="keyword"
                  className="cc-input"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                <span className="cc-hint">12+ chars, upper + lower + digit. Only its hash is stored.</span>
              </div>
            </fieldset>
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