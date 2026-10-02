/**
 * CodeConClave — 404 page for unknown routes inside the shell.
 */
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="cc-page">
      <div className="cc-card cc-error-state">
        <h1>404 — page not found</h1>
        <p className="cc-hint">
          This address is not part of the CodeConClave workspace. Check the navigation
          or head back home.
        </p>
        <Link className="cc-btn" to="/home">
          Back to Home
        </Link>
      </div>
    </div>
  );
}