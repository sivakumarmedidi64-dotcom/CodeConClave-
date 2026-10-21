/**
 * Settings → API keys: your prepaid API credits. ₹50,000 buys credits; every
 * API call uses its real token cost; at ₹0 calls stop until you top up.
 * Numbers come from the server ledger (GET /api/v1/apikeys/credits).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { inr, type ApiCredits } from './ApiUsageChip';

interface Entry {
  kind: 'GRANT' | 'DEBIT' | 'ADJUST';
  amountPaise: number;
  tokens: number | null;
  note: string | null;
  createdAt: string;
}

interface CreditsResponse {
  credits: ApiCredits & { rate: { paisePer1kTokens: number; minPaisePerCall: number }; lastTopupAt: string | null };
  entries: Entry[];
}

export function ApiCreditsCard() {
  const [data, setData] = useState<CreditsResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    api<CreditsResponse>('/api/v1/apikeys/credits')
      .then((r) => {
        setData(r?.credits ? { ...r, entries: Array.isArray(r.entries) ? r.entries : [] } : null);
        setState('ready');
      })
      .catch(() => setState('error'));
  }, []);

  if (state === 'loading') return <div className="cc-card"><p className="cc-hint">Loading API credits…</p></div>;
  if (state === 'error' || !data?.credits) return null;
  const c = data.credits;
  const share = c.grantedPaise > 0 ? Math.max(0, Math.min(100, Math.round((c.balancePaise / c.grantedPaise) * 100))) : 0;

  return (
    <div className="cc-card ac-card" data-testid="api-credits">
      <div className="ac-head">
        <h3 style={{ margin: 0 }}>API credits</h3>
        <span className={`cc-pill${c.exhausted ? ' ac-empty' : ''}`}>{c.exhausted ? 'Used up' : `${share}% left`}</span>
      </div>
      <div className="ac-balance">
        <strong>{inr(c.balancePaise)}</strong>
        <span className="cc-muted"> left of {inr(c.grantedPaise)} bought</span>
      </div>
      <div className="pl-meter__bar" role="progressbar" aria-label="API credits left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
        <span style={{ width: `${share}%` }} />
      </div>
      <p className="cc-hint" style={{ margin: '8px 0' }}>
        {c.calls.toLocaleString()} API calls · {inr(c.spentPaise)} used · each call costs {inr(c.rate.paisePer1kTokens)} per 1,000 tokens (minimum{' '}
        {inr(c.rate.minPaisePerCall)}).
      </p>
      {c.exhausted ? (
        <p className="cc-error" role="status">
          Your credits are used up, so the API is refusing new calls. Top up {inr(c.topupInr * 100)} to continue.
        </p>
      ) : null}
      <Link className={`cc-btn cc-btn--sm${c.exhausted ? ' cc-btn--primary' : ''}`} to="/settings?tab=billing">
        Top up {inr(c.topupInr * 100)}
      </Link>
      <p className="cc-hint" style={{ margin: '6px 0 0' }}>Credits are added automatically once the payment is verified.</p>
      {data.entries.length > 0 && (
        <details className="ac-ledger">
          <summary>Recent credit activity</summary>
          <ul>
            {data.entries.map((e, i) => (
              <li key={`${e.createdAt}-${i}`}>
                <span className={e.amountPaise >= 0 ? 'ac-plus' : 'ac-minus'}>
                  {e.amountPaise >= 0 ? '+' : '−'}
                  {inr(Math.abs(e.amountPaise))}
                </span>{' '}
                {e.kind === 'DEBIT' ? `API call · ${e.tokens?.toLocaleString() ?? 0} tokens` : (e.note ?? e.kind)}
                <span className="cc-muted"> · {new Date(e.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
