/**
 * Settings → Usage: "Your usage" (live plan limits, Claude-style) on top,
 * then your token history from /api/v1/usage/summary — today, the selected
 * period, a per-day strip, and which models answered. Costs are estimates.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { usePlanLimits } from '../lib/usage';
import { engineLabel } from '../lib/engine';
import { PlanLimitsCard } from './PlanLimitsCard';

interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface UsageSummary {
  days: number;
  totals: Totals;
  today: Totals;
  byDay: (Totals & { day: string })[];
  byModel: (Totals & { providerId: string; modelId: string })[];
}

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One row per engine label ("only our AI": cloud engines are merged). */
function byEngine(rows: UsageSummary['byModel']): (Totals & { label: string })[] {
  const merged = new Map<string, Totals & { label: string }>();
  for (const m of rows) {
    const label = engineLabel(m.providerId, m.modelId);
    const cur = merged.get(label) ?? { label, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    cur.requests += m.requests;
    cur.inputTokens += m.inputTokens;
    cur.outputTokens += m.outputTokens;
    cur.costUsd += m.costUsd;
    merged.set(label, cur);
  }
  return [...merged.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

export function UsagePanel() {
  const [days, setDays] = useState(30);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const live = usePlanLimits();
  // Reload the history only when the live check sees usage actually move.
  const weekUsed = live.limits?.weekly.used ?? null;

  useEffect(() => {
    let alive = true;
    setState((prev) => (prev === 'ready' ? prev : 'loading'));
    api<{ usage: UsageSummary }>(`/api/v1/usage/summary?days=${days}`)
      .then((res) => {
        if (!alive) return;
        setUsage(res.usage);
        setState('ready');
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
    };
  }, [days, weekUsed]);

  // Fill missing days so the strip reads as a real timeline.
  const series = useMemo(() => {
    if (!usage) return [];
    const byDay = new Map(usage.byDay.map((d) => [d.day, d.inputTokens + d.outputTokens]));
    const out: { day: string; tokens: number }[] = [];
    for (let i = usage.days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ day: d, tokens: byDay.get(d) ?? 0 });
    }
    return out;
  }, [usage]);
  const peak = Math.max(1, ...series.map((s) => s.tokens));

  return (
    <div className="cc-card us-panel" data-testid="usage-panel">
      {live.limits ? (
        <PlanLimitsCard limits={live.limits} checkedAt={live.checkedAt} onRefresh={() => void live.refresh()} />
      ) : live.state === 'loading' ? (
        <p className="cc-hint">Checking your plan usage…</p>
      ) : (
        <p className="cc-error">Could not check your plan usage right now.</p>
      )}
      <div className="us-head">
        <h3 style={{ margin: 0 }}>Token history</h3>
        <select className="cc-select cc-select--sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Usage period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {state === 'loading' && <p className="cc-hint">Loading usage…</p>}
      {state === 'error' && <p className="cc-error">Could not load usage.</p>}
      {state === 'ready' && usage && (
        <>
          <div className="us-stats">
            <div className="us-stat">
              <span className="us-stat-label">Today</span>
              <span className="us-stat-value">{fmt(usage.today.inputTokens + usage.today.outputTokens)}</span>
              <span className="us-stat-sub">tokens · {usage.today.requests} requests</span>
            </div>
            <div className="us-stat">
              <span className="us-stat-label">Last {usage.days} days</span>
              <span className="us-stat-value">{fmt(usage.totals.inputTokens + usage.totals.outputTokens)}</span>
              <span className="us-stat-sub">
                {fmt(usage.totals.inputTokens)} in · {fmt(usage.totals.outputTokens)} out
              </span>
            </div>
            <div className="us-stat">
              <span className="us-stat-label">Requests</span>
              <span className="us-stat-value">{fmt(usage.totals.requests)}</span>
              <span className="us-stat-sub">≈ ${usage.totals.costUsd.toFixed(2)} estimated</span>
            </div>
          </div>

          <div className="us-strip" role="img" aria-label={`Daily tokens over the last ${usage.days} days`}>
            {series.map((s) => (
              <span key={s.day} className="us-bar" title={`${s.day}: ${s.tokens.toLocaleString()} tokens`}>
                <span style={{ height: `${Math.max(s.tokens > 0 ? 6 : 2, (s.tokens / peak) * 100)}%` }} className={s.tokens > 0 ? 'is-used' : ''} />
              </span>
            ))}
          </div>

          <h4 className="us-subhead">By engine</h4>
          {usage.byModel.length === 0 ? (
            <p className="cc-hint">No AI requests in this period yet.</p>
          ) : (
            <table className="us-table">
              <thead>
                <tr>
                  <th>Engine that answered</th>
                  <th>Requests</th>
                  <th>Tokens</th>
                  <th>Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {byEngine(usage.byModel).map((m) => (
                  <tr key={m.label}>
                    <td>{m.label}</td>
                    <td>{m.requests}</td>
                    <td>{fmt(m.inputTokens + m.outputTokens)}</td>
                    <td>${m.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="cc-hint">Token counts are the real numbers each engine reported; costs are estimates.</p>
        </>
      )}
    </div>
  );
}
