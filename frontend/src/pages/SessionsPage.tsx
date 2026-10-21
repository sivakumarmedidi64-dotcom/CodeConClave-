/**
 * All chats — every conversation in one place, newest first, grouped by
 * day, with server-side search (titles and content via
 * /api/v1/conversations/search). Opens straight into the chat page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import type { Conversation } from '../lib/types';

function bucket(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86_400_000) return 'Yesterday';
  if (t >= startOfToday - 6 * 86_400_000) return 'This week';
  if (t >= startOfToday - 29 * 86_400_000) return 'This month';
  return 'Older';
}

const ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

export function SessionsPage() {
  const [all, setAll] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Conversation[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api<{ conversations: Conversation[] }>('/api/v1/conversations')
      .then((res) => setAll((res.conversations ?? []).filter((c) => !c.deletedAt)))
      .catch(() => setError(true));
  }, []);

  // Debounced server search; the empty query shows everything.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const id = window.setTimeout(() => {
      api<{ conversations: Conversation[] }>(`/api/v1/conversations/search?q=${encodeURIComponent(q)}`)
        .then((res) => setResults(res.conversations ?? []))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const list = results ?? all ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      const k = bucket(c.updatedAt);
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    return ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const);
  }, [list]);

  return (
    <div className="cc-page ss-page">
      <header className="sp-header">
        <h2 className="sp-title">
          <Icon name="chat" size={22} className="sp-title-icon" /> All chats
        </h2>
        <Link to="/chat?new=1" className="cc-btn cc-btn--primary">
          <Icon name="plus" size={15} className="sp-btn-icon" /> New chat
        </Link>
      </header>
      <label className="sp-search">
        <Icon name="search" size={16} className="sp-search-icon" />
        <input className="cc-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your chats" aria-label="Search your chats" />
      </label>
      {error && <div className="cc-card cc-error-state">Could not load your chats.</div>}
      {!error && all === null && <div className="cc-card cc-empty">Loading chats…</div>}
      {!error && all !== null && list.length === 0 && (
        <div className="cc-card cc-empty">{query.trim() ? 'No chats match.' : 'No chats yet — start one from Home.'}</div>
      )}
      {groups.map(([label, items]) => (
        <section key={label} className="ss-group" aria-label={label}>
          <h3 className="ss-group__title">{label}</h3>
          {items.map((c) => (
            <Link key={c.id} to={`/chat?c=${encodeURIComponent(c.id)}`} className="ss-row">
              <span className="ss-row__title">{c.title || 'Untitled conversation'}</span>
              <span className="ss-row__meta">
                {c.mode !== 'CHAT' && <span className="cc-pill">{c.mode.toLowerCase()}</span>}
                {new Date(c.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </Link>
          ))}
        </section>
      ))}
    </div>
  );
}
