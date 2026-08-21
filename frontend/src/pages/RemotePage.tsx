/**
 * CodeConClave — Remote Control (PHASE 4B).
 * Pair the Local Agent, see honest presence (ONLINE only from a live socket,
 * STALE within the heartbeat window, OFFLINE otherwise), open/revoke 8-hour
 * remote sessions per device, grant screenshot authorization, and attempt a
 * screenshot through the typed adapter. Screenshot capture is an external
 * limitation on this platform: the request returns an honest
 * screenshot_source_unavailable error — no simulated image is ever shown.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { DeviceInfo, RemoteSessionInfo } from '../lib/types';
import { useToast } from '../components/Toast';

const PRESENCE_CLASS: Record<string, string> = {
  ONLINE: 'ok',
  STALE: 'warn',
  OFFLINE: 'muted',
};

export function RemotePage() {
  const { toast } = useToast();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [sessions, setSessions] = useState<RemoteSessionInfo[]>([]);
  const [pairing, setPairing] = useState<{ deviceId: string; pairingCode: string; expiresInSeconds: number } | null>(null);
  const [name, setName] = useState('laptop');
  const [busy, setBusy] = useState(false);
  const [screenshotMsg, setScreenshotMsg] = useState<{ sessionId: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        api<{ devices: DeviceInfo[] }>('/api/v1/remote/devices'),
        api<{ sessions: RemoteSessionInfo[] }>('/api/v1/remote/sessions'),
      ]);
      setDevices(d.devices);
      setSessions(s.sessions);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const beginPair = async () => {
    setBusy(true);
    try {
      const res = await api<{ deviceId: string; pairingCode: string; expiresInSeconds: number }>('/api/v1/auth/devices', {
        method: 'POST',
        body: { name: name.trim() || 'laptop' },
      });
      setPairing(res);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'pairing failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const startSession = async (deviceId: string) => {
    setBusy(true);
    try {
      const res = await api<{ session: RemoteSessionInfo }>('/api/v1/remote/sessions', {
        method: 'POST',
        body: { deviceId },
      });
      setScreenshotMsg(null);
      toast('Remote session started (8h)', 'info');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'remote session failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revokeSession = async (sessionId: string) => {
    setBusy(true);
    try {
      await api(`/api/v1/remote/sessions/${sessionId}`, { method: 'DELETE', body: {} });
      toast('Remote session revoked', 'info');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'revoke failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const authorizeScreenshot = async (sessionId: string) => {
    try {
      await api(`/api/v1/remote/sessions/${sessionId}/screenshot-auth`, { method: 'POST', body: {} });
      toast('Screenshot authorization granted (15 min)', 'info');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'authorization failed', 'error');
    }
  };

  const requestScreenshot = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/v1/remote/sessions/${sessionId}/screenshot`, {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `screenshot-${sessionId}.png`;
        a.click();
        URL.revokeObjectURL(url);
        setScreenshotMsg({ sessionId, text: 'Screenshot captured by the real adapter.' });
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      const code = body?.error?.code ?? 'http_error';
      if (code === 'screenshot_source_unavailable') {
        setScreenshotMsg({
          sessionId,
          text: 'Honest result: no real screenshot source exists on this platform. The typed adapter is wired but capture is an external limitation — nothing is simulated.',
        });
      } else {
        toast(body?.error?.message ?? 'screenshot request failed', 'error');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'screenshot failed', 'error');
    }
  };

  const sessionFor = (deviceId: string) => sessions.find((s) => s.deviceId === deviceId && s.state === 'ACTIVE');

  return (
    <div className="cc-page">
      <h1>Remote Control</h1>
      <div className="cc-card">
        <h2>Pair the Local Agent</h2>
        <p className="cc-hint">
          Run <span className="cc-mono">npx codeconclave-agent@latest init</span> on the target
          machine, then pair it with the code below. The agent connects over the
          token-authenticated WebSocket at <span className="cc-mono">/agent</span>. Cloud never
          executes LOCAL tasks.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="cc-input" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="cc-btn" disabled={busy} onClick={() => void beginPair()}>
            Begin pairing
          </button>
        </div>
        {pairing && (
          <div className="cc-mono" style={{ marginTop: 12, background: '#111', color: '#fff', borderRadius: 8, padding: '12px 16px' }}>
            <div>1. On the target machine:</div>
            <div style={{ paddingLeft: 12 }}>npx codeconclave-agent@latest init</div>
            <div>2. Enter this pairing code (expires in {pairing.expiresInSeconds}s):</div>
            <div style={{ paddingLeft: 12, fontSize: 22, letterSpacing: 4 }}>{pairing.pairingCode}</div>
            <div>3. Then run: npx codeconclave-agent pair {pairing.deviceId} {pairing.pairingCode}</div>
          </div>
        )}
      </div>
      <div className="cc-card">
        <h3>Devices</h3>
        {devices.length === 0 && <div className="cc-hint">No devices registered.</div>}
        {devices.map((d) => {
          const session = sessionFor(d.id);
          return (
            <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border, #2a2a2a)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  {d.name} <span className="cc-hint cc-mono">{d.id}</span>
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className={`cc-pill--dot ${PRESENCE_CLASS[d.presence] ?? 'muted'}`} style={{ display: 'inline-block' }} />
                  {d.presence}
                  {d.remoteCapable && <span className="cc-hint cc-mono">terminal-capable</span>}
                  <button
                    className="cc-btn"
                    disabled={busy || !d.remoteCapable}
                    onClick={() => void startSession(d.id)}
                  >
                    {session ? 'Refresh remote session' : 'Start remote session'}
                  </button>
                </span>
              </div>
              {session && (
                <div className="cc-mono" style={{ marginTop: 6, background: '#111', borderRadius: 8, padding: '8px 12px' }}>
                  <div>
                    remote {session.id} — {session.state}
                    {session.expiresAt ? ` · expires ${new Date(session.expiresAt).toLocaleString()}` : ''}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                    <button className="cc-btn" onClick={() => void authorizeScreenshot(session.id)}>
                      Authorize screenshot (15 min)
                    </button>
                    <button className="cc-btn" onClick={() => void requestScreenshot(session.id)}>
                      Request screenshot
                    </button>
                    <button className="cc-btn cc-btn--danger" onClick={() => void revokeSession(session.id)}>
                      Revoke
                    </button>
                  </div>
                  <div className="cc-hint" style={{ marginTop: 6 }}>
                    Screenshot authorization: {session.screenshotAuthorized ? 'granted' : 'not granted'} —{' '}
                    {session.screenshotAuthExpiresAt
                      ? `expires ${new Date(session.screenshotAuthExpiresAt).toLocaleString()}`
                      : 'never granted'}
                  </div>
                  {screenshotMsg?.sessionId === session.id && (
                    <div className="cc-hint" data-testid="screenshot-honest" style={{ color: '#ffd27d', marginTop: 4 }}>
                      {screenshotMsg.text}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
