/**
 * CodeConClave — Coworkers: the nine-perspective team (catalogue + runs).
 * Loading/error states with retry; capability, permission and model chips
 * come from the server-authoritative coworker definitions.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { CoworkerRun, CoworkerType } from '../lib/types';

const RUN_STATE_COLOR: Record<string, string> = {
  COMPLETED: '#1e7d46',
  FAILED: '#dc2626',
  RUNNING: '#2563eb',
  WAITING: '#c15f3c',
  PENDING: '#c15f3c',
};

export function CoworkersPage() {
  const [coworkers, setCoworkers] = useState<CoworkerType[]>([]);
  const [runs, setRuns] = useState<CoworkerRun[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<{ coworkers: CoworkerType[]; runs: CoworkerRun[] }>('/api/v1/execution/coworkers');
      setCoworkers(res.coworkers);
      setRuns(res.runs);
      setState('ready');
    } catch {
      setCoworkers([]);
      setRuns([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="cc-page">
      <h1>Coworkers</h1>
      <div className="cc-hint">
        Nine perspectives run inside each 24/7 task: Architect → Coder → Security → Tester → Reviewer → Docs.
      </div>
      {state === 'loading' && <div className="cc-card cc-empty">Loading coworkers…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load the coworker catalogue.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && coworkers.length === 0 && <div className="cc-card cc-empty">Catalogue unavailable.</div>}
      {state === 'ready' && (
        <div className="cc-grid cc-grid-2">
          {coworkers.map((c) => (
            <div className="cc-card" key={c.type}>
              <h3 style={{ margin: 0 }}>{c.role}</h3>
              <div className="cc-hint cc-mono">{c.type}</div>
              <p style={{ margin: '8px 0 0' }}>{c.description}</p>
              {c.capabilities && c.capabilities.length > 0 && (
                <div className="cc-cap" style={{ marginTop: 8 }}>
                  {c.capabilities.map((cap) => (
                    <span className="on" key={cap}>{cap}</span>
                  ))}
                </div>
              )}
              {(c.permissionScope || c.modelPolicy) && (
                <div className="cc-hint" style={{ marginTop: 8 }}>
                  {c.permissionScope && <span>permission: {c.permissionScope}</span>}
                  {c.permissionScope && c.modelPolicy && <span> · </span>}
                  {c.modelPolicy && <span>model: class {c.modelPolicy.computeClass}, ≤{c.modelPolicy.maxTokens} tok</span>}
                </div>
              )}
              {c.memoryAccess && <div className="cc-hint">memory: {c.memoryAccess}</div>}
            </div>
          ))}
        </div>
      )}
      <h2 style={{ marginTop: 20 }}>Recent runs</h2>
      {state === 'ready' && runs.length === 0 && <div className="cc-card cc-empty">No runs yet.</div>}
      {state === 'ready' &&
        runs.map((r) => (
          <div className="cc-card" key={r.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{r.coworkerType}</strong>
              <span className="cc-pill" style={{ borderColor: RUN_STATE_COLOR[r.state] ?? '#ccc', color: RUN_STATE_COLOR[r.state] ?? '#111' }}>
                {r.state}
              </span>
            </div>
            <div className="cc-hint">task: {r.taskId}</div>
            {r.output && <p className="cc-mono" style={{ whiteSpace: 'pre-wrap', background: 'var(--cc-bg)', padding: 8, borderRadius: 6 }}>{r.output}</p>}
            {r.handoffTo && <div className="cc-hint">handoff → {r.handoffTo}</div>}
          </div>
        ))}
    </div>
  );
}