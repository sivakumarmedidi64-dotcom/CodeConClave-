import { Component, ErrorInfo, ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    window.location.href = '/home';
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="cc-error-screen">
          <div className="cc-error-card">
            <div className="cc-error-badge" aria-hidden="true">
              <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h1 className="cc-error-card__title">Something went wrong</h1>
            <p className="cc-error-card__sub">Your work is safe — conversations, tasks and memory live on the server. Reload to continue.</p>
            <div className="cc-error-card__actions">
              <button onClick={this.handleReload} className="cc-btn">
                Reload Page
              </button>
              <button onClick={this.handleGoHome} className="cc-btn cc-btn--ghost">
                Go Home
              </button>
            </div>
            <details className="cc-error-card__details">
              <summary className="cc-error-card__summary">Error Details</summary>
              <pre className="cc-error-card__pre">
                {this.state.error?.message}
                {this.state.error?.stack}
              </pre>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}