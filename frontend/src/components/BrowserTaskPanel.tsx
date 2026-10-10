/**
 * CodeConClave — Paired-device Browser Control panel (P1).
 *
 * Author + dispatch real browser instructions to a paired Local Agent and
 * watch the run live. Honesty rules baked in:
 *   - the device picker only offers PAIRED devices that are ONLINE and that
 *     advertise a `browser.*` capability (a device without grants is shown but
 *     not selectable — never guessed);
 *   - capabilities + allowed origins are DERIVED from the authored actions
 *     (the backend re-validates everything on POST regardless);
 *   - tasks containing consequential actions (click/type/select/submit,
 *     upload/download) are dispatched at risk HIGH so they pass the real
 *     human-approval step before any browser runs;
 *   - live progress comes from the real SSE runtime stream plus
 *     GET /tasks/:id/local — never fabricated; the last-known state survives a
 *     reload because the assignment row is the source of truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { workbenchStream } from '../lib/workbench';
import type { Task } from '../lib/types';
import { useToast } from './Toast';
import {
  BROWSER_MAX_ACTIONS,
  BROWSER_MAX_LIFETIME_MS,
  BROWSER_DEFAULT_LIFETIME_MS,
  BROWSER_OPS,
  BrowserOp,
  OP_FIELD_SET,
  OP_LABELS,
  type BrowserActionInput,
  type BrowserInstruction,
  buildBrowserInstruction,
  deriveBrowserCapabilities,
  effectiveAllowedOrigins,
  summarizeAction,
  validateAction,
} from '../lib/browserInstruction';

export interface PairedDevice {
  id: string;
  name: string;
  state: string;
  presence: string;
  capabilities: string[];
  remoteCapable: boolean;
  lastSeenAt: string | null;
}

interface LocalViewAssignment {
  id: string;
  task_id: string;
  device_id: string;
  status: string;
  result: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  artifact_refs: unknown[];
  lease_expires_at: string;
  error_code: string | null;
  error_detail: string | null;
}

interface LocalView {
  assignment: LocalViewAssignment | null;
  instruction: BrowserInstruction | null;
}

interface MonitorEntry {
  loading: boolean;
  error: string | null;
  local: LocalView | null;
}

const CONSEQUENTIAL_OPS = new Set<BrowserOp>([
  BrowserOp.CLICK,
  BrowserOp.TYPE,
  BrowserOp.SELECT,
  BrowserOp.SUBMIT,
  BrowserOp.DOWNLOAD,
  BrowserOp.UPLOAD,
]);

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'DEAD_LETTERED']);

function riskForActions(actions: BrowserActionInput[]): 'LOW' | 'MEDIUM' | 'HIGH' {
  return actions.some((a) => CONSEQUENTIAL_OPS.has(a.op)) ? 'HIGH' : 'MEDIUM';
}

function isBrowserCapable(d: PairedDevice): boolean {
  return d.capabilities.some((c) => c.startsWith('browser.'));
}

function fmt(action: Record<string, unknown>) {
  const step = action.step;
  if (step === 'action') {
    return `action ${Number(action.index ?? 0) + 1}/${String(action.actionsTotal ?? '?')} — ${String(action.op ?? '')}`;
  }
  return String(step ?? 'running');
}

export function BrowserTaskPanel({ projectId, tasks }: { projectId: string; tasks: Task[] }) {
  const { toast } = useToast();

  // ------------------------------------------------------------ device picker
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [devicesState, setDevicesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  const loadDevices = useCallback(async () => {
    setDevicesState('loading');
    setDevicesError(null);
    try {
      const res = await api<{ devices: PairedDevice[] }>('/api/v1/agent/status');
      const list = (res.devices ?? []).map((d) => ({
        ...d,
        capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
      }));
      setDevices(list);
      setDevicesState('ready');
      if (!list.some((d) => d.id === selectedDeviceId)) setSelectedDeviceId('');
    } catch (err) {
      setDevices([]);
      setDevicesState('error');
      setDevicesError(err instanceof Error ? err.message : 'Device status unavailable');
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    void loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectable = useMemo(
    () => devices.filter((d) => d.state === 'PAIRED' && d.presence === 'ONLINE' && isBrowserCapable(d)),
    [devices],
  );

  // ------------------------------------------------------------ instruction (author-time UI)
  const [actions, setActions] = useState<BrowserActionInput[]>([{ op: BrowserOp.OPEN, url: '' }]);
  const [extraOrigins, setExtraOrigins] = useState<string[]>([]);
  const [extraOriginInput, setExtraOriginInput] = useState('');
  const [lifetimeMs, setLifetimeMs] = useState<number>(BROWSER_DEFAULT_LIFETIME_MS);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [featureNote, setFeatureNote] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);

  const updateAction = (idx: number, patch: Partial<BrowserActionInput>) => {
    setActions((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  const changeOp = (idx: number, op: BrowserOp) => {
    setActions((prev) => prev.map((a, i) => (i === idx ? ({ op } as BrowserActionInput) : a)));
  };

  const removeAction = (idx: number) => {
    setActions((prev) => prev.filter((_, i) => i !== idx));
  };

  const addAction = () => {
    setActions((prev) => (prev.length >= BROWSER_MAX_ACTIONS ? prev : [...prev, { op: BrowserOp.OPEN, url: '' }]));
  };

  const addExtraOrigin = () => {
    const v = extraOriginInput.trim();
    if (!v) return;
    setExtraOrigins((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setExtraOriginInput('');
  };

  const derivedCaps = useMemo(() => deriveBrowserCapabilities(actions.filter((a) => a && typeof a.op === 'string')), [actions]);
  const origins = useMemo(() => effectiveAllowedOrigins(actions, extraOrigins), [actions, extraOrigins]);

  const dispatch = async () => {
    setBuildError(null);
    setFeatureNote(null);
    const { instruction, error } = buildBrowserInstruction({ actions, extraOrigins, lifetimeMs });
    if (!instruction || error) {
      setBuildError(error ?? 'invalid instruction');
      return;
    }
    if (!selectedDeviceId) {
      setBuildError('choose a paired online device with browser control');
      return;
    }
    const device = devices.find((d) => d.id === selectedDeviceId);
    if (!device) {
      setBuildError('choose a paired online device with browser control');
      return;
    }
    setDispatchBusy(true);
    try {
      const first = summarizeAction(actions[0] ?? { op: BrowserOp.OPEN, url: '' });
      const description = actions
        .map((a, i) => `${i + 1}. ${summarizeAction(a)}`)
        .join('\n')
        .slice(0, 2000);
      const res = await api<{ task: Task }>('/api/v1/execution/tasks', {
        method: 'POST',
        body: {
          projectId,
          title: `Browser: ${first}`,
          description: description || undefined,
          riskLevel: riskForActions(actions),
          executionMode: 'LOCAL',
          localInstruction: instruction,
          deviceId: selectedDeviceId,
        },
      });
      toast('Task dispatched to the paired device');
      setRecentIds((prev) => (prev.includes(res.task.id) ? prev : [...prev, res.task.id]));
      setFeatureNote(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'browser_control_disabled') {
        setFeatureNote('Browser control is DISABLED on this deployment (backend BROWSER_CONTROL_ENABLED). The task was not created.');
      } else {
        toast(err instanceof Error ? err.message : 'dispatch failed', 'error');
      }
    } finally {
      setDispatchBusy(false);
    }
  };

  // ------------------------------------------------------------ active browser tasks (monitor)
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [monitors, setMonitors] = useState<Record<string, MonitorEntry>>({});
  const [streamed, setStreamed] = useState(false);
  const loadedRef = useRef<Set<string>>(new Set());

  const monitoredIds = useMemo(() => {
    const ids = new Set<string>(recentIds);
    for (const t of tasks) {
      if (t.executionMode === 'LOCAL' && !TERMINAL.has(t.status)) ids.add(t.id);
    }
    return [...ids];
  }, [recentIds, tasks]);

  const monitoredKey = monitoredIds.slice().sort().join(',');

  const refreshLocal = useCallback(async (taskId: string) => {
    setMonitors((prev) => ({ ...prev, [taskId]: { ...(prev[taskId] ?? { local: null }), loading: true, error: null } }));
    try {
      const res = await api<{ local: LocalView | null }>(`/api/v1/execution/tasks/${encodeURIComponent(taskId)}/local`);
      setMonitors((prev) => ({ ...prev, [taskId]: { loading: false, error: null, local: res.local } }));
    } catch (err) {
      setMonitors((prev) => ({ ...prev, [taskId]: { loading: false, error: err instanceof Error ? err.message : 'local view failed', local: null } }));
    }
  }, []);

  useEffect(() => {
    const ids = new Set(monitoredIds);
    setMonitors((prev) => {
      const next: Record<string, MonitorEntry> = {};
      for (const id of ids) next[id] = prev[id] ?? { loading: false, error: null, local: null };
      return next;
    });
    for (const id of monitoredIds) {
      if (!loadedRef.current.has(id)) {
        loadedRef.current.add(id);
        void refreshLocal(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoredKey, refreshLocal]);

  useEffect(() => {
    if (!projectId) return;
    const stream = workbenchStream(projectId, {
      onEvent: (e) => {
        if (e.type === 'task' && loadedRef.current.has(e.id)) void refreshLocal(e.id);
      },
      onState: (c) => setStreamed(c),
    });
    return () => stream.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshLocal]);

  const deviceName = (id: string | undefined | null) => devices.find((d) => d.id === id)?.name ?? id ?? 'unknown device';

  const opField = (idx: number) => {
    const a = actions[idx]!;
    const op = a.op;
    const err = validateAction(op, a);
    const input = (key: string, placeholder: string, value: string, onChange: (v: string) => void) => (
      <input
        className="cc-input"
        style={{ minWidth: 0, flex: '1 1 180px' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', flex: '1 1 480px' }}>
        {OP_FIELD_SET.url.has(op) &&
          input('url', op === BrowserOp.DOWNLOAD ? 'url (optional)' : 'https://…', a.url ?? '', (v) => updateAction(idx, { url: v }))}
        {OP_FIELD_SET.selector.has(op) &&
          input('selector', 'CSS selector', a.selector ?? '', (v) => updateAction(idx, { selector: v }))}
        {OP_FIELD_SET.text.has(op) && input('text', 'text to type', a.text ?? '', (v) => updateAction(idx, { text: v }))}
        {OP_FIELD_SET.value.has(op) && input('value', 'option value', a.value ?? '', (v) => updateAction(idx, { value: v }))}
        {OP_FIELD_SET.query.has(op) && input('query', 'text to find on page', a.query ?? '', (v) => updateAction(idx, { query: v }))}
        {OP_FIELD_SET.direction.has(op) && (
          <>
            <select className="cc-select" style={{ flex: '0 0 auto' }} value={a.direction ?? 'down'} onChange={(e) => updateAction(idx, { direction: e.target.value as 'up' | 'down' | 'top' | 'bottom' })}>
              <option value="down">down</option>
              <option value="up">up</option>
              <option value="top">top</option>
              <option value="bottom">bottom</option>
            </select>
            <input
              className="cc-input"
              style={{ width: 90 }}
              type="number"
              min={0}
              step={100}
              placeholder="px (optional)"
              value={a.amount ?? ''}
              onChange={(e) => updateAction(idx, { amount: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
            />
          </>
        )}
        {OP_FIELD_SET.selectors.has(op) &&
          input(
            'selectors',
            'selectors, comma separated',
            (a.selectors ?? []).join(', '),
            (v) => updateAction(idx, { selectors: v.split(',').map((s) => s.trim()).filter(Boolean) }),
          )}
        {OP_FIELD_SET.path.has(op) && input('path', op === BrowserOp.UPLOAD ? 'absolute path to upload' : 'path (optional)', a.path ?? '', (v) => updateAction(idx, { path: v }))}
        {err && <span className="cc-error">{err}</span>}
      </div>
    );
  };

  return (
    <section className="cc-card" style={{ marginTop: 20 }}>
      <h2>Paired-device Browser Control</h2>
      <p className="cc-hint">
        Author a fixed instruction and run it on a paired device's managed headless browser (codeconclave-agent must enable{' '}
        <span className="cc-code">browser</span> grants; backend sets <span className="cc-code">BROWSER_CONTROL_ENABLED=true</span>).
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <label className="cc-hint" style={{ marginRight: 4 }}>
          Device:
        </label>
        {devicesState === 'loading' && <span className="cc-hint">Loading devices…</span>}
        {devicesState === 'error' && (
          <>
            <span className="cc-error">{devicesError}</span>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void loadDevices()}>
              Retry
            </button>
          </>
        )}
        {devicesState === 'ready' && (
          <select
            className="cc-select"
            style={{ minWidth: 240 }}
            aria-label="Device"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
          >
            <option value="">select a device…</option>
            {selectable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.presence})
              </option>
            ))}
          </select>
        )}
        {devicesState === 'ready' && (
          <span className="cc-hint">
            {selectable.length} online browser-capable of {devices.length} paired
          </span>
        )}
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void loadDevices()}>
          Refresh
        </button>
      </div>
      {devicesState === 'ready' && devices.length > 0 && selectable.length === 0 && (
        <div className="cc-hint" style={{ marginTop: 6 }}>
          No paired device currently online advertises a <span className="cc-code">browser.*</span> capability. Enable it on the Local
          Agent (<span className="cc-code">codeconclave-agent browser enable</span>) and make sure the backend has{' '}
          <span className="cc-code">BROWSER_CONTROL_ENABLED=true</span>.
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>Instructions</h3>
      {actions.map((a, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
          <select className="cc-select" style={{ width: 140 }} value={a.op} onChange={(e) => changeOp(i, e.target.value as BrowserOp)}>
            {BROWSER_OPS.map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>
          {opField(i)}
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => removeAction(i)} disabled={actions.length <= 1}>
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={addAction} disabled={actions.length >= BROWSER_MAX_ACTIONS}>
          Add action ({actions.length}/{BROWSER_MAX_ACTIONS})
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr 200px', marginTop: 12 }}>
        <div>
          <div className="cc-hint">Extra allowed origin (optional)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="cc-input"
              placeholder="https://another.example.com or https://ex.:*"
              value={extraOriginInput}
              onChange={(e) => setExtraOriginInput(e.target.value)}
            />
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={addExtraOrigin}>
              Add
            </button>
          </div>
        </div>
        <div>
          <div className="cc-hint">Grant lifetime</div>
          <select className="cc-select" value={lifetimeMs} onChange={(e) => setLifetimeMs(Number(e.target.value))}>
            <option value={60 * 60 * 1000}>1 hour</option>
            <option value={24 * 60 * 60 * 1000}>24 hours</option>
            <option value={BROWSER_MAX_LIFETIME_MS}>30 days (max)</option>
          </select>
        </div>
        <div>
          <div className="cc-hint">Risk (server-gated)</div>
          <span className="cc-pill" style={{ borderColor: riskForActions(actions) === 'HIGH' ? '#c15f3c' : '#2563eb', color: riskForActions(actions) === 'HIGH' ? '#c15f3c' : '#2563eb' }}>
            {riskForActions(actions) === 'HIGH' ? 'HIGH — approval required' : 'MEDIUM'}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="cc-hint">
          Required capabilities: {derivedCaps.length ? derivedCaps.join(', ') : '—'}
        </div>
        <div className="cc-hint">
          Allowed origins: {origins.length ? origins.join(', ') : '—'}
        </div>
      </div>

      {buildError && <div className="cc-error" style={{ marginTop: 8 }}>{buildError}</div>}
      {featureNote && <div className="cc-error" style={{ marginTop: 8 }}>{featureNote}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button className="cc-btn" disabled={dispatchBusy || selectable.length === 0 || actions.length === 0} onClick={() => void dispatch()}>
          {dispatchBusy ? 'Dispatching…' : 'Dispatch browser task'}
        </button>
        <span className="cc-hint">
          {riskForActions(actions) === 'HIGH'
            ? 'Consequential actions — this task will wait for human approval before the browser runs.'
            : 'Read-only actions run immediately when a device is online.'}
        </span>
      </div>

      <h3 style={{ marginTop: 20 }}>Active browser tasks</h3>
      <div className="cc-hint">
        {streamed ? 'Live updates on (SSE).' : 'Live updates unavailable — showing last-known state; the page reloads task state every 8s.'}
      </div>
      {monitoredIds.length === 0 && <div className="cc-empty">No active LOCAL browser tasks.</div>}
      {monitoredIds.map((id) => {
        const m = monitors[id];
        const task = tasks.find((t) => t.id === id);
        const local = m?.local;
        const assignment = local?.assignment;
        const progress = assignment?.progress ?? null;
        const result = assignment?.result ?? null;
        const artifacts = Array.isArray(assignment?.artifact_refs) ? assignment.artifact_refs : [];
        return (
          <div className="cc-card" key={id} style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <strong>{task?.title ?? id}</strong>
              <span className="cc-pill" style={{ fontSize: 11 }}>
                {task?.status ?? '…'}
              </span>
            </div>
            {task?.description && <div className="cc-hint" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{task.description}</div>}
            {local?.instruction && (
              <div className="cc-hint" style={{ marginTop: 4 }}>
                device: {deviceName(assignment?.device_id)} · {local.instruction.actions.length} actions ·{' '}
                {local.instruction.actions.map((ac) => ac.op).join(' → ')}
              </div>
            )}
            {m?.loading && !assignment && <div className="cc-hint" style={{ marginTop: 6 }}>Refreshing…</div>}
            {m?.error && <div className="cc-error" style={{ marginTop: 6 }}>{m.error}</div>}
            {!m?.loading && !m?.error && !assignment && (
              <div className="cc-hint" style={{ marginTop: 6 }}>No local assignment yet — waiting for the Local Agent.</div>
            )}
            {!m?.loading && !m?.error && assignment && (
              <div style={{ marginTop: 6 }}>
                <div className="cc-hint">
                  assignment {assignment.id.slice(0, 8)} · {assignment.status} · lease until {new Date(assignment.lease_expires_at).toLocaleString()}
                </div>
                {progress && (
                  <div className="cc-hint" style={{ marginTop: 4 }}>
                    progress: {fmt(progress)}
                  </div>
                )}
                {result && (
                  <div className="cc-hint" style={{ marginTop: 4 }}>
                    result: {JSON.stringify(result).slice(0, 300)}
                  </div>
                )}
                {assignment.error_code && (
                  <div className="cc-error" style={{ marginTop: 4 }}>
                    {assignment.error_code}
                    {assignment.error_detail ? ` — ${assignment.error_detail.slice(0, 500)}` : ''}
                  </div>
                )}
                {artifacts.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <span className="cc-hint">artifacts:</span>{' '}
                    {artifacts.map((raw, i) => {
                      const a = (raw ?? {}) as Record<string, unknown>;
                      return (
                        <span className="cc-pill" key={i} style={{ marginRight: 6, fontSize: 11 }}>
                          {String(a.kind ?? 'artifact')} · {String(a.path ?? '')} · {Number(a.bytes ?? 0)} B · sha {String(a.sha256 ?? '').slice(0, 12)}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}