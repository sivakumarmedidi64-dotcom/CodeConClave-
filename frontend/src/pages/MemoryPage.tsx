/**
 * CodeConClave — Memory: list (type/q filters), create, verify, flag-wrong,
 * source + relationship inspection, merge, soft-delete. Explicit loading /
 * error / empty states.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Memory, MemoryType } from '../lib/types';
import { useToast } from '../components/Toast';
import { MemoryExplorerPanel } from '../components/MemoryExplorerPanel';

const TYPES: MemoryType[] = ['EPISODIC', 'SEMANTIC', 'PROCEDURAL', 'PROJECT', 'TEAM'];

type MemoryTab = 'memories' | 'explorer';

interface MemorySourceRow {
  id?: string;
  sourceLabel: string;
  sourceRef: string | null;
  createdAt?: string;
}

interface MemoryRelationshipRow {
  id?: string;
  sourceMemoryId?: string;
  targetMemoryId: string;
  relation: string;
  weight?: number;
  targetContent?: string;
}

export function MemoryPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<MemoryTab>('memories');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [content, setContent] = useState('');
  const [memType, setMemType] = useState<MemoryType>('EPISODIC');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [open, setOpen] = useState<Record<string, { sources?: MemorySourceRow[]; relationships?: MemoryRelationshipRow[] }>>({});
  const [loadingDetails, setLoadingDetails] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (q.trim()) params.set('q', q.trim());
      const res = await api<{ memories: Memory[] }>(`/api/v1/memory?${params.toString()}`);
      setMemories(res.memories ?? []);
      setState('ready');
    } catch {
      setMemories([]);
      setState('error');
    }
  }, [type, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/v1/memory', {
        method: 'POST',
        body: { type: memType, source: 'USER_STATED', content: content.trim() },
      });
      setContent('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const flag = async (id: string) => {
    try {
      await api(`/api/v1/memory/${id}/flag-wrong`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'flag failed', 'error');
    }
  };

  const verify = async (id: string, verdict: 'VERIFIED' | 'REJECTED') => {
    try {
      await api(`/api/v1/memory/${id}/verify`, { method: 'POST', body: { state: verdict } });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'verify failed', 'error');
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/v1/memory/${id}`, { method: 'DELETE' });
      toast('Moved to Gain Trash');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'delete failed', 'error');
    }
  };

  const toggleDetails = async (id: string) => {
    const isOpen = Boolean(open[id]);
    setOpen((prev) => {
      const next = { ...prev };
      if (isOpen) delete next[id];
      else next[id] = {};
      return next;
    });
    if (!isOpen) {
      setLoadingDetails((prev) => ({ ...prev, [id]: true }));
      try {
        const [sources, relationships] = await Promise.all([
          api<{ sources: MemorySourceRow[] }>(`/api/v1/memory/${id}/sources`),
          api<{ relationships: MemoryRelationshipRow[] }>(`/api/v1/memory/${id}/relationships`),
        ]);
        setOpen((prev) => ({ ...prev, [id]: { sources: sources.sources, relationships: relationships.relationships } }));
      } catch {
        setOpen((prev) => ({ ...prev, [id]: { sources: [], relationships: [] } }));
      } finally {
        setLoadingDetails((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const merge = async () => {
    if (selected.length !== 2) return;
    try {
      const [targetId, intoId] = selected;
      await api('/api/v1/memory/merge', {
        method: 'POST',
        body: { targetId, intoId, note: 'Merged from Memory workspace' },
      });
      toast('Memories merged');
      setSelected([]);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'merge failed', 'error');
    }
  };

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1>Memory</h1>
        <div className="cc-tabs" role="tablist" aria-label="Memory sections">
          {([
            ['memories', 'Memories'],
            ['explorer', 'Explorer'],
          ] as [MemoryTab, string][]).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`cc-tab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'explorer' && (
        <div className="cc-card">
          <MemoryExplorerPanel />
        </div>
      )}

      {tab === 'memories' && (
      <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <select className="cc-select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type filter">
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="cc-input"
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load();
            }}
          />
          <button className="cc-btn cc-btn--ghost" onClick={() => void load()}>
            Search
          </button>
        </div>
      <div className="cc-card">
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="cc-select" style={{ width: 160 }} value={memType} onChange={(e) => setMemType(e.target.value as MemoryType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="cc-input"
            placeholder="What do you want CodeConClave to remember?"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          <button className="cc-btn" disabled={busy || !content.trim()} onClick={() => void create()}>
            Save
          </button>
        </div>
        {selected.length === 2 && (
          <button className="cc-btn cc-btn--ghost cc-btn--sm" style={{ marginTop: 8 }} onClick={() => void merge()}>
            Merge selected (target → into)
          </button>
        )}
      </div>
      {state === 'loading' && <div className="cc-card cc-empty">Loading memories…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load memories.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && memories.length === 0 && <div className="cc-card cc-empty">No memories.</div>}
      {state === 'ready' &&
        memories.map((m) => (
          <div className="cc-card" key={m.id}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="checkbox"
                aria-label={`Select memory for merge: ${m.content.slice(0, 40)}`}
                checked={selected.includes(m.id)}
                onChange={() => toggleSelect(m.id)}
              />
              <span className="cc-pill cc-pill--accent">{m.type}</span>
              <span className="cc-pill">{m.source}</span>
              <span className={`cc-pill--dot ${m.confidence === 'verified' ? 'ok' : m.confidence === 'low' ? 'warn' : ''}`} style={{ display: 'inline-block' }} />
              <span className="cc-hint">{m.confidence}</span>
              {m.flagged && <span className="cc-pill cc-pill--danger">flagged</span>}
              {m.verificationState === 'VERIFIED' && <span className="cc-pill cc-pill--success">verified</span>}
              {m.verificationState === 'REJECTED' && <span className="cc-pill cc-pill--danger">rejected</span>}
            </div>
            <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{m.content}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleDetails(m.id)}>
                {open[m.id] ? 'Hide details' : 'Details'}
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void verify(m.id, 'VERIFIED')}>
                Verify
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void verify(m.id, 'REJECTED')}>
                Reject
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void flag(m.id)}>
                Flag as wrong
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void remove(m.id)}>
                To trash
              </button>
            </div>
            {open[m.id] && (
              <div className="cc-hint" style={{ marginTop: 10 }}>
                {loadingDetails[m.id] && <p>Loading sources &amp; relationships…</p>}
                {!loadingDetails[m.id] && (
                  <>
                    <strong style={{ fontSize: 13 }}>Sources</strong>
                    {open[m.id]!.sources && open[m.id]!.sources!.length === 0 && <p>No sources recorded.</p>}
                    {open[m.id]!.sources?.map((s, i) => (
                      <div key={`${s.sourceLabel}:${i}`} className="cc-mono">
                        {s.sourceLabel}{s.sourceRef ? ` — ${s.sourceRef}` : ''}
                      </div>
                    ))}
                    <strong style={{ fontSize: 13, display: 'block', marginTop: 8 }}>Relationships</strong>
                    {open[m.id]!.relationships && open[m.id]!.relationships!.length === 0 && <p>No relationships.</p>}
                    {open[m.id]!.relationships?.map((r, i) => (
                      <div key={`${r.relation}:${i}`}>
                        {r.relation} → {r.targetContent ?? r.targetMemoryId}
                        {typeof r.weight === 'number' ? ` (weight ${r.weight})` : ''}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </>
      )}
    </div>
  );
}