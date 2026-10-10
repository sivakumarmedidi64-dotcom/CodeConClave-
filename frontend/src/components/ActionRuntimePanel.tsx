/**
 * CodeConClave — Unified Action Runtime cockpit (P2).
 *
 * Exposes the real action runtime (/api/v1/actions). The server decides which
 * execution surfaces are enabled; this panel only renders that truth and posts
 * a request. It never enables a surface itself and never fabricates a result:
 * a disabled runtime, a disabled surface, an unpaired device or a policy
 * decision are all shown exactly as the server reports them.
 *
 * The runtime routes an action into the SAME task fabric that already runs
 * CLOUD/LOCAL work, so a routed action becomes a normal task visible in the
 * Workbench (Task / Agents / Verification / Audit).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

type Surface = 'CLOUD' | 'LOCAL' | 'BROWSER' | 'DESKTOP' | 'PREVIEW';

interface SurfaceView {
  surface: Surface;
  title: string;
  description: string;
  executionMode: string;
  enabled: boolean;
  reason: string;
}

interface DeviceRow {
  id: string;
  name: string;
  state: string;
  presence: string;
  capabilities: string[];
}

interface RouteResult {
  surface: string;
  executionMode: string;
  task?: { id?: string } & Record<string, unknown>;
  session?: { id?: string; state?: string; version?: number } | null;
}

interface StopAllResult {
  assignmentsCancelled: string[];
  assignmentsFailed: Array<{ id: string; error: string }>;
  tasksCancelled: string[];
  tasksSkipped: string[];
}

const BROWSER_OPS: Record<string, { cap: string; field: 'url' | 'selector' | 'query' }> = {
  navigate: { cap: 'browser.navigate', field: 'url' },
  open: { cap: 'browser.open', field: 'url' },
  read: { cap: 'browser.read', field: 'selector' },
  inspect: { cap: 'browser.inspect', field: 'selector' },
  search: { cap: 'browser.read', field: 'query' },
};

const DESKTOP_OPS: Record<string, { cap: string; field: 'none' | 'app' | 'title' }> = {
  list_windows: { cap: 'desktop.inspect', field: 'none' },
  open_app: { cap: 'desktop.open_app', field: 'app' },
  focus_window: { cap: 'desktop.focus_window', field: 'title' },
};

function msg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

export function ActionRuntimePanel({ projectId }: { projectId: string }) {
  const [runtimeEnabled, setRuntimeEnabled] = useState(false);
  const [surfaces, setSurfaces] = useState<SurfaceView[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [surface, setSurface] = useState<Surface>('CLOUD');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [command, setCommand] = useState('');
  const [origin, setOrigin] = useState('');
  const [browserOp, setBrowserOp] = useState('navigate');
  const [browserValue, setBrowserValue] = useState('');
  const [desktopOp, setDesktopOp] = useState('list_windows');
  const [desktopValue, setDesktopValue] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState<StopAllResult | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<{ enabled: boolean; surfaces: SurfaceView[] }>('/api/v1/actions/surfaces');
      setRuntimeEnabled(Boolean(s.enabled));
      setSurfaces(s.surfaces ?? []);
    } catch (e) {
      setError(msg(e, 'Could not load action surfaces'));
    }
    try {
      const d = await api<{ devices: DeviceRow[] }>('/api/v1/local-workspace/devices');
      const list = d.devices ?? [];
      setDevices(list);
      const firstOnline = list.find((x) => x.presence === 'ONLINE') ?? list[0];
      if (firstOnline) setDeviceId((cur) => cur || firstOnline.id);
    } catch {
      /* devices are optional for the CLOUD surface */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedSurface = surfaces.find((s) => s.surface === surface) ?? null;
  const needsDevice = surface === 'LOCAL' || surface === 'BROWSER' || surface === 'DESKTOP';
  const canSubmit = Boolean(projectId && title.trim() && selectedSurface?.enabled && runtimeEnabled && !busy);

  const buildLocalInstruction = (): unknown => {
    if (surface === 'LOCAL') return { command };
    if (surface === 'BROWSER') {
      const op = BROWSER_OPS[browserOp] ?? BROWSER_OPS.navigate!;
      const action: Record<string, unknown> = { op: browserOp };
      if (op.field === 'query') action.query = browserValue;
      else if (op.field === 'selector') action.selector = browserValue;
      else action.url = browserValue;
      return { type: 'browser', grants: { capabilities: [op.cap], allowedOrigins: [origin] }, actions: [action] };
    }
    const op = DESKTOP_OPS[desktopOp] ?? DESKTOP_OPS.list_windows!;
    const action: Record<string, unknown> = { op: desktopOp };
    if (op.field === 'app') action.app = desktopValue;
    if (op.field === 'title') action.title = desktopValue;
    return { type: 'desktop', grants: { capabilities: [op.cap] }, actions: [action] };
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { projectId, title: title.trim(), surface };
      if (description.trim()) body.description = description.trim();
      if (needsDevice && deviceId) body.deviceId = deviceId;
      // PREVIEW builds use the project's validated configuration — no ad-hoc
      // instruction is ever posted for it.
      if (surface !== 'CLOUD' && surface !== 'PREVIEW') body.localInstruction = buildLocalInstruction();
      const res = await api<RouteResult>('/api/v1/actions', { method: 'POST', body });
      setResult(res);
    } catch (e) {
      setError(msg(e, 'Could not route this action'));
    } finally {
      setBusy(false);
    }
  };

  const stopAll = async () => {
    // No client-side runtime gate here by design: stop-all is a safety
    // control and the server is authoritative — a disabled runtime answers
    // 503 and that refusal renders verbatim below.
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    setStopped(null);
    try {
      const res = await api<{ stopped: StopAllResult }>('/api/v1/actions/stop-all', { method: 'POST', body: { projectId } });
      setStopped(res.stopped);
    } catch (e) {
      setStopError(msg(e, 'Could not stop active work'));
    } finally {
      setStopping(false);
    }
  };

  if (!loaded) {
    return <p className="cc-hint" data-testid="action-runtime-loading">Loading action surfaces…</p>;
  }

  return (
    <div data-testid="action-runtime" className="space-y-3 p-1">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Actions</h2>
        <span
          data-testid="action-runtime-flag"
          className={`rounded px-2 py-0.5 text-xs font-semibold ${runtimeEnabled ? 'bg-green-600 text-white' : 'bg-gray-500 text-white'}`}
        >
          {runtimeEnabled ? 'runtime enabled' : 'runtime disabled'}
        </span>
      </div>

      <section className="rounded border p-3 text-xs">
        <h3 className="text-sm font-medium">Execution surfaces (server-derived)</h3>
        <ul className="mt-2 space-y-1">
          {surfaces.map((s) => (
            <li key={s.surface} data-testid={`action-surface-${s.surface}`} className="flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${s.enabled ? 'bg-green-600 text-white' : 'bg-gray-500 text-white'}`}
                data-testid={`action-surface-${s.surface}-state`}
              >
                {s.enabled ? 'enabled' : 'disabled'}
              </span>
              <strong>{s.title}</strong>
              <span className="text-gray-500">{s.description}</span>
              {!s.enabled && <span className="ml-auto text-gray-500" data-testid="action-surface-reason">{s.reason}</span>}
            </li>
          ))}
          {surfaces.length === 0 && <li className="text-gray-500">No surfaces reported.</li>}
        </ul>
      </section>

      {!runtimeEnabled && (
        <p data-testid="action-runtime-disabled" className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          The unified action runtime is disabled on this deployment (UNIFIED_ACTION_RUNTIME_ENABLED=false). Requests are refused server-side.
        </p>
      )}

      <section className="rounded border p-3 text-sm">
        <div className="grid gap-2">
          <label className="block text-xs text-gray-600">
            Surface
            <select
              data-testid="action-surface-select"
              className="mt-1 w-full rounded border px-2 py-1 text-xs"
              value={surface}
              onChange={(e) => setSurface(e.target.value as Surface)}
            >
              {surfaces.map((s) => (
                <option key={s.surface} value={s.surface}>
                  {s.title} {s.enabled ? '' : '(disabled)'}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-gray-600">
            Title
            <input
              data-testid="action-title"
              className="mt-1 w-full rounded border px-2 py-1 text-xs"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What should the coworker do?"
            />
          </label>

          <label className="block text-xs text-gray-600">
            Description (optional)
            <input
              data-testid="action-description"
              className="mt-1 w-full rounded border px-2 py-1 text-xs"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {needsDevice && (
            <label className="block text-xs text-gray-600">
              Paired device
              <select
                data-testid="action-device"
                className="mt-1 w-full rounded border px-2 py-1 text-xs"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                <option value="">Select a device…</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.presence})
                  </option>
                ))}
              </select>
            </label>
          )}

          {surface === 'LOCAL' && (
            <label className="block text-xs text-gray-600">
              Command
              <input
                data-testid="action-command"
                className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npm test"
              />
            </label>
          )}

          {surface === 'BROWSER' && (
            <>
              <label className="block text-xs text-gray-600">
                Operation
                <select data-testid="action-browser-op" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={browserOp} onChange={(e) => setBrowserOp(e.target.value)}>
                  {Object.keys(BROWSER_OPS).map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-gray-600">
                Allowed origin
                <input data-testid="action-browser-origin" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://example.com" />
              </label>
              <label className="block text-xs text-gray-600">
                {BROWSER_OPS[browserOp]?.field}
                <input data-testid="action-browser-value" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={browserValue} onChange={(e) => setBrowserValue(e.target.value)} />
              </label>
            </>
          )}

          {surface === 'DESKTOP' && (
            <>
              <label className="block text-xs text-gray-600">
                Operation
                <select data-testid="action-desktop-op" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={desktopOp} onChange={(e) => setDesktopOp(e.target.value)}>
                  {Object.keys(DESKTOP_OPS).map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
              </label>
              {DESKTOP_OPS[desktopOp]?.field !== 'none' && (
                <label className="block text-xs text-gray-600">
                  {DESKTOP_OPS[desktopOp]?.field}
                  <input data-testid="action-desktop-value" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={desktopValue} onChange={(e) => setDesktopValue(e.target.value)} />
                </label>
              )}
            </>
          )}

          {surface === 'PREVIEW' && (
            <p className="text-xs text-gray-500">
              Preview builds use the project&apos;s validated configuration — no command or device is posted.
            </p>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button data-testid="action-submit" className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50" disabled={!canSubmit} onClick={() => void submit()}>
            Route action
          </button>
          {!runtimeEnabled && <span className="text-xs text-gray-500">runtime disabled — request will be refused</span>}
          {runtimeEnabled && !selectedSurface?.enabled && <span className="text-xs text-gray-500">surface disabled — request will be refused</span>}
        </div>
      </section>

      {result && (
        <section data-testid="action-result" className="rounded border border-green-300 bg-green-50 p-3 text-xs">
          {result.session ? (
            <div>
              Preview build requested — state <strong data-testid="action-result-session">{result.session.state ?? 'unknown'}</strong>
              {typeof result.session.version === 'number' && <span> (v{result.session.version})</span>}. Open the Preview tab to follow it.
            </div>
          ) : (
            <>
              <div>
                Routed to <strong>{result.surface}</strong> ({result.executionMode}). Open the Task tab to follow it and the Audit tab for evidence.
              </div>
              <div className="mt-1">
                Task:{' '}
                <span data-testid="action-result-task" className="font-mono">
                  {result.task?.id ?? '(no id)'}
                </span>
              </div>
            </>
          )}
        </section>
      )}

      {error && <p data-testid="action-error" className="text-sm text-red-600">{error}</p>}

      <section className="rounded border border-red-200 p-3 text-xs">
        <div className="flex items-center gap-2">
          <button
            data-testid="action-stop-all"
            className="rounded bg-red-600 px-3 py-1 text-xs text-white disabled:opacity-50"
            disabled={stopping}
            onClick={() => void stopAll()}
            title="Stop-all is a safety control: the server decides what stops and reports refusals verbatim."
          >
            {stopping ? 'Stopping…' : 'Stop all work'}
          </button>
          <span className="text-gray-500">Cancels active local assignments and cancellable tasks in this project.</span>
        </div>
        {stopped && (
          <p data-testid="action-stop-all-result" className="mt-2">
            Stopped {stopped.assignmentsCancelled.length} assignment(s) and {stopped.tasksCancelled} task(s);
            {' '}{stopped.assignmentsFailed.length + stopped.tasksSkipped.length} item(s) already terminal or unconfirmed.
          </p>
        )}
        {stopError && <p data-testid="action-stop-all-error" className="text-sm text-red-600">{stopError}</p>}
      </section>
    </div>
  );
}
