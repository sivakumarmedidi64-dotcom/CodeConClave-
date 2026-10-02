/**
 * CodeConClave — Trash (Phase 13): one unified view of soft-deleted projects,
 * conversations, memories, DNA, files and ideas with the shared 30-day
 * recovery window. Restore is single or bulk; permanent delete is always
 * confirmed, reports `dependency_conflict` when live references block it,
 * and the expiry sweep removes nothing that still has dependents.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { TrashBulkResult, TrashItem, TrashItemType } from '../lib/types';
import { useToast } from '../components/Toast';

const TABS: Array<{ type: TrashItemType | 'all'; label: string }> = [
  { type: 'all', label: 'All' },
  { type: 'file', label: 'Files' },
  { type: 'project', label: 'Projects' },
  { type: 'conversation', label: 'Conversations' },
  { type: 'memory', label: 'Memory' },
  { type: 'dna', label: 'DNA' },
  { type: 'idea', label: 'Ideas' },
];

export function TrashPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [tab, setTab] = useState<TrashItemType | 'all'>('all');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<{ items: TrashItem[] }>('/api/v1/trash');
      setItems(res.items);
      setState('ready');
    } catch {
      setItems([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => (tab === 'all' ? items : items.filter((i) => i.type === tab)), [items, tab]);

  const restore = async (item: TrashItem) => {
    try {
      await api(`/api/v1/trash/restore/${item.type}/${item.id}`, { method: 'POST', body: {} });
      await load();
      toast('Restored');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'restore failed', 'error');
    }
  };

  const restoreAll = async () => {
    setBusy(true);
    try {
      const res = await api<{ restored: TrashBulkResult[] }>('/api/v1/trash/restore', {
        method: 'POST',
        body: { items: visible.map((i) => ({ type: i.type, id: i.id })) },
      });
      const failed = res.restored.filter((r) => !r.ok);
      if (failed.length > 0) toast(`${failed.length} item(s) could not be restored`, 'error');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'restore failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const purge = async (item: TrashItem) => {
    if (!window.confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/v1/trash/purge/${item.type}/${item.id}`, { method: 'POST', body: {} });
      await load();
      toast('Deleted permanently');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'purge failed', 'error');
    }
  };

  const purgeAll = async () => {
    if (!window.confirm(`Permanently delete ${visible.length} item(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await api<{ purged: TrashBulkResult[] }>('/api/v1/trash/purge', {
        method: 'POST',
        body: { items: visible.map((i) => ({ type: i.type, id: i.id })) },
      });
      const failed = res.purged.filter((r) => !r.ok);
      if (failed.length > 0) toast(`${failed.length} item(s) blocked (still referenced)`, 'error');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'purge failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const purgeExpired = async () => {
    if (!window.confirm('Permanently delete everything past its recovery window?')) return;
    setBusy(true);
    try {
      const res = await api<{ purged: TrashItem[]; skipped: TrashItem[] }>('/api/v1/trash/purge-expired', {
        method: 'POST',
        body: {},
      });
      toast(`${res.purged.length} purged, ${res.skipped.length} skipped`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'purge failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cc-page">
      <h1>Trash</h1>
      <p className="cc-hint">
        Soft-deleted items are recoverable for 30 days, then purged. Permanent deletes are refused while anything still
        references the item.
      </p>
      <div className="cc-toggle">
        {TABS.map((t) => (
          <button key={t.type} className={tab === t.type ? 'on' : ''} onClick={() => setTab(t.type)}>
            {t.label} {t.type !== 'all' ? `(${items.filter((i) => i.type === t.type).length})` : `(${items.length})`}
          </button>
        ))}
      </div>
      {state === 'loading' && <div className="cc-card cc-empty">Loading trash…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load trash.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && (
        <>
          {visible.length === 0 ? (
            <div className="cc-card cc-empty">Trash empty.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={busy} onClick={() => void restoreAll()}>
                  Restore all
                </button>
                <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={busy} onClick={() => void purgeAll()}>
                  Delete all permanently
                </button>
                <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={busy} onClick={() => void purgeExpired()}>
                  Purge expired
                </button>
              </div>
              {visible.map((item) => (
                <div className="cc-card" key={`${item.type}:${item.id}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{item.name}</strong>
                      <span className="cc-pill" style={{ marginLeft: 8 }}>{item.type}</span>
                      {item.projectName && <span className="cc-hint"> · {item.projectName}</span>}
                      {item.teamName && <span className="cc-hint"> · {item.teamName}</span>}
                      <div className="cc-hint">
                        deleted {new Date(item.deletedAt).toLocaleString()} · expires{' '}
                        {new Date(item.expiresAt).toLocaleDateString()}
                        {item.sizeBytes != null ? ` · ${(item.sizeBytes / 1024).toFixed(1)} KB` : ''}
                        {item.deletedBy ? ` · by ${item.deletedBy.slice(0, 8)}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void restore(item)}>
                        Restore
                      </button>
                      <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void purge(item)}>
                        Delete permanently
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}