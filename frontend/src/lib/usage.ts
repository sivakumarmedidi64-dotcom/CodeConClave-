/**
 * Live plan usage (Claude-style): session + weekly windows and this week by
 * product, from GET /api/v1/usage/limits. Re-checked every 30s while visible,
 * on focus, and whenever a reply finishes (USAGE_CHANGED).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fire after AI work finishes so live meters re-check right away. */
export const USAGE_CHANGED = 'cc:usage-changed';
export const notifyUsageChanged = () => window.dispatchEvent(new Event(USAGE_CHANGED));

export type Product = 'chats' | 'cowork' | 'code_review' | 'api_other';

export interface WindowUsage {
  used: number;
  limit: number;
  pct: number;
  windowLabel: string;
  resetsAt: string | null;
}

export interface PlanLimits {
  plan: string;
  planLabel: string;
  session: WindowUsage & { active?: boolean; startedAt?: string | null };
  weekly: WindowUsage;
  byProduct?: Record<Product, number>;
  forecast?: 'unlimited' | 'on_track' | 'heavy' | 'limited' | 'no_plan';
  limited: boolean;
}

export const PRODUCT_LABEL: Record<Product, string> = {
  chats: 'Chats',
  cowork: 'Cowork',
  code_review: 'Code review',
  api_other: 'API & other',
};

export function usePlanLimits(intervalMs = 30_000) {
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ limits: PlanLimits; checkedAt?: string }>('/api/v1/usage/limits');
      if (!alive.current || !res?.limits?.session) return;
      setLimits(res.limits);
      setCheckedAt(res.checkedAt ? Date.parse(res.checkedAt) : Date.now());
      setState('ready');
    } catch {
      if (alive.current) setState((s) => (s === 'ready' ? s : 'error'));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, intervalMs);
    const onWake = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    window.addEventListener('focus', onWake);
    window.addEventListener(USAGE_CHANGED, onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      alive.current = false;
      window.clearInterval(tick);
      window.removeEventListener('focus', onWake);
      window.removeEventListener(USAGE_CHANGED, onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [intervalMs, refresh]);

  return { limits, checkedAt, state, refresh };
}

/** "Resets in 3 hr 12 min" — or, before a session exists, Claude's wording. */
export function sessionLabel(s: PlanLimits['session'], now = Date.now()): string {
  if (!s.resetsAt || s.active === false) return 'Starts with your first message';
  const mins = Math.max(0, Math.round((Date.parse(s.resetsAt) - now) / 60_000));
  if (mins <= 0) return 'Resets now';
  if (mins < 60) return `Resets in ${mins} min`;
  return `Resets in ${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

/** "Resets Monday 12:00 AM" in the viewer's local time. */
export function weeklyLabel(iso: string | null): string {
  if (!iso) return 'Resets weekly';
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: 'long' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Resets ${day} ${time}`;
}

export function forecastLine(l: PlanLimits): string {
  const day = l.weekly.resetsAt ? new Date(l.weekly.resetsAt).toLocaleDateString(undefined, { weekday: 'long' }) : 'the weekly';
  switch (l.forecast) {
    case 'no_plan':
      return 'CodeConClave has no free tier. Choose Solo, Team or API Access to start working with CodeConClave AI.';
    case 'limited':
      return "You've reached a usage limit. New AI work pauses until it resets — or upgrade your plan for more.";
    case 'heavy':
      return `Heavy week. At this pace you may reach your weekly limit before ${day}'s reset.`;
    case 'unlimited':
      return 'Your plan has no token limits on this deployment.';
    default:
      return `On track. You should reach ${day}'s reset with room to spare.`;
  }
}

/** "less than a minute ago", "3 minutes ago". */
export function updatedAgo(at: number | null, now = Date.now()): string {
  if (!at) return 'never';
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return 'less than a minute ago';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}
