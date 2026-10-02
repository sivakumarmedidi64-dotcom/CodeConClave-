/**
 * CodeConClave — top bar: hamburger (shell), global search with keyboard
 * navigation, command palette trigger (Cmd/Ctrl+K), context indicator,
 * notifications bell (real unread count), theme toggle, compact profile menu.
 * Notifications panel opens a compact list.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import type { Notification, SearchResult } from '../lib/types';
import { labelFor, showBrowserNotification } from '../lib/browserNotifications';
import { ContextIndicator } from './ContextIndicator';
import { ThemeToggle } from './ThemeToggle';
import { HealthChip } from './HealthChip';
import { ConnectivityIndicator } from './ConnectivityIndicator';
import { Icon } from './Icon';
import { isOnline, enqueueOfflineOp } from '../lib/offline';

const SEARCH_ROUTES: Record<string, string> = {
  file: '/files',
  project: '/projects',
  conversation: '/chat',
  memory: '/memory',
  task: '/work',
  artifact: '/work',
  idea: '/ideas',
};

const NOTIFICATION_ROUTES: Record<string, string> = {
  approval: '/approvals',
  task: '/work',
  digest: '/home',
  project: '/projects',
  memory: '/memory',
  dna: '/dna',
  idea: '/ideas',
  team: '/teams',
  payment: '/settings?tab=billing',
  security: '/settings?tab=security',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [panelState, setPanelState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const pollRef = useRef<number | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'error'>('idle');
  const timerRef = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // ONE notification polling mechanism: a single 30s interval drives both the
  // unread badge (authoritative server count) and the browser-notification
  // dedupe sweep. The first tick only seeds the dedupe set; later ticks surface
  // items the user has not seen yet this session.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const countRes = await api<{ count: number }>('/api/v1/notifications/unread-count');
        if (!cancelled) setUnread(countRes.count);
      } catch {
        /* ignore */
      }
      try {
        const res = await api<{ notifications: Notification[] }>('/api/v1/notifications?limit=20');
        if (cancelled) return;
        const fresh = res.notifications.filter((n) => !n.read && !knownIdsRef.current.has(n.id));
        for (const n of res.notifications) knownIdsRef.current.add(n.id);
        for (const n of fresh) {
          showBrowserNotification(n, () => openNotification(n));
        }
      } catch {
        /* ignore */
      }
    };
    void refresh();
    pollRef.current = window.setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
    // openNotification is stable per component instance (re-created each render but
    // always closes over the same hooks); the effect intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNotification = (n: Notification) => {
    const target = NOTIFICATION_ROUTES[n.resourceType ?? ''] ?? '/home';
    // Preserve query strings (e.g. /settings?tab=security) — the target IS a
    // full location; stripping the search would land on the wrong Settings tab.
    navigate(target);
    void api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
  };

  const dismissNotification = async (id: string) => {
    setItems((prev) => prev.filter((n) => n.id !== id));
    try {
      await api(`/api/v1/notifications/${id}`, { method: 'DELETE' });
    } catch {
      /* item stays gone in the UI; next poll reconciles */
    }
  };

  const openPanel = async () => {
    setOpen((o) => !o);
    if (!open) {
      setPanelState('loading');
      try {
        const res = await api<{ notifications: Notification[] }>('/api/v1/notifications');
        setItems(res.notifications);
        for (const n of res.notifications) knownIdsRef.current.add(n.id);
        setPanelState('ready');
        if (isOnline()) {
          await api('/api/v1/notifications/read', { method: 'POST' });
          setUnread(0);
        } else {
          // Offline: queue the read — it syncs (idempotently) on reconnect.
          enqueueOfflineOp('notifications.markRead', {});
          setUnread(0);
        }
      } catch {
        setPanelState('error');
      }
    }
  };

  const planLabel =
    user?.entitlementState === 'PRO_VERIFIED'
      ? 'PRO'
      : user?.entitlementState === 'PRO_PENDING'
        ? 'PRO · pending'
        : 'FREE';

  const onSearch = (value: string) => {
    setQuery(value);
    setActiveIndex(-1);
    setSearchOpen(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const q = value.trim();
    if (!q) {
      setResults([]);
      setSearchState('idle');
      return;
    }
    setSearchState('searching');
    timerRef.current = window.setTimeout(() => {
      void api<{ results: SearchResult[]; total: number }>(`/api/v1/search?q=${encodeURIComponent(q)}`)
        .then((res) => {
          setResults(res.results);
          setSearchState('idle');
        })
        .catch(() => setSearchState('error'));
    }, 350);
  };

  const openResult = (r: SearchResult) => {
    setQuery('');
    setResults([]);
    setSearchOpen(false);
    navigate(SEARCH_ROUTES[r.entity] ?? '/home');
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && results[activeIndex]) openResult(results[activeIndex]!);
    } else if (e.key === 'Escape') {
      setSearchOpen(false);
      setResults([]);
    }
  };

  const openPalette = () => {
    window.dispatchEvent(new Event('cc:open-palette'));
  };

  /* Escape closes whichever topbar popover is open. Focus stays where it is
     (the toggle buttons remain mounted, so keyboard users are not stranded). */
  useEffect(() => {
    if (!open && !profileOpen && !searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      setProfileOpen(false);
      setSearchOpen(false);
      setResults([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, profileOpen, searchOpen]);

  /* The debounced search timer must not fire after unmount — a late tick
     would setState on an unmounted component and issue a stray request. */
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const initial = (user?.displayName ?? user?.email ?? '?').charAt(0).toUpperCase();

  return (
    <header className="cc-topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {onMenuClick && (
          <button className="cc-hamburger" onClick={onMenuClick} aria-label="Toggle navigation">
            <Icon name="menu" />
          </button>
        )}
        <div className="cc-topbar__title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {user?.displayName ?? 'CodeConClave'}{' '}
          <span
            className={`cc-plan-pill${user?.entitlementState === 'PRO_VERIFIED' ? ' cc-plan-pill--pro' : ''}`}
            data-testid="plan-badge"
          >
            {planLabel}
          </span>
        </div>
      </div>
      <div className="cc-topbar__actions">
        <div style={{ position: 'relative' }}>
          <input
            className="cc-input cc-search-input"
            placeholder="Global search…"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={onSearchKey}
            onFocus={() => setSearchOpen(true)}
            aria-label="Global search"
            aria-expanded={searchOpen && (searchState !== 'idle' || results.length > 0)}
          />
          {(searchOpen || query !== '') && (searchState !== 'idle' || results.length > 0) && (
            <div className="cc-popover cc-popover--scroll" style={{ right: 0, top: 34, width: 340, maxWidth: 'calc(100vw - 32px)' }}>
              {searchState === 'searching' && <div className="cc-empty">Searching…</div>}
              {searchState === 'error' && <div className="cc-empty">Search failed.</div>}
              {searchState === 'idle' && results.length === 0 && <div className="cc-empty">No matches</div>}
              {results.map((r, i) => (
                <button
                  key={`${r.entity}:${r.id}`}
                  className={`cc-popover__item${i === activeIndex ? ' highlight' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => openResult(r)}
                >
                  <strong>{r.label}</strong>
                  <div className="cc-popover__hint">
                    {r.entity} · {r.summary ?? r.createdAt ?? ''}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={openPalette} aria-label="Command palette (Ctrl+K)" title="Command palette (Ctrl+K)">
          ⌘K
        </button>
        <ContextIndicator />
        <HealthChip />
        <ConnectivityIndicator />
        <div style={{ position: 'relative' }}>
          <button className="cc-bell" onClick={() => void openPanel()} aria-label="Notifications" aria-expanded={open}>
            <Icon name="bell" size={18} />
            {unread > 0 && <span className="cc-bell__badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
          {open && (
            <div className="cc-popover cc-popover--scroll" role="dialog" aria-label="Notifications" style={{ right: 0, top: 34, width: 340, maxWidth: 'calc(100vw - 32px)' }}>
              {panelState === 'loading' && <div className="cc-empty">Loading…</div>}
              {panelState === 'error' && <div className="cc-empty">Could not load notifications.</div>}
              {panelState === 'ready' && items.length === 0 && <div className="cc-empty">No notifications</div>}
              {items.slice(0, 20).map((n) => (
                <div key={n.id} className="cc-popover__item" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <button
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
                    onClick={() => void openNotification(n)}
                    title={`Open ${labelFor(n.type)}`}
                  >
                    <span className="cc-badge">{labelFor(n.type)}</span>{' '}
                    <strong>{n.title}</strong>
                    {n.body && <div className="cc-popover__hint">{n.body}</div>}
                    <div className="cc-popover__hint">{timeAgo(n.createdAt)}</div>
                  </button>
                  <button
                    className="cc-btn cc-btn--ghost cc-btn--sm"
                    style={{ flex: 'none' }}
                    onClick={() => void dismissNotification(n.id)}
                    aria-label={`Dismiss ${n.title}`}
                    title="Dismiss"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <ThemeToggle />
        <div className="cc-menu">
          <button className="cc-menu__btn" onClick={() => setProfileOpen((o) => !o)} aria-label="Account menu" aria-expanded={profileOpen}>
            <span aria-hidden="true">{initial}</span>
          </button>
          {profileOpen && (
            <div className="cc-popover cc-menu__panel">
              <div className="cc-popover__title">{user?.email ?? ''}</div>
              <button
                className="cc-menu__item"
                onClick={() => {
                  setProfileOpen(false);
                  navigate('/settings');
                }}
              >
                <Icon name="settings" size={16} /> Settings
              </button>
              <button className="cc-menu__item" onClick={() => void logout()}>
                <Icon name="logout" size={16} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}