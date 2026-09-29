/**
 * CodeConClave — chat sidebar (conversation rail).
 * Presentational + server-search list over the CANONICAL conversations API.
 * - pinned (favorite) section, then the rest (most-recently updated first)
 * - unread dot: "updated since I last opened it" (client last-seen map is
 *   persisted through the existing /workspace/state rail, never invented)
 * - inline rename, pin, archive/unarchive, delete (soft → Trash, 30-day)
 * - server chat search (title + indexes) with a clear button
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';

export interface ChatSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  lastSeen: Record<string, number>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onTogglePin: (c: Conversation) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
}

export function ChatSidebar({
  conversations,
  activeId,
  lastSeen,
  onSelect,
  onNew,
  onTogglePin,
  onArchive,
  onUnarchive,
  onDelete,
  onRename,
}: ChatSidebarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Conversation[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    };
  }, []);

  const runSearch = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setQuery('');
      setResults(null);
      return;
    }
    setQuery(q);
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api<{ conversations: Conversation[] }>(
          `/api/v1/conversations/search?q=${encodeURIComponent(trimmed)}`,
        );
        setResults(res.conversations ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  };

  const showResults = results !== null;
  const pinned = conversations.filter((c) => c.favorite && !c.archived);
  const recent = conversations
    .filter((c) => !c.favorite && !c.archived)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const archived = conversations.filter((c) => c.archived);

  const commitRename = async () => {
    const id = editingId;
    const title = draft.trim();
    setEditingId(null);
    if (id && title) await onRename(id, title);
  };

  const unread = (c: Conversation): boolean => {
    if (c.id === activeId) return false;
    const seen = lastSeen[c.id];
    return !seen || new Date(c.updatedAt).getTime() > seen;
  };

  const rows = (list: Conversation[]) =>
    list.map((c) => (
      <div
        key={c.id}
        className={`cc-sidebar__item ${c.id === activeId ? 'cc-sidebar__item--active' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`Conversation ${c.title}`}
        onClick={() => onSelect(c.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect(c.id);
        }}
      >
        {editingId === c.id ? (
          <input
            className="cc-input"
            style={{ width: '100%' }}
            autoFocus
            value={draft}
            aria-label="Rename conversation"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') setEditingId(null);
            }}
            onBlur={() => void commitRename()}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title}
            </span>
            <span className="cc-pill" style={{ fontSize: 10 }}>{c.mode}</span>
            {unread(c) && <span className="cc-unread-dot" aria-label="Unread" title="Unread" />}
            <span className="cc-msg-actions" style={{ marginLeft: 4 }}>
              <button
                className="cc-btn cc-btn--ghost cc-btn--sm"
                title={c.favorite ? 'Unpin' : 'Pin'}
                aria-label={c.favorite ? 'Unpin conversation' : 'Pin conversation'}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(c);
                }}
              >
                {c.favorite ? 'Unpin' : 'Pin'}
              </button>
              <button
                className="cc-btn cc-btn--ghost cc-btn--sm"
                title="Rename"
                aria-label="Rename conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft(c.title);
                  setEditingId(c.id);
                }}
              >
                Rename
              </button>
              {c.archived ? (
                <button
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  title="Unarchive"
                  aria-label="Unarchive conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnarchive(c.id);
                  }}
                >
                  Unarchive
                </button>
              ) : (
                <button
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  title="Archive"
                  aria-label="Archive conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive(c.id);
                  }}
                >
                  Archive
                </button>
              )}
              <button
                className="cc-btn cc-btn--ghost cc-btn--sm"
                title="Delete (moves to Trash)"
                aria-label="Delete conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
              >
                Delete
              </button>
            </span>
          </>
        )}
      </div>
    ));

  return (
    <div className="cc-chat-sidebar">
      <button className="cc-btn cc-btn--sm" onClick={() => void onNew()}>
        + New conversation
      </button>
      <input
        className="cc-input"
        style={{ marginTop: 8, width: '100%' }}
        placeholder="Search all chats…"
        aria-label="Search chats"
        value={query}
        onChange={(e) => runSearch(e.target.value)}
      />
      {searching && <div className="cc-hint" style={{ marginTop: 4 }}>Searching…</div>}
      {showResults && query.trim() && (
        <div className="cc-hint" style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>{results?.length ?? 0} result(s)</span>
          <button
            className="cc-btn cc-btn--ghost cc-btn--sm"
            onClick={() => {
              setQuery('');
              setResults(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
      <div style={{ marginTop: 8, overflow: 'auto', flex: 1, minHeight: 0 }}>
        {!searching && !showResults && conversations.length === 0 && (
          <div className="cc-empty" style={{ padding: 12 }}>
            No conversations yet.
          </div>
        )}
        {showResults
          ? results && results.length === 0
            ? <div className="cc-empty">No chats match.</div>
            : rows(results ?? [])
          : (
              <>
                {pinned.length > 0 && (
                  <>
                    <div className="cc-sidebar__group">Pinned</div>
                    {rows(pinned)}
                  </>
                )}
                {recent.length > 0 && (
                  <>
                    <div className="cc-sidebar__group">Recent</div>
                    {rows(recent)}
                  </>
                )}
                {archived.length > 0 && (
                  <>
                    <div className="cc-sidebar__group">Archived</div>
                    {rows(archived)}
                  </>
                )}
              </>
            )}
      </div>
    </div>
  );
}