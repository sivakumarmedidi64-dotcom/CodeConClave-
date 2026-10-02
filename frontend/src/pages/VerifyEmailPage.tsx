/**
 * CodeConClave — email verification landing page.
 * Reads the one-time token from ?token=, verifies it server-side, and
 * reflects the outcome (success / expired / already used / invalid).
 * The server is the authority: this page only reports what the API says.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ApiError } from '../lib/api';
import { BrandLogo } from '../components/BrandLogo';

type Outcome = 'verifying' | 'success' | 'error';

export function VerifyEmailPage() {
  const { verifyEmail } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [outcome, setOutcome] = useState<Outcome>('verifying');
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setOutcome('error');
      setMessage('This verification link is missing a token. Please use the link from your email.');
      return;
    }
    void verifyEmail(token)
      .then(() => setOutcome('success'))
      .catch((err) => {
        setOutcome('error');
        if (err instanceof ApiError) {
          setMessage(err.message);
        } else {
          setMessage('Verification failed. Please try again.');
        }
      });
  }, [token, verifyEmail]);

  return (
    <div className="cc-auth">
      <div className="cc-auth__card">
        <div className="cc-auth__brand">
          <BrandLogo variant="lockup" height={44} />
        </div>
        <h2>Email verification</h2>
        {outcome === 'verifying' && (
          <p className="cc-hint">
            <span className="cc-spinner" style={{ display: 'inline-block', marginRight: 8 }} />
            Verifying your email…
          </p>
        )}
        {outcome === 'success' && (
          <p>
            <strong>Email verified.</strong> Your account is ready.
          </p>
        )}
        {outcome === 'error' && <p className="cc-error">{message}</p>}
        {outcome !== 'verifying' && (
          <p className="cc-hint" style={{ marginTop: 14 }}>
            {outcome === 'error' ? (
              <>
                <Link to="/login">Sign in to request a new link</Link>
              </>
            ) : (
              <Link to="/login">Continue to sign in</Link>
            )}
          </p>
        )}
      </div>
    </div>
  );
}