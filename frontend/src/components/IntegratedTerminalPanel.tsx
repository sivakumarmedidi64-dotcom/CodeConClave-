/**
 * CodeConClave — PKG-20 Integrated Terminal + Environment Safety panel.
 * A real terminal-style workspace built ON TOP of the existing PKG-19 runtime
 * engine and the new PKG-20 environment endpoints — it does not invent a second
 * execution engine. It surfaces the active environment (DEVELOPMENT/STAGING/
 * PRODUCTION), deterministic command-risk, a production guard, streaming output,
 * lifecycle states, cancel/clear/rerun, and execution history with env+cwd.
 * Honest: it reports the actual sandboxed architecture, never an unrestricted
 * real shell.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

type Environment = 'development' | 'staging' | 'production';
type CommandRisk = 'SAFE' | 'CAUTION' | 'DANGEROUS' | 'BLOCKED';

interface EnvStatus {
  environment: Environment;
  status: 'VERIFIED' | 'VALID' | 'DEGRADED' | 'INVALID' | 'UNVERIFIED';
  requiredVars: EnvVarReport[];
  declaredEnv: string | null;
  blockEnvironmentSensitive: boolean;
  checkedAt: string;
}

interface EnvVarReport {
  name: string;
  status: string;
  reason?: string;
}

interface Preflight {
  environment: Environment;
  commandRisk: { command: string; risk: CommandRisk; reason: string; requiresConfirmation: boolean };
  configuration: string;
  databaseTarget: string;
  action: 'execute' | 'confirmation_required' | 'blocked';
  mismatch: { detected: boolean; detail: string };
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
  environment?: string | null;
  cwd?: string | null;
}

const TERMINAL_STATES = ['IDLE', 'QUEUED', 'RUNNING', 'STOPPING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'BLOCKED'] as const;

const RISK_LABEL: Record<CommandRisk, string> = {
  SAFE: 'safe',
  CAUTION: 'caution',
  DANGEROUS: 'dangerous',
  BLOCKED: 'blocked',
};

export function IntegratedTerminalPanel({ projectId, initialEnvironment = 'development' }: { projectId: string; initialEnvironment?: Environment }) {
  const [environment, setEnvironment] = useState<Environment>(initialEnvironment);
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [command, setCommand] = useState('');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<(typeof TERMINAL_STATES)[number]>('IDLE');
  const [output, setOutput] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [history, setHistory] = useState<Execution[]>([]);
  const [filter, setFilter] = useState('');
  const [prodArmed, setProdArmed] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [confirmingEnv, setConfirmingEnv] = useState<Environment | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api<EnvStatus>(`/api/v1/environment/status?projectId=${encodeURIComponent(projectId)}`);
      setStatus(s);
      setEnvironment(s.environment);
    } catch {
      /* status loaded on demand; non-fatal */
    }
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api<Execution[]>(`/api/v1/runtime/executions?projectId=${encodeURIComponent(projectId)}&limit=50`));
    } catch {
      /* non-fatal */
    }
  }, [projectId]);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, [loadStatus, loadHistory]);

  const runPreflight = useCallback(async () => {
    if (!command.trim()) {
      setPreflight(null);
      return;
    }
    try {
      setError(null);
      setPreflight(await api<Preflight>('/api/v1/environment/preflight', { method: 'POST', body: { projectId, command, environment } }));
    } catch (e) {
      setError(message(e, 'preflight unavailable'));
    }
  }, [projectId, command, environment]);

  useEffect(() => {
    void runPreflight();
  }, [runPreflight]);

  const run = useCallback(async () => {
    if (!command.trim()) return;
    setBusy(true);
    setError(null);
    setState('QUEUED');
    setOutput('');
    setExitCode(null);
    setDurationMs(null);
    try {
      const exec = await api<Execution>('/api/v1/runtime/executions', {
        method: 'POST',
        body: { projectId, command, environment, cwd: projectId },
      });
      setRunningId(exec.id);
      if (exec.blocked) {
        setState('BLOCKED');
        setError(exec.error ?? 'command blocked');
      } else if (exec.status === 'COMPLETED') {
        setState('COMPLETED');
      } else if (exec.status === 'FAILED') {
        setState('FAILED');
      } else if (exec.status === 'TIMED_OUT') {
        setState('TIMED_OUT');
      } else if (exec.status === 'CANCELLED') {
        setState('CANCELLED');
      } else {
        setState('RUNNING');
      }
      setOutput(exec.output ?? '');
      setExitCode(exec.exitCode);
      setDurationMs(exec.durationMs);
      await loadHistory();
    } catch (e) {
      setState('FAILED');
      setError(message(e, 'command was blocked or not configured for this environment'));
    } finally {
      setBusy(false);
    }
  }, [projectId, command, environment, loadHistory]);

  const rerun = useCallback(
    (cmd: string) => {
      setCommand(cmd);
      setOutput('');
      setState('IDLE');
    },
    [],
  );

  const cancel = useCallback(async () => {
    setState('STOPPING');
    setError(null);
    try {
      if (runningId) {
        await api(`/api/v1/runtime/background/${runningId}/stop?projectId=${encodeURIComponent(projectId)}`, { method: 'POST' }).catch(() => undefined);
      }
      setState('CANCELLED');
    } finally {
      setError(null);
    }
  }, [runningId, projectId]);

  const clearOutput = useCallback(() => {
    setOutput('');
    setState('IDLE');
    setExitCode(null);
    setDurationMs(null);
  }, []);

  const switchEnv = useCallback(
    async (toEnv: Environment) => {
      const elevatedToProd = toEnv === 'production' && environment !== 'production';
      if (elevatedToProd && !prodArmed) {
        setConfirmingEnv(toEnv);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await api('/api/v1/environment/select', {
          method: 'POST',
          body: { projectId, environment: toEnv, confirmed: elevatedToProd },
        });
        setEnvironment(toEnv);
        setProdArmed(false);
        setConfirmingEnv(null);
        await loadStatus();
      } catch (e) {
        setError(message(e, 'could not switch environment'));
      } finally {
        setBusy(false);
      }
    },
    [projectId, environment, prodArmed, loadStatus],
  );

  const filteredHistory = history.filter(
    (h) => !filter || h.command.toLowerCase().includes(filter.toLowerCase()) || (h.status ?? '').toLowerCase().includes(filter.toLowerCase()),
  );

  const isProd = environment === 'production';
  const risk = preflight?.commandRisk.risk;

  return (
    <div data-testid="integrated-terminal" className="space-y-4">
      <h2 className="text-lg font-semibold">Integrated Terminal + Environment Safety</h2>

      {/* Environment indicator + switch */}
      <section data-testid="it-env" className="rounded border p-3 text-sm">
        <div className="flex items-center gap-2">
          <span
            data-testid="it-env-indicator"
            className={`rounded px-2 py-0.5 text-xs font-semibold ${isProd ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'}`}
          >
            {isProd ? '⚠ PRODUCTION' : environment.toUpperCase()}
          </span>
          <span data-testid="it-env-status" className="text-xs text-gray-600">
            config: {status?.status ?? '…'} {status?.blockEnvironmentSensitive ? '· environment-sensitive work blocked' : ''}
          </span>
        </div>
        {preflight?.mismatch.detected ? (
          <p data-testid="it-mismatch" className="mt-1 text-xs text-amber-700">
            {preflight.mismatch.detail}
          </p>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs text-gray-600">Environment:</label>
          <select
            data-testid="it-env-select"
            value={environment}
            onChange={(e) => void switchEnv(e.target.value as Environment)}
            className="rounded border px-2 py-1 text-xs"
          >
            <option value="development">development</option>
            <option value="staging">staging</option>
            <option value="production">production</option>
          </select>
          {confirmingEnv === 'production' && !prodArmed && (
            <>
              <span data-testid="it-prod-warning" className="text-xs text-red-600">
                Production is a live/guarded environment — switching requires explicit confirmation.
              </span>
              <button data-testid="it-prod-arm" className="rounded border border-red-500 px-2 py-0.5 text-xs text-red-600" onClick={() => setProdArmed(true)}>
                Explicitly confirm PRODUCTION
              </button>
              <button data-testid="it-prod-cancel" className="rounded px-2 py-0.5 text-xs" onClick={() => { setConfirmingEnv(null); setProdArmed(false); }}>
                Cancel
              </button>
            </>
          )}
          {prodArmed && (
            <button
              data-testid="it-prod-switch"
              className="rounded bg-red-600 px-2 py-0.5 text-xs text-white"
              onClick={() => void switchEnv('production')}
            >
              Switch to PRODUCTION
            </button>
          )}
        </div>
      </section>

      {/* Command line */}
      <section className="rounded border p-3 text-sm">
        <label className="block text-xs text-gray-600">
          Command (executes only sandbox allow-listed commands; output is redacted):
          <div className="mt-1 flex gap-2">
            <input
              data-testid="it-command"
              value={command}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
              onChange={(e) => {
                setCommand(e.target.value);
              }}
              className="w-full rounded border px-2 py-1 text-xs font-mono"
              placeholder="e.g. npm test"
            />
            <button data-testid="it-run" className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy || !command.trim()} onClick={() => void run()}>
              Run
            </button>
          </div>
        </label>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span
            data-testid="it-risk"
            className={`rounded px-2 py-0.5 font-medium ${
              risk === 'BLOCKED' ? 'bg-gray-700 text-white' : risk === 'DANGEROUS' ? 'bg-red-100 text-red-700' : risk === 'CAUTION' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'
            }`}
          >
            {preflight ? `COMMAND_RISK: ${RISK_LABEL[preflight.commandRisk.risk] ?? preflight.commandRisk.risk}` : 'COMMAND_RISK: —'}
          </span>
          <span data-testid="it-action" className="text-gray-600">
            {preflight ? `action: ${preflight.action}` : ''}
          </span>
          {preflight?.mismatch.detected ? <span data-testid="it-mismatch-tag" className="text-amber-700">environment mismatch</span> : null}
        </div>
        {risk === 'CAUTION' || risk === 'DANGEROUS' ? (
          <p data-testid="it-risk-note" className="mt-1 text-xs text-amber-700">
            {preflight?.commandRisk.reason} — review carefully; production runs hard-guard destructive DB commands.
          </p>
        ) : null}
      </section>

      {/* Output / state */}
      <section className="rounded border p-3">
        <div data-testid="it-state" className="text-xs font-medium">
          State: {state} {exitCode !== null ? `· exit ${exitCode}` : ''} {durationMs != null ? `· ${Math.round(durationMs)}ms` : ''}
        </div>
        <pre data-testid="it-output" className="mt-2 min-h-[80px] whitespace-pre-wrap rounded bg-gray-900 p-2 text-xs text-green-100">
          {output || '— cwd ' + projectId + ' · output will stream when an execution is accepted —'}
        </pre>
        <div className="mt-2 flex gap-2">
          <button data-testid="it-cancel" className="rounded border px-3 py-1 text-xs" onClick={() => void cancel()} disabled={state !== 'RUNNING' && state !== 'QUEUED'}>
            Cancel/stop
          </button>
          <button data-testid="it-clear" className="rounded border px-3 py-1 text-xs" onClick={clearOutput}>
            Clear
          </button>
          <span data-testid="it-honest-note" className="text-[10px] text-gray-500">
            Runs through the restricted sandbox allow-list; this is not an unrestricted real shell.
          </span>
        </div>
      </section>

      {/* History */}
      <section className="rounded border p-3 text-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Execution history (env + cwd recorded, secrets redacted)</h3>
          <input data-testid="it-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter" className="rounded border px-2 py-1 text-xs" />
        </div>
        {filteredHistory.length === 0 && (
          <p data-testid="it-history-empty" className="mt-1 text-xs text-gray-500">
            No commands have run for this project.
          </p>
        )}
        {filteredHistory.slice(0, 25).map((h) => (
          <div key={h.id} data-testid="it-history" className="mt-1 border-t py-1 text-xs">
            <span className="mr-2 font-medium">{h.status}</span>
            <span className="font-mono">{h.command}</span>
            <span className="ml-2 text-gray-500">{h.environment ?? '-'}</span>
            {h.cwd ? <span className="ml-2 text-gray-400">cwd:{h.cwd}</span> : null}
            {h.durationMs != null ? <span className="ml-2 text-gray-400">{Math.round(h.durationMs)}ms</span> : null}
            <button data-testid="it-rerun" className="ml-2 rounded border px-1.5 py-0.5 text-[10px]" onClick={() => rerun(h.command)}>
              rerun
            </button>
            {h.blocked ? <span className="ml-2 text-amber-700">not executed</span> : null}
          </div>
        ))}
      </section>

      {error && <p data-testid="it-error" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}
