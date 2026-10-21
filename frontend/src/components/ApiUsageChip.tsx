/**
 * Live API meter (top right): prepaid credits left plus today's real calls
 * across your active SHA_live_ keys, refreshed every 15s from the same
 * counters and ledger the API gate enforces. Turns red near empty and says
 * "Top up" at ₹0. Hidden when you have no keys.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

interface ApiUsage {
  today: number;
  dailyLimitPerKey: number;
  windowLimit: number;
  windowSeconds: number;
  keys: { id: string; name: string; today: number }[];
}

export interface ApiCredits {
  balancePaise: number;
  grantedPaise: number;
  spentPaise: number;
  calls: number;
  exhausted: boolean;
  topupInr: number;
}

const POLL_MS = 15_000;

export const inr = (paise: number) => {
  const v = Math.max(0, Math.round(paise));
  return `₹${(v / 100).toLocaleString('en-IN', { minimumFractionDigits: v % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
};

export function ApiUsageChip() {
  const [usage, setUsage] = useState<ApiUsage | null>(null);
  const [credits, setCredits] = useState<ApiCredits | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const res = await api<ApiUsage>('/api/v1/apikeys/usage');
        if (alive) setUsage(res);
        if (alive && Array.isArray(res?.keys) && res.keys.length > 0) {
          const c = await api<{ credits: ApiCredits }>('/api/v1/apikeys/credits').catch(() => null);
          if (alive) setCredits(c?.credits ?? null);
        }
      } catch {
        if (alive) setUsage(null);
      }
      if (alive) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);
  if (!usage || !Array.isArray(usage.keys) || usage.keys.length === 0) return null;

  const left = credits ? credits.balancePaise : null;
  const share = credits && credits.grantedPaise > 0 ? Math.max(0, Math.min(100, Math.round((credits.balancePaise / credits.grantedPaise) * 100))) : null;
  const low = share !== null && share <= 10;
  const empty = credits?.exhausted === true;
  return (
    <Link
      to="/settings?tab=apikeys"
      className={`cc-apichip${empty || low ? ' is-hot' : ''}`}
      title={
        credits
          ? `API credits: ${inr(credits.balancePaise)} left of ${inr(credits.grantedPaise)} · ${usage.today} calls today`
          : `API calls today: ${usage.today}`
      }
      aria-label={empty ? 'API credits used up — top up' : `API credits ${left !== null ? inr(left) : ''} left, ${usage.today} calls today`}
      data-testid="api-usage-chip"
    >
      <span className="cc-apichip__dot" aria-hidden="true" />
      {empty ? (
        <>API · Top up {inr((credits?.topupInr ?? 50_000) * 100)}</>
      ) : (
        <>
          API {left !== null ? inr(left) : ''} · {usage.today.toLocaleString()} today
        </>
      )}
      {share !== null && (
        <span className="cc-apichip__bar" aria-hidden="true">
          <span style={{ width: `${share}%` }} />
        </span>
      )}
    </Link>
  );
}
