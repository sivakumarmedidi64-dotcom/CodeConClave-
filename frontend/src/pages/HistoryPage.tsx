/**
 * CodeConClave — History (Phase 13): read-only union of the four authorized
 * event sources (audit, project/file/team activity) with keyword/source/
 * action/actor/date filters, starred pins, and a detail view. Every row is
 * sourced from persisted events — nothing is generated on the fly.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { HistoryEvent, HistorySource } from '../lib/types';
import { useToast } from '../components/Toast';

const SOURCES: Array<{ value: '' | HistorySource; label: string }> = [
  { value: '', label: 'All sources' },
  { value: 'audit', label: 'Audit' },
  { value: 'project_activity', label: 'Projects' },
  { value: 'file_activity', label: 'Files' },
  { value: 'team_activity', label: 'Teams' },
];

export function HistoryPage() {
  const { toast } = useToast();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filters, setFilters] = useState({
    q: '',
    source: '' as '' | HistorySource,
    action: '',
    actorId: '',
    projectId: '',
    teamId: '',
    dateFrom: '',
    dateTo: '',
    starred: false,
    sort: 'desc' as 'asc' | 'desc',
  });
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<HistoryEvent | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: filters.sort });
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.source) params.set('source', filters.source);
      if (filters.action.trim()) params.set('action', filters.action.trim());
      if (filters.actorId.trim()) params.set('actorId', filters.actorId.trim());
      if (filters.projectId.trim()) params.set('projectId', filters.projectId.trim());
      if (filters.teamId.trim()) params.set('teamId', filters.teamId.trim());
      if (filters.dateFrom) params.set('dateFrom', new Date(filters.dateFrom).toISOString());
      if (filters.dateTo) params.set('dateTo', new Date(filters.dateTo).toISOString());
      if (filters.starred) params.set('starred', 'true');
      const res = await api<{ events: HistoryEvent[]; total: number }>(`/api/v1/history?${params.toString()}`);
      setEvents(res.events);
      setTotal(res.total);
      setState('ready');
    } catch {
      setEvents([]);
      setTotal(0);
      setState('error');
    }
  }, [filters, limit, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStar = async (e: HistoryEvent) => {
    try {
      if (e.starred) {
        await api(`/api/v1/history/${e.source}/${e.eventId}/star`, { method: 'DELETE' });
      } else {
        await api(`/api/v1/history/${e.source}/${e.eventId}/star`, { method: 'POST', body: {} });
      }
      setEvents((prev) => prev.map((x) => (x.id === e.id ? { ...x, starred: !e.starred } : x)));
      if (detail?.id === e.id) setDetail({ ...detail, starred: !e.starred });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'star failed', 'error');
    }
  };

  const openDetail = async (e: HistoryEvent) => {
    try {
      const res = await api<{ event: HistoryEvent }>(`/api/v1/history/${e.source}/${e.eventId}`);
      setDetail(res.event);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  };

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h1>History</h1>
        <span className="cc-hint">{total} event(s)</span>
      </div>

      <div className="cc-card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="cc-input"
            style={{ width: 200 }}
            placeholder="Search…"
            value={filters.q}
            onChange={(e) => {
              setFilters((f) => ({ ...f, q: e.target.value }));
              setOffset(0);
            }}
          />
          <select
            className="cc-input"
            style={{ width: 140 }}
            value={filters.source}
            onChange={(e) => {
              setFilters((f) => ({ ...f, source: e.target.value as '' | HistorySource }));
              setOffset(0);
            }}
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <input
            className="cc-input"
            style={{ width: 150 }}
            placeholder="action"
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
          />
          <input
            className="cc-input"
            style={{ width: 150 }}
            placeholder="actor user id"
            value={filters.actorId}
            onChange={(e) => setFilters((f) => ({ ...f, actorId: e.target.value }))}
          />
          <input
            className="cc-input"
            style={{ width: 150 }}
            placeholder="project id"
            value={filters.projectId}
            onChange={(e) => setFilters((f) => ({ ...f, projectId: e.target.value }))}
          />
          <input
            className="cc-input"
            style={{ width: 150 }}
            placeholder="team id"
            value={filters.teamId}
            onChange={(e) => setFilters((f) => ({ ...f, teamId: e.target.value }))}
          />
          <label className="cc-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            from
            <input type="date" value={filters.dateFrom} onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} />
          </label>
          <label className="cc-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            to
            <input type="date" value={filters.dateTo} onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} />
          </label>
          <label className="cc-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={filters.starred} onChange={(e) => setFilters((f) => ({ ...f, starred: e.target.checked }))} />
            starred
          </label>
          <select className="cc-input" style={{ width: 110 }} value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as 'asc' | 'desc' }))}>
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading history…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load history.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && events.length === 0 && <div className="cc-card cc-empty">No events match your filters.</div>}
      {state === 'ready' && events.length > 0 && (
        <table className="cc-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Target</th>
              <th>Details</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="cc-mono">{new Date(e.createdAt).toLocaleString()}</td>
                <td><span className="cc-pill">{e.source}</span></td>
                <td><span className="cc-pill">{e.action}</span></td>
                <td className="cc-hint cc-mono">{e.actorUserId ? e.actorUserId.slice(0, 8) : '—'}</td>
                <td className="cc-hint">
                  {e.resourceType ?? '—'}
                  {e.resourceId ? <span className="cc-mono"> {e.resourceId.slice(0, 8)}</span> : ''}
                </td>
                <td className="cc-mono">
                  {e.detail ? JSON.stringify(e.detail).slice(0, 100) : <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void openDetail(e)}>View</button>}
                </td>
                <td>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleStar(e)} title={e.starred ? 'Unstar' : 'Star'}>
                    {e.starred ? '★' : '☆'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="cc-btn cc-btn--ghost cc-btn--sm"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - limit))}
        >
          ‹ Newer
        </button>
        <button
          className="cc-btn cc-btn--ghost cc-btn--sm"
          disabled={events.length < limit}
          onClick={() => setOffset((o) => o + limit)}
        >
          Older ›
        </button>
      </div>

      {detail && (
        <div className="cc-card" data-testid="history-detail">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h3>Event detail</h3>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 4 }}>
            <dt className="cc-hint">Time</dt>
            <dd className="cc-mono">{new Date(detail.createdAt).toLocaleString()}</dd>
            <dt className="cc-hint">Source</dt>
            <dd><span className="cc-pill">{detail.source}</span></dd>
            <dt className="cc-hint">Action</dt>
            <dd><span className="cc-pill">{detail.action}</span></dd>
            <dt className="cc-hint">Actor</dt>
            <dd className="cc-mono">{detail.actorUserId ?? '—'}</dd>
            <dt className="cc-hint">Resource</dt>
            <dd className="cc-mono">{detail.resourceType ?? '—'} {detail.resourceId ?? ''}</dd>
            <dt className="cc-hint">Project</dt>
            <dd className="cc-mono">{detail.projectId ?? '—'}</dd>
            <dt className="cc-hint">Team</dt>
            <dd className="cc-mono">{detail.teamId ?? '—'}</dd>
            <dt className="cc-hint">Details</dt>
            <dd className="cc-mono" style={{ whiteSpace: 'pre-wrap' }}>{detail.detail ? JSON.stringify(detail.detail, null, 2) : '—'}</dd>
          </dl>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleStar(detail)}>
            {detail.starred ? '★ Unstar' : '☆ Star'}
          </button>
        </div>
      )}
    </div>
  );
}