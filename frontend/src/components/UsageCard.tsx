/**
 * CodeConClave — UsageCard: compact server-authoritative usage summary.
 * Reads GET /api/v1/workspace/usage/overview; shows loading, error and
 * empty states. Numbers come from the server (measured vs estimated),
 * never from local state.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { UsageOverview } from '../lib/types';

export function UsageCard() {
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    void api<{ overview: UsageOverview }>('/api/v1/workspace/usage/overview')
      .then((res) => {
        if (cancelled) return;
        setOverview(res.overview ?? null);
        setState(res.overview ? 'ready' : 'error');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') return <p className="cc-hint">Loading usage…</p>;
  if (state === 'error') return <p className="cc-error">Could not load usage.</p>;

  const o = overview!;
  const storageMb = (o.measured.storageBytes / (1024 * 1024)).toFixed(1);
  const reset = o.resetDate ? new Date(o.resetDate).toLocaleDateString() : '—';

  return (
    <div>
      <p className="cc-hint">
        Plan <strong>{o.plan.toUpperCase()}</strong> · resets {reset}
      </p>
      <table className="cc-table">
        <tbody>
          <tr>
            <td>Messages today</td>
            <td>
              {o.measured.messagesToday.toLocaleString()} / {o.limits.dailyMessages}
            </td>
          </tr>
          <tr>
            <td>Tasks today</td>
            <td>{o.measured.tasksToday.toLocaleString()}</td>
          </tr>
          <tr>
            <td>AI tokens</td>
            <td>
              {(o.measured.aiInputTokens + o.measured.aiOutputTokens).toLocaleString()} (in{' '}
              {o.measured.aiInputTokens.toLocaleString()} / out {o.measured.aiOutputTokens.toLocaleString()})
            </td>
          </tr>
          <tr>
            <td>Storage</td>
            <td>
              {storageMb} MB / {o.limits.storageGb} GB
            </td>
          </tr>
          {o.estimated.sources > 0 && (
            <tr>
              <td>Compute estimate</td>
              <td>${o.estimated.computeCostUsd.toFixed(4)} (estimated)</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}