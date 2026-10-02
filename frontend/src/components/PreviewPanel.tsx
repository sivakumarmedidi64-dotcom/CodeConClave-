/**
 * CodeConClave — main-workspace live preview panel (Stage 25.5).
 * One preview session per project, server-derived states. This panel never
 * fabricates a rendered preview: READY renders the sandboxed build output in
 * an iframe; NOT_CONFIGURED/ERROR show the honest server reason with no fake
 * controls. State updates arrive over the SSE stream (no polling).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { PreviewEvent, PreviewSession, PreviewState } from '../lib/types';

const STATE_COLORS: Record<PreviewState, string> = {
  OFFLINE: '#64748b',
  BUILDING: '#8A3FFC',
  UPDATING: '#8A3FFC',
  READY: '#1e7d46',
  ERROR: '#dc2626',
  NOT_CONFIGURED: '#8a8a8a',
};

const STATE_LABEL: Record<PreviewState, string> = {
  OFFLINE: 'Offline',
  BUILDING: 'Building',
  UPDATING: 'Updating',
  READY: 'Ready',
  ERROR: 'Error',
  NOT_CONFIGURED: 'Not configured',
};

export function PreviewPanel({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<{ close: () => void } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ session: PreviewSession; configured: boolean }>(`/api/v1/preview/${encodeURIComponent(projectId)}`);
      setSession(res.session);
      setConfigured(res.configured);
    } catch {
      setSession(null);
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  // SSE stream: reconnect on error/close; bounces with backoff, stops when
  // the session is READY and the user is not watching a build.
  useEffect(() => {
    if (!projectId) return;
    if (typeof EventSource === 'undefined') {
      void load();
      return;
    }
    let disposed = false;
    let retry = 0;
    const connect = () => {
      if (disposed) return;
      setStreaming(true);
      const es = new EventSource(`/api/v1/preview/${encodeURIComponent(projectId)}/stream`);
      const onEvent = (ev: MessageEvent<string>) => {
        retry = 0;
        try {
          const data = JSON.parse(ev.data) as PreviewEvent;
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  state: data.state,
                  version: data.version,
                  task_id: data.taskId,
                  error: data.error,
                }
              : prev,
          );
        } catch {
          /* malformed frame: ignore, keep the stream */
        }
      };
      es.addEventListener('message', onEvent as EventListener);
      const onError = () => {
        es.close();
        setStreaming(false);
        if (disposed) return;
        retry += 1;
        const delay = Math.min(1000 * 2 ** Math.min(retry, 5), 30_000);
        setTimeout(connect, delay);
      };
      es.addEventListener('error', onError as EventListener);
      streamRef.current = {
        close: () => {
          es.removeEventListener('message', onEvent as EventListener);
          es.removeEventListener('error', onError as EventListener);
          es.close();
          setStreaming(false);
        },
      };
    };
    connect();
    void load();
    return () => {
      disposed = true;
      streamRef.current?.close();
    };
  }, [projectId, load]);

  const build = async () => {
    setBusy(true);
    try {
      const res = await api<{ session: PreviewSession }>(`/api/v1/preview/${encodeURIComponent(projectId)}/build`, { method: 'POST', body: {} });
      setSession(res.session);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const res = await api<{ session: PreviewSession }>(`/api/v1/preview/${encodeURIComponent(projectId)}/refresh`, { method: 'POST' });
      setSession(res.session);
    } finally {
      setBusy(false);
    }
  };

  const offline = async () => {
    try {
      const res = await api<{ session: PreviewSession }>(`/api/v1/preview/${encodeURIComponent(projectId)}/offline`, { method: 'POST' });
      setSession(res.session);
    } catch {
      /* keep the current state on failure */
    }
  };

  if (!loaded) return <div className="cc-card" data-testid="preview-panel">Loading preview…</div>;

  const state = session?.state ?? 'NOT_CONFIGURED';
  const color = STATE_COLORS[state] ?? '#334155';
  const log = session?.build_log ?? [];

  return (
    <div className="cc-card" data-testid="preview-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Live preview{projectName ? `: ${projectName}` : ''}</h3>
        <span
          data-testid="preview-state"
          className="cc-pill"
          style={{ background: color, color: '#fff', fontWeight: 700 }}
          title={session?.error ?? undefined}
        >
          {STATE_LABEL[state] ?? state}
        </span>
        {streaming && state !== 'READY' && <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>live</span>}
        {session?.error && <span className="cc-hint" style={{ margin: 0 }}>{session.error}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {configured && (
            <>
              {state !== 'READY' && state !== 'BUILDING' && state !== 'UPDATING' && (
                <button className="cc-btn cc-btn--sm" data-testid="preview-build" disabled={busy} onClick={() => void build()}>
                  Build
                </button>
              )}
              {state === 'READY' && (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={busy} onClick={() => void refresh()}>
                  Rebuild
                </button>
              )}
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void offline()}>
                Go offline
              </button>
            </>
          )}
          {log.length > 0 && (
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setShowLog((s) => !s)}>
              {showLog ? 'Hide log' : `Log (${log.length})`}
            </button>
          )}
        </div>
      </div>

      {state === 'NOT_CONFIGURED' && (
        <p className="cc-hint" style={{ margin: 0 }} data-testid="preview-honest">
          Preview tooling is not configured on this deployment — no build is queued and no preview is rendered.
          {configured ? '' : ' Configure PREVIEW_BUILD_ENABLED and PREVIEW_BUILD_COMMAND to enable it.'}
        </p>
      )}

      {state === 'OFFLINE' && <p className="cc-hint" style={{ margin: 0 }}>Preview session is offline. Run a build to see the app.</p>}

      {(state === 'BUILDING' || state === 'UPDATING') && <p className="cc-hint" style={{ margin: 0 }}>Building from the project workspace…</p>}

      {state === 'ERROR' && (
        <p className="cc-hint" style={{ margin: 0 }} data-testid="preview-honest">
          The build failed — no preview is rendered. {session?.error ?? ''}
        </p>
      )}

      {state === 'READY' && (
        <iframe
          data-testid="preview-frame"
          title={`Preview v${session?.version ?? ''}`}
          src={`/api/v1/preview/${encodeURIComponent(projectId)}/content`}
          sandbox="allow-scripts"
          style={{ width: '100%', height: 420, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8, background: '#fff' }}
        />
      )}

      {showLog && log.length > 0 && (
        <pre data-testid="preview-log" className="cc-mono" style={{ margin: 0, maxHeight: 180, overflowY: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>
          {log.join('\n')}
        </pre>
      )}
    </div>
  );
}
