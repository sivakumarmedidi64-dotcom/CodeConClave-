/**
 * CodeConClave — Local Terminal workspace (PHASE 4B).
 * Real wiring over /api/v1/terminal + /api/v1/remote. Terminal status and
 * history are whatever the paired agent really reported (RUNNING only with a
 * real pid); the page polls the persisted session while one is active (the
 * authenticated /agent-browser push stream is wired server-side). Interactive
 * input is limited to low-risk commands — approval-requiring input is refused
 * by the backend and surfaced here, never bypassed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBlob } from '../lib/api';
import type {
  DeviceInfo,
  RemoteSessionInfo,
  TerminalHistoryLine,
  TerminalSessionInfo,
  WorkspaceStateEntry,
} from '../lib/types';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth/AuthProvider';

const SHELLS = ['bash', 'powershell', 'node', 'python'] as const;
const POLL_MS = 2500;

export function TerminalPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [remote, setRemote] = useState<Record<string, RemoteSessionInfo>>({});
  const [deviceId, setDeviceId] = useState('');
  const [shell, setShell] = useState<string>(SHELLS[0]);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<{ session: TerminalSessionInfo; history: TerminalHistoryLine[] } | null>(null);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TerminalHistoryLine[] | null>(null);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api<{ devices: DeviceInfo[] }>('/api/v1/agent/status');
      setDevices(res.devices);
      setDeviceId((prev) => prev || res.devices[0]?.id || '');
    } catch {
      /* agent status unavailable */
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await api<{ sessions: TerminalSessionInfo[] }>('/api/v1/terminal/sessions');
      setSessions(res.sessions);
    } catch {
      /* ignore */
    }
  }, []);

  const loadRemote = useCallback(async () => {
    try {
      const res = await api<{ sessions: RemoteSessionInfo[] }>('/api/v1/remote/sessions');
      const byDevice: Record<string, RemoteSessionInfo> = {};
      for (const s of res.sessions) byDevice[s.deviceId] = s;
      setRemote(byDevice);
    } catch {
      /* ignore */
    }
  }, []);

  const loadActive = useCallback(async (id: string | null) => {
    if (!id) return;
    try {
      const res = await api<{ session: TerminalSessionInfo; history: TerminalHistoryLine[] }>(
        `/api/v1/terminal/sessions/${id}`,
      );
      setView(res);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void loadSessions();
    void loadRemote();
  }, [loadDevices, loadSessions, loadRemote]);

  /* Continuity: restore the last active session across reloads/devices. */
  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ state: WorkspaceStateEntry[] }>('/api/v1/workspace/state');
        const entry = res.state.find((e) => e.key === 'terminal_tabs');
        const activeId = typeof entry?.value?.activeId === 'string' ? entry.value.activeId : null;
        if (activeId) setActiveId(activeId);
      } catch {
        /* restore is best-effort */
      }
    })();
  }, []);

  useEffect(() => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = activeId
      ? window.setInterval(() => void loadActive(activeId), POLL_MS)
      : null;
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [activeId, loadActive]);

  const refreshAll = async () => {
    await Promise.all([loadDevices(), loadSessions(), loadRemote()]);
  };

  const startRemoteSession = async (deviceIdToStart: string) => {
    setBusy(true);
    try {
      const res = await api<{ session: RemoteSessionInfo }>('/api/v1/remote/sessions', {
        method: 'POST',
        body: { deviceId: deviceIdToStart },
      });
      setRemote((prev) => ({ ...prev, [res.session.deviceId]: res.session }));
      toast('Remote session started (8h)', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'remote session failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const selectSession = async (id: string) => {
    setActiveId(id);
    await api('/api/v1/workspace/state/terminal_tabs', { method: 'PUT', body: { value: { activeId: id } } }).catch(
      () => {
        /* continuity is best-effort */
      },
    );
  };

  const createSession = async () => {
    if (!deviceId) return;
    setBusy(true);
    try {
      const res = await api<{ session: TerminalSessionInfo }>('/api/v1/terminal/sessions', {
        method: 'POST',
        body: { deviceId, shell },
      });
      await selectSession(res.session.id);
      setView({ session: res.session, history: [] });
      await refreshAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'terminal start failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!activeId || !input.trim()) return;
    try {
      await api(`/api/v1/terminal/sessions/${activeId}/input`, { method: 'POST', body: { input } });
      setInput('');
      await loadActive(activeId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'input refused', 'error');
    }
  };

  const act = async (path: string, doneMessage: string) => {
    if (!activeId) return;
    try {
      await api(path, { method: 'POST', body: {} });
      toast(doneMessage, 'info');
      await loadActive(activeId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'action failed', 'error');
    }
  };

  const search = async () => {
    if (!q.trim()) return;
    try {
      const res = await api<{ lines: TerminalHistoryLine[] }>(
        `/api/v1/terminal/search?q=${encodeURIComponent(q.trim())}`,
      );
      setResults(res.lines);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'search failed', 'error');
    }
  };

  const downloadLogs = async () => {
    if (!activeId) return;
    try {
      const blob = await apiBlob(`/api/v1/terminal/sessions/${activeId}/logs`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terminal-${activeId}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'download failed', 'error');
    }
  };

  const requestScreenshot = async () => {
    const session = remote[deviceId];
    if (!session || !activeId) return;
    setScreenshotBusy(true);
    try {
      if (!session.screenshotAuthorized) {
        await api(`/api/v1/remote/sessions/${session.id}/screenshot-auth`, { method: 'POST', body: {} });
      }
      const res = await fetch(`/api/v1/remote/sessions/${session.id}/screenshot`, {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `screenshot-${session.id}.png`;
        a.click();
        URL.revokeObjectURL(url);
        toast('Screenshot saved', 'info');
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
        toast(body?.error?.message ?? 'screenshot unavailable', 'error');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'screenshot failed', 'error');
    } finally {
      setScreenshotBusy(false);
    }
  };

  const activeRemote = remote[deviceId];

  return (
    <div className="cc-page">
      <h1>Local Terminal</h1>
      <div className="cc-card">
        <h2>Session</h2>
        <p className="cc-hint">
          Signed in as <strong>{user?.email}</strong>. Local execution never happens in the cloud:
          the paired agent must be <strong>{activeRemote ? 'under remote session' : 'online with an active remote session (8h)'}</strong>{' '}
          before terminal commands can be dispatched.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="cc-hint">Device</label>
          <select className="cc-input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.presence}
              </option>
            ))}
          </select>
          <label className="cc-hint">Shell</label>
          <select className="cc-input" value={shell} onChange={(e) => setShell(e.target.value)}>
            {SHELLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="cc-btn" disabled={busy} onClick={() => void startRemoteSession(deviceId)}>
            Start remote session
          </button>
          <button className="cc-btn cc-btn--primary" disabled={busy || !deviceId} onClick={() => void createSession()}>
            New terminal
          </button>
        </div>
        {activeRemote && (
          <div className="cc-hint cc-mono" style={{ marginTop: 8 }}>
            remote {activeRemote.id} — {activeRemote.state} (expires {activeRemote.expiresAt ? new Date(activeRemote.expiresAt).toLocaleString() : 'n/a'})
          </div>
        )}
      </div>

      <div className="cc-card">
        <h3>Sessions</h3>
        {sessions.length === 0 && <div className="cc-hint">No terminal sessions yet.</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
              cursor: 'pointer',
            }}
            onClick={() => {
              void selectSession(s.id);
              void loadActive(s.id);
            }}
          >
            <span>
              <span className="cc-mono">{s.id}</span> · {s.deviceName} · {s.shell}{' '}
              <span className={`cc-pill--dot ${s.status === 'RUNNING' ? 'ok' : 'warn'}`} style={{ display: 'inline-block' }} /> {s.status}
              {s.pid ? <span className="cc-hint"> (pid {s.pid})</span> : null}
            </span>
            <span className="cc-hint">{s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}</span>
          </div>
        ))}
      </div>

      {activeId && (
        <div className="cc-card">
          <h3>
            Session {view?.session.id ?? activeId}
            {view?.session.pid ? <span className="cc-hint"> — pid {view.session.pid}</span> : null}
          </h3>
          <div
            className="cc-mono"
            data-testid="terminal-output"
            style={{
              background: '#111',
              color: '#7dff9e',
              borderRadius: 8,
              padding: '12px 16px',
              minHeight: 160,
              maxHeight: 320,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              marginTop: 8,
            }}
          >
            {view && view.history.length === 0 && <span className="cc-hint">No output yet — RUNNING only when the agent reports a real pid.</span>}
            {view?.history.map((line) => (
              <div key={line.id}>{line.text}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              className="cc-input"
              style={{ flex: 1 }}
              value={input}
              placeholder="low-risk command only (approval-required input is refused)"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
            />
            <button className="cc-btn" disabled={!input.trim()} onClick={() => void send()}>
              Send
            </button>
            <button className="cc-btn" disabled={!view?.session.pid} onClick={() => void act(`/api/v1/terminal/sessions/${activeId}/kill`, 'Session killed')}>
              Kill
            </button>
            <button className="cc-btn" onClick={() => void act(`/api/v1/terminal/sessions/${activeId}/restart`, 'Session restarted')}>
              Restart
            </button>
            <button className="cc-btn" onClick={() => void downloadLogs()}>
              Logs
            </button>
            <button className="cc-btn" disabled={screenshotBusy || !activeRemote} onClick={() => void requestScreenshot()}>
              Screenshot
            </button>
          </div>
        </div>
      )}

      <div className="cc-card">
        <h3>History search</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="cc-input" style={{ flex: 1 }} value={q} placeholder="search terminal history" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
          <button className="cc-btn" disabled={!q.trim()} onClick={() => void search()}>
            Search
          </button>
        </div>
        {results !== null && results.length === 0 && <div className="cc-hint">No matches.</div>}
        {results?.map((line) => (
          <div key={line.id} className="cc-mono">
            [{line.sessionId}] {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
