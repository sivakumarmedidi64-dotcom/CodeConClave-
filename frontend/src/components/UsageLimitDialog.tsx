/**
 * Limit Guard — like Claude: when CodeConClave AI can't answer because a usage
 * window is full (or there is no plan), a clear pop-up says which limit, when it
 * resets (live countdown) and what you can do. Before that, a quiet banner
 * warns when a window is nearly used up. All numbers come from the server
 * (/api/v1/usage/limits and the error's own details) — nothing is estimated.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { usePlanLimits } from '../lib/usage';

export const USAGE_LIMIT_HIT = 'cc:usage-limit-hit';

export interface LimitHit {
  code: 'usage_limit_reached' | 'plan_required';
  message: string;
  window?: 'session' | 'weekly';
  resetsAt?: string | null;
  used?: number;
  limit?: number;
  plan?: string;
}

const LIMIT_CODES = new Set(['usage_limit_reached', 'plan_required']);

/** Call from any composer's error handler; returns true when it was a limit. */
export function reportLimitError(code: string | undefined, message: string, details?: unknown): boolean {
  if (!code || !LIMIT_CODES.has(code)) return false;
  const d = (details && typeof details === 'object' ? details : {}) as Record<string, unknown>;
  const hit: LimitHit = {
    code: code as LimitHit['code'],
    message,
    window: d.window === 'weekly' ? 'weekly' : d.window === 'session' ? 'session' : undefined,
    resetsAt: typeof d.resetsAt === 'string' ? d.resetsAt : null,
    used: typeof d.used === 'number' ? d.used : undefined,
    limit: typeof d.limit === 'number' ? d.limit : undefined,
    plan: typeof d.plan === 'string' ? d.plan : undefined,
  };
  window.dispatchEvent(new CustomEvent<LimitHit>(USAGE_LIMIT_HIT, { detail: hit }));
  return true;
}

/** "in 2 hr 10 min" / "in 5 min" / "now". Pure. */
export function untilText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'soon';
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 48 * 60) return `in ${Math.floor(mins / 60)} hr ${mins % 60} min`;
  return `in ${Math.round(mins / 1440)} days`;
}

function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`;
}

export function UsageLimitDialog({ hit, onClose }: { hit: LimitHit; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const noPlan = hit.code === 'plan_required';
  const title = noPlan ? 'Choose a plan to use CodeConClave AI' : hit.window === 'weekly' ? "You've reached your weekly limit" : "You've reached your session limit";
  const pct = hit.used !== undefined && hit.limit ? Math.min(100, Math.round((hit.used / hit.limit) * 100)) : null;

  return (
    <div className="sp-overlay lf-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="sp-modal cc-limit" onClick={(e) => e.stopPropagation()}>
        <div className="cc-limit__icon" aria-hidden="true">
          <Icon name={noPlan ? 'wallet' : 'clock'} size={22} />
        </div>
        <h2 className="cc-limit__title">{title}</h2>
        {noPlan ? (
          <p className="cc-limit__body">{hit.message}</p>
        ) : (
          <>
            <p className="cc-limit__body">
              {hit.window === 'weekly' ? 'Your weekly usage' : 'Your 5-hour session'} resets at <strong>{clock(hit.resetsAt)}</strong> — {untilText(hit.resetsAt, now)}. You can keep
              reading chats, files and reports; new AI answers wait until then.
            </p>
            {pct !== null && (
              <div className="cc-limit__meter" aria-label={`${pct}% used`}>
                <span style={{ width: `${pct}%` }} />
              </div>
            )}
          </>
        )}
        <div className="cc-limit__actions">
          <Link className="cc-btn cc-btn--primary cc-btn--sm" to={noPlan ? '/settings?tab=billing' : '/settings?tab=usage'} onClick={onClose}>
            {noPlan ? 'See plans' : 'View usage'}
          </Link>
          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in the app shell: shows the dialog whenever a limit is hit. */
export function UsageLimitHost() {
  const [hit, setHit] = useState<LimitHit | null>(null);
  useEffect(() => {
    const on = (e: Event) => setHit((e as CustomEvent<LimitHit>).detail);
    window.addEventListener(USAGE_LIMIT_HIT, on);
    return () => window.removeEventListener(USAGE_LIMIT_HIT, on);
  }, []);
  return hit ? <UsageLimitDialog hit={hit} onClose={() => setHit(null)} /> : null;
}

/**
 * A quiet heads-up before the wall: session ≥ 80% or week ≥ 90% used.
 * Dismissable until that window resets.
 */
export function UsageNearLimit() {
  const { limits } = usePlanLimits();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('cc:near-limit-dismissed');
    } catch {
      return null;
    }
  });
  if (!limits || limits.plan === 'none') return null;
  const s = limits.session;
  const w = limits.weekly;
  const which = w.limit > 0 && w.pct >= 90 ? { label: 'this week', win: w } : s.limit > 0 && s.pct >= 80 ? { label: 'this session', win: s } : null;
  if (!which || which.win.pct >= 100) return null;
  const key = `${which.label}:${which.win.resetsAt ?? ''}`;
  if (dismissed === key) return null;
  return (
    <div className="cc-nearlimit" role="status" data-testid="near-limit">
      <Icon name="gauge" size={14} />
      <span>
        You've used <strong>{Math.round(which.win.pct)}%</strong> of {which.label} · resets {untilText(which.win.resetsAt)}
      </span>
      <Link to="/settings?tab=usage">Usage</Link>
      <button
        type="button"
        className="cc-icon-btn"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(key);
          try {
            sessionStorage.setItem('cc:near-limit-dismissed', key);
          } catch {
            /* fine */
          }
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
