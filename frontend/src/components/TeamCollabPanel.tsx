/**
 * CodeConClave — PKG-11 Team Collaboration panel.
 * Read-only rendering of canonical, server-confirmed team collaboration state:
 * presence (honest states from heartbeat timestamps), collaboration queue,
 * shared context (SHARED scope only — private memory is never surfaced here),
 * visible team skills, and code ownership. No fabricated realtime: the panel
 * reflects exactly what `/api/v1/teamcollab/*` returns and refreshes on demand.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface PresenceItem {
  userId: string;
  state: 'ONLINE' | 'IDLE' | 'BUSY' | 'OFFLINE';
  at: number;
}

interface QueueItem {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ContextEntry {
  id: string;
  title: string;
  body: string;
  authorUserId: string;
  createdAt: number;
  scope: 'SHARED' | 'PRIVATE';
}

interface SkillItem {
  id: string;
  name: string;
  visible: boolean;
}

const PRESENCE_LABEL: Record<string, string> = {
  ONLINE: 'online',
  BUSY: 'busy',
  IDLE: 'idle',
  OFFLINE: 'offline',
};

export function TeamCollabPanel({ teamId }: { teamId: string }) {
  const [presence, setPresence] = useState<PresenceItem[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [context, setContext] = useState<ContextEntry[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [p, q, c, s] = await Promise.all([
        api<{ presence: PresenceItem[]; onlineCount: number }>(`/api/v1/teamcollab/${teamId}/presence`),
        api<{ items: QueueItem[] }>(`/api/v1/teamcollab/${teamId}/queue`),
        api<{ entries: ContextEntry[] }>(`/api/v1/teamcollab/${teamId}/context`),
        api<{ skills: SkillItem[] }>(`/api/v1/teamcollab/${teamId}/skills`),
      ]);
      setPresence(p.presence);
      setOnlineCount(p.onlineCount);
      setQueue(q.items);
      setContext(c.entries);
      setSkills(s.skills);
      setState('ready');
    } catch {
      setPresence([]);
      setQueue([]);
      setContext([]);
      setSkills([]);
      setState('error');
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="cc-card" data-testid="team-collab-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Team collaboration</h3>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {state === 'loading' && <div className="cc-empty">Loading…</div>}
      {state === 'error' && <div className="cc-empty">Could not load collaboration state.</div>}
      {state === 'ready' && (
        <>
          <h4>Presence</h4>
          {presence.length === 0 ? (
            <div className="cc-empty">No members online.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {presence.map((m) => (
                <li key={m.userId} style={{ marginBottom: 4 }}>
                  {m.userId} — <span style={{ color: m.state === 'ONLINE' || m.state === 'BUSY' ? '#1e7d46' : '#888' }}>{PRESENCE_LABEL[m.state] ?? m.state}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="cc-hint">Online: {onlineCount}</div>

          <h4>Collaboration queue</h4>
          {queue.length === 0 ? (
            <div className="cc-empty">No queued work.</div>
          ) : (
            <table className="cc-table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Assignee</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.id}>
                    <td>{q.title}</td>
                    <td>{q.status}</td>
                    <td>{q.assigneeId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>Shared context</h4>
          {context.length === 0 ? (
            <div className="cc-empty">No shared context.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {context.map((e) => (
                <li key={e.id} style={{ marginBottom: 6 }}>
                  <strong>{e.title}</strong>
                  <div style={{ color: '#666' }}>{e.body}</div>
                </li>
              ))}
            </ul>
          )}

          <h4>Visible team skills</h4>
          {skills.length === 0 ? (
            <div className="cc-empty">No visible skills.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {skills.map((s) => (
                <li key={s.id}>{s.name}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
