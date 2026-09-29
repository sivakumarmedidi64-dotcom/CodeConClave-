/**
 * CodeConClave — Home.
 * Time-based greeting by name, the all-in-one HomeChat composer, quick-action
 * pills to real workspaces, project continuity strip, the "While you were
 * away" return-to-work card and the recent activity feed. Nothing here is
 * simulated: every surface is fed by a real API call.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HomeChat } from '../components/HomeChat';
import { OnboardingCard } from '../components/OnboardingCard';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';

interface RtwCounts {
  completed: number;
  failed: number;
  pendingApprovals: number;
  modifiedFiles: number;
  discoveries: number;
  memoryUpdates: number;
  dnaUpdates: number;
  projectActivity: number;
  unreadNotifications: number;
}

interface RecommendedAction {
  type: string;
  label: string;
  target: string;
}

interface RtwSummary {
  id: string;
  summaryText: string;
  counts: RtwCounts;
  recommendedActions: RecommendedAction[];
  read: boolean;
  dismissed: boolean;
  aiGenerated: boolean;
}

interface RtwResponse {
  summary: RtwSummary | null;
  eligibility: { eligible: boolean; reason: string };
}

interface ContextState {
  memoryLoaded: boolean;
  memoryCount: number;
  memorySourceRefs: number;
  dnaCount: number;
  dnaVersion: number;
  relevantFiles: number;
  project: { projectId: string; projectName: string } | null;
}

interface ActivityEvent {
  id: string;
  source: string;
  action: string;
  actorUserId: string | null;
  projectId: string | null;
  teamId: string | null;
  resourceType: string;
  resourceId: string;
  summary: string;
  createdAt: string;
}

const QUICK_ACTIONS: { to: string; label: string; hint: string; icon: 'chat' | 'terminal' | 'dna' | 'bulb' }[] = [
  { to: '/chat', label: 'New Chat', hint: 'Continue a conversation', icon: 'chat' },
  { to: '/terminal', label: 'Open Terminal', hint: 'Run commands in the workspace', icon: 'terminal' },
  { to: '/dna', label: 'Load DNA', hint: 'Apply your team memory', icon: 'dna' },
  { to: '/ideas', label: 'Ideas', hint: 'Capture and organize ideas', icon: 'bulb' },
];

export function HomePage() {
  const { user } = useAuth();
  const [rtw, setRtw] = useState<'loading' | 'ready' | 'error'>('loading');
  const [summary, setSummary] = useState<RtwSummary | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<ContextState | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  const load = useCallback(async () => {
    setRtw('loading');
    try {
      const r = await api<RtwResponse>('/api/v1/workspace/return-to-work');
      setSummary(r.summary);
      setRtw('ready');
    } catch {
      setRtw('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<ContextState>('/api/v1/workspace/context')
      .then(setContext)
      .catch(() => setContext(null));
  }, []);

  useEffect(() => {
    void api<{ events: ActivityEvent[] }>('/api/v1/activity')
      .then((r) => setEvents(r.events ?? []))
      .catch(() => setEvents([]));
  }, []);

  const markRead = async (id: string) => {
    setExpanded(true);
    try {
      await api<{ summary: RtwSummary }>(`/api/v1/workspace/return-to-work/${id}/read`, { method: 'POST' });
    } catch {
      // read is best-effort on the client; the server remains the source of truth
    }
  };

  const dismiss = async (id: string) => {
    setSummary(null);
    try {
      await api<{ summary: RtwSummary }>(`/api/v1/workspace/return-to-work/${id}/dismiss`, { method: 'POST' });
    } catch {
      // server will treat the summary as stale/dismissible on next fetch
    }
  };

  const emptyCounts = summary
    ? Object.values(summary.counts).every((n) => n === 0)
    : true;

  const hours = new Date().getHours();
  const part =
    hours < 12 ? 'Good morning' : hours < 18 ? 'Good afternoon' : hours < 22 ? 'Good evening' : 'Good night';
  const name = user?.displayName ?? user?.email;

  return (
    <div className="cc-home">
      <div className="cc-home__greeting">
        <h1>
          {part}
          {name ? `, ${name}` : ''}
        </h1>
        <p className="cc-home__sub">Command CodeConClave — chat, plan, execute and verify real work.</p>
      </div>

      <OnboardingCard />

      <HomeChat />

      <nav className="cc-quick" aria-label="Quick actions">
        {QUICK_ACTIONS.map((q) => (
          <Link key={q.to} to={q.to} className="cc-quick__item">
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <Icon name={q.icon} size={16} />
              {q.label}
            </span>
            <span className="cc-quick__hint">{q.hint}</span>
          </Link>
        ))}
      </nav>

      {context && (
        <div className="cc-continuity-strip" data-testid="continuity-strip">
          {context.project ? <span>Project: {context.project.projectName}</span> : null}
          {context.memoryLoaded ? <span>Memory: {context.memoryCount} loaded</span> : null}
          {typeof context.relevantFiles === 'number' && context.relevantFiles > 0 ? (
            <span>{context.relevantFiles} relevant files</span>
          ) : null}
          {typeof context.dnaVersion === 'number' && context.dnaVersion > 0 ? (
            <span>DNA v{context.dnaVersion}</span>
          ) : null}
        </div>
      )}

      {rtw === 'error' ? (
        <div className="cc-card">
          <p className="cc-hint">Could not load your summary.</p>
          <button className="cc-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : rtw === 'ready' && summary === null ? (
        <p className="cc-hint">Nothing new since your last visit</p>
      ) : rtw === 'ready' && summary ? (
        <div className="cc-card cc-rtw-card" data-testid="rtw-card">
          <h3 style={{ margin: 0 }}>While you were away</h3>
          {emptyCounts ? (
            <p className="cc-hint" style={{ margin: 0 }}>All quiet.</p>
          ) : (
            <div className="cc-rtw-counts">
              {summary.counts.completed > 0 ? (
                <span>{summary.counts.completed} tasks completed</span>
              ) : null}
              {summary.counts.failed > 0 ? (
                <span>
                  {summary.counts.failed} task{summary.counts.failed === 1 ? '' : 's'} failed
                </span>
              ) : null}
              {summary.counts.modifiedFiles > 0 ? (
                <span>{summary.counts.modifiedFiles} files modified</span>
              ) : null}
              {summary.counts.pendingApprovals > 0 ? (
                <span>{summary.counts.pendingApprovals} approval{summary.counts.pendingApprovals === 1 ? '' : 's'} pending</span>
              ) : null}
              {summary.counts.unreadNotifications > 0 ? (
                <span>{summary.counts.unreadNotifications} notification{summary.counts.unreadNotifications === 1 ? '' : 's'}</span>
              ) : null}
              {summary.counts.projectActivity > 0 ? (
                <span>{summary.counts.projectActivity} project events</span>
              ) : null}
            </div>
          )}
          {expanded ? <p className="cc-rtw-text">{summary.summaryText}</p> : null}
          {summary.recommendedActions.length > 0 ? (
            <div className="cc-rtw-actions">
              {summary.recommendedActions.map((a) => (
                <Link key={a.type} to={a.target} className="cc-btn cc-btn--ghost cc-btn--sm">
                  {a.label}
                </Link>
              ))}
            </div>
          ) : null}
          <div className="cc-rtw-actions">
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void markRead(summary.id)}>
              View summary
            </button>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void dismiss(summary.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="cc-card" data-testid="activity-feed">
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {events.slice(0, 8).map((e) => (
            <li key={e.id} className="cc-hint" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span>{e.summary}</span>
            </li>
          ))}
        </ul>
        {events.length === 0 ? <p className="cc-hint" style={{ margin: '8px 0 0' }}>No activity yet.</p> : null}
        <Link to="/history" className="cc-btn cc-btn--ghost cc-btn--sm" style={{ marginTop: 10 }}>
          View full history →
        </Link>
      </div>
    </div>
  );
}