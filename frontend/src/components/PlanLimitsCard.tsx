/**
 * "Your usage", Claude-style: plan, a pace line, the current session (starts
 * with your first message) and this week (resets Monday), this week's usage
 * by product, and when it was last checked. Data: /api/v1/usage/limits.
 */
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import {
  PRODUCT_LABEL,
  forecastLine,
  sessionLabel,
  updatedAgo,
  weeklyLabel,
  type PlanLimits,
  type Product,
  type WindowUsage,
} from '../lib/usage';

export type { PlanLimits, WindowUsage } from '../lib/usage';

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function Meter({ title, sub, w }: { title: string; sub: string; w: WindowUsage }) {
  const unlimited = w.limit === 0;
  const pct = unlimited ? 0 : w.pct;
  return (
    <div className="pl-row">
      <div className="pl-row__label">
        <strong>{title}</strong>
        <span className="cc-muted">{sub}</span>
      </div>
      <div className="pl-row__meter">
        <div
          className={`pl-meter__bar${pct >= 90 ? ' is-hot' : pct >= 75 ? ' is-warm' : ''}`}
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          title={unlimited ? `${fmt(w.used)} tokens` : `${fmt(w.used)} of ${fmt(w.limit)} tokens`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="pl-row__pct">{unlimited ? 'Unlimited' : `${pct}% used`}</span>
      </div>
    </div>
  );
}

export function PlanLimitsCard({
  limits,
  checkedAt = null,
  onRefresh,
}: {
  limits: PlanLimits;
  checkedAt?: number | null;
  onRefresh?: () => void;
}) {
  // Re-render each 20s so "Resets in…" and "Last updated…" stay true.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(t);
  }, []);

  const products = limits.byProduct;
  const weekTotal = products ? Object.values(products).reduce((a, b) => a + b, 0) : 0;

  return (
    <section className="pl-card" aria-label="Your usage" data-testid="plan-limits">
      <div className="pl-card__head">
        <h3>Your usage</h3>
        <span className="cc-pill">{limits.planLabel}</span>
      </div>
      <p className={limits.limited ? 'cc-error pl-forecast' : 'pl-forecast'} role="status">
        {forecastLine(limits)}
      </p>
      {limits.plan === 'none' && (
        <a className="cc-btn cc-btn--primary pl-cta" href="/settings?tab=billing">
          Choose a plan
        </a>
      )}

      <h4 className="pl-section">Plan usage limits</h4>
      <Meter title="Current session" sub={sessionLabel(limits.session, now)} w={limits.session} />

      <h4 className="pl-section">Weekly limits</h4>
      <Meter title="This week" sub={weeklyLabel(limits.weekly.resetsAt)} w={limits.weekly} />

      {products && (
        <>
          <h4 className="pl-section">This week&apos;s usage by product</h4>
          <ul className="pl-products" aria-label="This week's usage by product">
            {(Object.keys(PRODUCT_LABEL) as Product[]).map((p) => {
              const share = weekTotal > 0 ? Math.round((products[p] / weekTotal) * 100) : 0;
              return (
                <li key={p} className="pl-product">
                  <span>{PRODUCT_LABEL[p]}</span>
                  <span className="pl-product__bar" aria-hidden="true">
                    <span style={{ width: `${share}%` }} />
                  </span>
                  <span className="pl-product__pct" title={`${fmt(products[p])} tokens`}>
                    {share}%
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="pl-foot cc-muted">
        <span>Last updated: {updatedAgo(checkedAt, now)}</span>
        {onRefresh && (
          <button type="button" className="cc-icon-btn" onClick={onRefresh} aria-label="Check usage now" title="Check usage now">
            <Icon name="refresh" size={14} />
          </button>
        )}
      </div>
    </section>
  );
}
