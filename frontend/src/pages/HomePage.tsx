/**
 * CodeConClave — Home: return-to-work ("While you were away") summary,
 * quick actions, usage, and a continuity strip.
 * Loading / error / empty states are explicit; quick actions and the
 * return-to-work actions navigate to real workspaces. The summary is only
 * ever shown when the server returned one and it is not dismissed; viewing
 * it marks it read server-side, dismissing removes it until a new one is
 * generated (server-authoritative).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { UsageCard } from '../components/UsageCard';
import { FirstWinCard } from '../components/FirstWinCard';
import type { ActivityEvent, ReturnToWorkResponse, WorkspaceContext } from '../lib/types';

const QUICK_ACTIONS = [
  { to: '/chat', label: 'New Chat', hint: 'Chat or brief a coworker' },
  { to: '/ideas', label: 'Ideas', hint: 'Capture and brainstorm' },
  { to: '/terminal', label: 'Open Terminal', hint: 'Local Agent terminal' },
  { to: '/dna', label: 'Load DNA', hint: 'Knowledge base for your project' },
];

function fmtCount(n: number | undefined, singular: string, plural?: string) {
  if (typeof n !== 'number' || n === 0) return null;
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [rtw, setRtw] = useState<ReturnToWorkResponse | null>(null);
  const [ctx, setCtx] = useState<WorkspaceContext | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activityState, setActivityState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expanded, setExpanded] = useState(false);

  const load = () => {
    setState('loading');
    void api<ReturnToWorkResponse>('/api/v1/workspace/return-to-work')
      .then((res) => {
        setRtw(res);
        setState('ready');
      })
      .catch(() => {
        setRtw(null);
        setState('error');
      });
  };

  useEffect(() => {
    load();
    void api<WorkspaceContext>('/api/v1/workspace/context')
      .then(setCtx)
      .catch(() => {
        /* context strip is best-effort */
      });
    void api<{ events: ActivityEvent[] }>('/api/v1/activity?scope=home&limit=8')
      .then((res) => {
        setActivity(res.events ?? []);
        setActivityState('ready');
      })
      .catch(() => {
        setActivity([]);
        setActivityState('error');
      });
  }, []);

  const summary = rtw?.summary ?? null;
  const showCard = state === 'ready' && summary !== null;

  const markRead = () => {
    if (!summary || summary.read) return;
    setRtw((prev) => (prev && prev.summary ? { ...prev, summary: { ...prev.summary, read: true } } : prev));
    void api(`/api/v1/workspace/return-to-work/${summary.id}/read`, { method: 'POST', body: {} }).catch(() => {
      /* read is best-effort */
    });
  };

  const dismiss = () => {
    if (!summary) return;
    setRtw((prev) => (prev ? { ...prev, summary: null } : prev));
    void api(`/api/v1/workspace/return-to-work/${summary.id}/dismiss`, { method: 'POST', body: {} }).catch(() => {
      load();
    });
  };

  const go = (target: string) => {
    void navigate(target);
  };

  return (
    <div className="cc-page">
      <h1>Home</h1>
      <div className="cc-card">
        <h2>Welcome back{user?.displayName ? `, ${user.displayName}` : ''}</h2>
        <p className="cc-hint">
          {user?.entitlementState === 'PRO_VERIFIED'
            ? 'PRO plan active.'
            : user?.entitlementState === 'PRO_PENDING'
              ? 'Payment pending verification — your plan activates once the provider confirms.'
              : 'Free plan — 20 messages/day, 1 project, 2GB storage.'}
        </p>
        {ctx && (
          <div className="cc-continuity-strip" data-testid="continuity-strip">
            <span>{ctx.project?.projectName ?? 'No active project'}</span>
            {ctx.relevantFiles > 0 && <span>· {ctx.relevantFiles} relevant files</span>}
            {ctx.memoryLoaded && <span>· memory loaded ({ctx.memoryCount})</span>}
            {ctx.dnaCount > 0 && <span>· DNA v{ctx.dnaVersion} ({ctx.dnaCount} entries)</span>}
          </div>
        )}
      </div>
      <div className="cc-card">
        <h3>Quick actions</h3>
        <div className="cc-quick">
          {QUICK_ACTIONS.map((q) => (
            <Link key={q.to} className="cc-quick__item" to={q.to}>
              <span>{q.label}</span>
              <span className="cc-quick__hint">{q.hint}</span>
            </Link>
          ))}
        </div>
      </div>
      <FirstWinCard />
      <div className="cc-grid cc-grid-2">
        <div className="cc-card">
          <h3>While you were away</h3>
          {state === 'loading' && <p className="cc-hint">Loading…</p>}
          {state === 'error' && (
            <div className="cc-error-state" style={{ padding: 16 }}>
              <p className="cc-hint">Could not load your summary.</p>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={load}>
                Retry
              </button>
            </div>
          )}
          {state === 'ready' && !showCard && (
            <p className="cc-hint">Nothing new since your last visit.</p>
          )}
          {showCard && summary && (
            <div className="cc-rtw-card" data-testid="rtw-card">
              <p className="cc-hint">
                {summary.absenceStart
                  ? `Since ${new Date(summary.absenceStart).toLocaleString()} — ${new Date(summary.absenceEnd).toLocaleTimeString()}`
                  : 'Your last visit'}
                {summary.aiGenerated ? ' · AI narrative' : ' · deterministic'}{' '}
                {summary.projectScope ? ` · ${summary.projectScope}` : ''}
              </p>
              <div className="cc-rtw-counts">
                {fmtCount(summary.counts.completed, 'task completed', 'tasks completed')}
                {fmtCount(summary.counts.failed, 'task failed', 'tasks failed')}
                {fmtCount(summary.counts.pendingApprovals, 'approval pending', 'approvals pending')}
                {fmtCount(summary.counts.modifiedFiles, 'file modified', 'files modified')}
                {fmtCount(summary.counts.unreadNotifications, 'notification unread', 'notifications unread')}
                {!summary.counts.completed &&
                  !summary.counts.failed &&
                  !summary.counts.pendingApprovals &&
                  !summary.counts.modifiedFiles &&
                  !summary.counts.unreadNotifications && (
                    <span className="cc-hint">No activity — everything quiet.</span>
                  )}
              </div>
              <div className="cc-rtw-actions">
                {summary.recommendedActions.map((a) => (
                  <button key={a.target} className="cc-btn cc-btn--sm" onClick={() => go(a.target)}>
                    {a.label}
                  </button>
                ))}
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => { setExpanded((e) => !e); markRead(); }}>
                  {expanded ? 'Hide summary' : 'View summary'}
                </button>
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={dismiss}>
                  Dismiss
                </button>
              </div>
              {expanded && <p className="cc-rtw-text">{summary.summaryText}</p>}
            </div>
          )}
        </div>
        <div className="cc-card">
          <h3>Usage today</h3>
          <UsageCard />
        </div>
      </div>
      <div className="cc-card">
        <h3>Recent activity</h3>
        {activityState === 'loading' && <p className="cc-hint">Loading…</p>}
        {activityState === 'error' && (
          <div className="cc-error-state" style={{ padding: 16 }}>
            <p className="cc-hint">Could not load activity.</p>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void navigate('/history')}>
              Open history
            </button>
          </div>
        )}
        {activityState === 'ready' && activity.length === 0 && <p className="cc-hint">No recent activity.</p>}
        {activityState === 'ready' && activity.length > 0 && (
          <div data-testid="activity-feed">
            {activity.map((e) => (
              <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
                <span>
                  <span className="cc-pill">{e.source}</span> <span className="cc-pill">{e.action}</span>
                </span>
                <span className="cc-hint">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
            <Link className="cc-hint" to="/history" style={{ display: 'inline-block', marginTop: 6 }}>
              View full history →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}