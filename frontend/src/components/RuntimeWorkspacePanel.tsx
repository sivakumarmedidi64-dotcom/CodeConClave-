/**
 * CodeConClave — PKG-19 Browser + Runtime Development workspace panel.
 * Honest, server-authoritative RUN → OBSERVE → PREVIEW → DEBUG → VERIFY loop
 * anchored to F34 (Terminal), F90 (Local Terminal Execution), F38 (Preview
 * System), F49 (WebSocket Hub). Nothing is shown as success before the backend
 * confirms it, and capture/verification/smoke surfaces report their true state
 * (e.g. UNAVAILABLE / NOT_RUN) when there is no live browser evidence.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface RuntimeCapabilities {
  executionEnabled: boolean;
  backgroundEnabled: boolean;
  consoleCapture: 'VERIFIED_READY' | 'UNAVAILABLE' | 'ENVIRONMENT_BLOCKED';
  networkCapture: 'VERIFIED_READY' | 'UNAVAILABLE' | 'ENVIRONMENT_BLOCKED';
  verificationEnabled: boolean;
  smokeEnabled: boolean;
  browserRuntime: 'NONE' | 'PREVIEW_IFRAME';
}

interface RuntimeCapabilityReport {
  anchors: string[];
  capabilities: RuntimeCapabilities;
  limitations: string[];
}

interface Execution {
  id: string;
  projectId: string;
  kind: string;
  command: string;
  status: string;
  exitCode: number | null;
  blocked: boolean;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
}

interface Background {
  id: string;
  projectId: string;
  label: string;
  kind: string;
  command: string;
  status: string;
  latestOutput: string;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface ConsoleEvent {
  id: string;
  level: string;
  message: string;
  stack: string | null;
  sourceUrl: string | null;
  ts: string;
}

interface NetworkEvent {
  id: string;
  method: string;
  urlPath: string;
  status: number | null;
  durationMs: number | null;
  ok: boolean | null;
  state: string;
  requestId: string | null;
  ts: string;
}

interface VerificationResult {
  id: string;
  label: string;
  status: string;
  detail: string;
  ranAt: string;
}

interface SmokeRun {
  summary: { status: string; total: number; passed: number; failed: number; unavailable: number };
  results: { name: string; status: string; evidence: string; failureReason: string | null }[];
}

interface Correlation {
  findings: { id: string; state: string; frontendState: string; backendState: string | null; urlPath: string | null; hypothesis: string; backendError: string | null }[];
  state: 'HEURISTIC' | 'UNAVAILABLE';
}

const STATUS_LABEL: Record<string, string> = {
  READY: 'server-confirmed',
  RUNNING: 'running',
  STARTING: 'starting',
  STARTED: 'started',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed out',
  CANCELLED: 'cancelled',
  STOPPED: 'stopped',
  BLOCKED: 'blocked (not executed)',
  PASS: 'pass',
  PARTIAL: 'partial',
  NOT_RUN: 'not run',
  UNAVAILABLE: 'unavailable',
  HEURISTIC: 'heuristic only',
  VERIFIED_READY: 'capture ready',
};

export function RuntimeWorkspacePanel({ projectId }: { projectId: string }) {
  const [caps, setCaps] = useState<RuntimeCapabilityReport | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [command, setCommand] = useState('npm test');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [background, setBackground] = useState<Background[]>([]);
  const [consoleEvents, setConsoleEvents] = useState<ConsoleEvent[]>([]);
  const [networkEvents, setNetworkEvents] = useState<NetworkEvent[]>([]);
  const [verify, setVerify] = useState<VerificationResult[] | null>(null);
  const [smoke, setSmoke] = useState<SmokeRun | null>(null);
  const [correlation, setCorrelation] = useState<Correlation | null>(null);
  const [tab, setTab] = useState<'run' | 'observe' | 'verify'>('run');

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      setCaps(await api<RuntimeCapabilityReport>('/api/v1/runtime/capabilities'));
      setCapsState('ready');
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const refresh = useCallback(async () => {
    try {
      const [execs, bg, cons, net] = await Promise.all([
        api<Execution[]>(`/api/v1/runtime/executions?projectId=${encodeURIComponent(projectId)}`),
        api<Background[]>(`/api/v1/runtime/background?projectId=${encodeURIComponent(projectId)}`),
        api<ConsoleEvent[]>(`/api/v1/runtime/console?projectId=${encodeURIComponent(projectId)}`),
        api<NetworkEvent[]>(`/api/v1/runtime/network?projectId=${encodeURIComponent(projectId)}`),
      ]);
      setExecutions(execs);
      setBackground(bg);
      setConsoleEvents(cons);
      setNetworkEvents(net);
    } catch {
      /* refresh failures surfaced on demand via action errors */
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api<Execution>('/api/v1/runtime/executions', { method: 'POST', body: { projectId, command } });
      await refresh();
    } catch (e) {
      setError(message(e, 'command was blocked or not configured for this environment'));
    } finally {
      setBusy(false);
    }
  }, [projectId, command, refresh]);

  const startBackground = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api<Background>('/api/v1/runtime/background', {
        method: 'POST',
        body: { projectId, label: `bg-${Date.now()}`, command, kind: 'DEV_SERVER' },
      });
      await refresh();
    } catch (e) {
      setError(message(e, 'could not start background task'));
    } finally {
      setBusy(false);
    }
  }, [projectId, command, refresh]);

  const stopBackground = useCallback(
    async (id: string) => {
      await api(`/api/v1/runtime/background/${id}/stop?projectId=${encodeURIComponent(projectId)}`, { method: 'POST' });
      await refresh();
    },
    [projectId, refresh],
  );

  const runVerify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { results } = await api<{ results: VerificationResult[] }>('/api/v1/runtime/verify', {
        method: 'POST',
        body: { projectId },
      });
      setVerify(results);
    } catch (e) {
      setError(message(e, 'verification unavailable'));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const runSmoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSmoke(await api<SmokeRun>('/api/v1/runtime/smoke/run', { method: 'POST', body: { projectId } }));
    } catch (e) {
      setError(message(e, 'smoke suite unavailable'));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const runCorrelate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCorrelation(await api<Correlation>('/api/v1/runtime/correlate', { method: 'POST', body: { projectId } }));
    } catch (e) {
      setError(message(e, 'correlation unavailable'));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const c = caps?.capabilities;

  return (
    <div data-testid="runtime-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Browser + Runtime Development</h2>

      <section data-testid="runtime-capabilities" className="rounded border p-3 text-sm">
        <h3 className="text-sm font-medium">Runtime capabilities ({caps?.anchors.join(', ') ?? 'F34 F90 F38 F49'})</h3>
        {capsState === 'loading' && <p data-testid="runtime-caps-loading">Loading runtime status…</p>}
        {capsState === 'error' && <p data-testid="runtime-caps-error">Could not load runtime status.</p>}
        {capsState === 'ready' && c && (
          <div className="mt-2 space-y-1 text-xs text-gray-700">
            <p data-testid="runtime-cap-execution">Execution: {executionLabel(c.executionEnabled)}</p>
            <p data-testid="runtime-cap-console">Console capture: {STATUS_LABEL[c.consoleCapture] ?? c.consoleCapture}</p>
            <p data-testid="runtime-cap-network">Network capture: {STATUS_LABEL[c.networkCapture] ?? c.networkCapture}</p>
            <p data-testid="runtime-cap-verify">Verification: {c.verificationEnabled ? 'server check enabled' : 'not enabled'}</p>
            <p data-testid="runtime-cap-smoke">Smoke suite: {c.smokeEnabled ? 'configured' : 'not configured'}</p>
            <p data-testid="runtime-cap-browser">Browser runtime: {c.browserRuntime === 'PREVIEW_IFRAME' ? 'preview iframe' : 'none (no headless browser)'}</p>
          </div>
        )}
      </section>

      <div className="flex gap-2">
        {(['run', 'observe', 'verify'] as const).map((t) => (
          <button
            key={t}
            data-testid={`runtime-tab-${t}`}
            className={`rounded px-3 py-1 text-xs ${tab === t ? 'bg-blue-600 text-white' : 'border'}`}
            onClick={() => setTab(t)}
          >
            {t === 'run' ? 'Run' : t === 'observe' ? 'Observe' : 'Verify'}
          </button>
        ))}
      </div>

      {tab === 'run' && (
        <div className="space-y-3">
          <section className="rounded border p-3 text-sm">
            <label className="block text-xs text-gray-600">
              Command (executes only sandbox allow-listed commands):
              <input
                data-testid="runtime-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="mt-1 block w-full rounded border px-2 py-1 text-xs font-mono"
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                data-testid="runtime-run"
                className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                disabled={busy}
                onClick={() => void run()}
              >
                Run command
              </button>
              <button
                data-testid="runtime-bg-start"
                className="rounded border px-3 py-1 text-xs disabled:opacity-50"
                disabled={busy}
                onClick={() => void startBackground()}
              >
                Start background task
              </button>
            </div>
          </section>

          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Recent executions</h3>
            {executions.length === 0 && (
              <p data-testid="runtime-executions-empty" className="text-xs text-gray-500">
                No commands have run for this project.
              </p>
            )}
            {executions.slice(0, 10).map((e) => (
              <div key={e.id} data-testid="runtime-execution" className="mt-1 border-t py-1 text-xs">
                <span data-testid="runtime-exec-status" className="mr-2 font-medium">{STATUS_LABEL[e.status] ?? e.status}</span>
                <span className="font-mono">{e.command}</span>
                {e.blocked && <span data-testid="runtime-exec-blocked" className="ml-2 text-amber-700">not executed</span>}
                {e.output ? (
                  <pre data-testid="runtime-exec-output" className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 text-[10px]">{e.output}</pre>
                ) : null}
                {e.error && <p className="text-red-600">{e.error}</p>}
              </div>
            ))}

            <h3 className="mt-3 text-sm font-medium">Background tasks</h3>
            {background.length === 0 && (
              <p data-testid="runtime-bg-empty" className="text-xs text-gray-500">No background tasks yet.</p>
            )}
            {background.map((b) => (
              <div key={b.id} data-testid="runtime-bg" className="mt-1 border-t py-1 text-xs">
                <span className="mr-2 font-medium">{STATUS_LABEL[b.status] ?? b.status}</span>
                <span className="font-mono">{b.label}</span>
                {(b.status === 'RUNNING' || b.status === 'STARTING') && (
                  <button
                    data-testid="runtime-bg-stop"
                    className="ml-2 rounded border px-2 py-0.5 text-[10px]"
                    onClick={() => void stopBackground(b.id)}
                  >
                    Stop (best-effort)
                  </button>
                )}
                {b.latestOutput ? <pre className="mt-1 whitespace-pre-wrap bg-gray-50 p-2 text-[10px]">{b.latestOutput}</pre> : null}
              </div>
            ))}
          </section>
        </div>
      )}

      {tab === 'observe' && (
        <div className="space-y-3">
          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Console events</h3>
            <p data-testid="runtime-console-status" className="text-xs text-amber-700">
              Console capture: {STATUS_LABEL[c?.consoleCapture ?? ''] ?? 'UNAVAILABLE'}. Events appear only when a live preview iframe forwards real browser console output.
            </p>
            {consoleEvents.length === 0 && (
              <p data-testid="runtime-console-empty" className="text-xs text-gray-500">No console events captured.</p>
            )}
            {consoleEvents.slice(0, 50).map((e) => (
              <div key={e.id} data-testid="runtime-console" className="mt-1 border-t py-1 text-xs">
                <span className="mr-2 font-medium">[{e.level}]</span> {e.message}
                {e.stack ? <pre className="text-[10px] text-gray-500">{e.stack}</pre> : null}
              </div>
            ))}
          </section>

          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Network events</h3>
            <p data-testid="runtime-network-status" className="text-xs text-amber-700">
              Network capture: {STATUS_LABEL[c?.networkCapture ?? ''] ?? 'UNAVAILABLE'}. Sensitive query params are redacted; bodies are never persisted.
            </p>
            {networkEvents.length === 0 && (
              <p data-testid="runtime-network-empty" className="text-xs text-gray-500">No network events captured.</p>
            )}
            {networkEvents.slice(0, 50).map((e) => (
              <div key={e.id} data-testid="runtime-network" className="mt-1 border-t py-1 text-xs">
                <span className="mr-2 font-medium">{e.method}</span> {e.urlPath} <span>{e.status ?? '—'}</span> [{e.state}]
              </div>
            ))}
          </section>

          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Frontend ↔ backend correlation</h3>
            <button
              data-testid="runtime-correlate"
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white"
              onClick={() => void runCorrelate()}
            >
              Correlate captured failures
            </button>
            {correlation && (
              <div data-testid="runtime-correlation" className="mt-2 text-xs">
                {correlation.state === 'UNAVAILABLE' && <p className="text-gray-500">No captured evidence to correlate (honest empty).</p>}
                {correlation.findings.map((f) => (
                  <p key={f.id} className="text-amber-700">
                    {f.urlPath ?? f.frontendState} — {f.hypothesis}
                  </p>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'verify' && (
        <div className="space-y-3">
          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Runtime verification</h3>
            <button
              data-testid="runtime-verify"
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void runVerify()}
            >
              Verify runtime
            </button>
            {verify?.map((v) => (
              <p key={v.id} data-testid="runtime-verify-row" className="mt-1 text-xs">
                <span className="mr-2 font-medium">{STATUS_LABEL[v.status] ?? v.status}</span>
                {v.label} — {v.detail}
              </p>
            ))}
          </section>

          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Smoke tests</h3>
            <button
              data-testid="runtime-smoke"
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void runSmoke()}
            >
              Run smoke suite
            </button>
            {smoke && (
              <div data-testid="runtime-smoke-result" className="mt-2 text-xs">
                <p>
                  Status <span className="font-medium">{STATUS_LABEL[smoke.summary.status] ?? smoke.summary.status}</span>
                  {' · '}
                  {smoke.summary.passed}/{smoke.summary.total} passed · {smoke.summary.failed} failed · {smoke.summary.unavailable} unavailable
                </p>
                {smoke.results.map((r, i) => (
                  <p key={i} className="mt-1">
                    [{r.status}] {r.name} — {r.evidence}
                    {r.failureReason ? <span className="text-red-600"> ({r.failureReason})</span> : null}
                  </p>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {error && <p data-testid="runtime-error" className="text-sm text-red-600">{error}</p>}

      {caps?.limitations?.length ? (
        <p data-testid="runtime-limitations" className="text-xs text-amber-700">
          {caps.limitations.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

function executionLabel(enabled: boolean): string {
  return enabled ? 'enabled (sandbox allow-list)' : 'not configured (sandbox deny-by-default)';
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}
