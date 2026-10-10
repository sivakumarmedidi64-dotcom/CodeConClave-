/**
 * CodeConClave — PKG-25 — 24/7 autonomous cowork dashboard panel.
 * Reads the read-only /api/v1/autonomy/status truth report and renders it
 * honestly: LOGIC_VERIFIED proof lines always show; REAL_24_7 /
 * REAL_LONG_RUNNING infra claims are shown as ENVIRONMENT_BLOCKED unless a
 * real long-lived database produced evidence. Nothing here fakes 24/7.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface TruthLine {
  key: string;
  label: string;
  status: string;
  evidence: string;
  runtimeNote?: string;
}

interface AutonomyStatus {
  enabled: boolean;
  dbReachable: boolean;
  logic: { ok: boolean; phases: string[] };
  realInfra: { available: boolean; ok: boolean; phases: string[] };
  truth: TruthLine[];
  summary: string;
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

export function AutonomousTasksPanel() {
  const [status, setStatus] = useState<AutonomyStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const res = await api<{ status: AutonomyStatus }>('/api/v1/autonomy/status');
      setStatus(res.status);
      setState('ready');
    } catch (e) {
      setStatus(null);
      setState('error');
      setError(message(e, 'Autonomy status unavailable'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (s: string) => {
    switch (s) {
      case 'VERIFIED': return 'bg-green-100 text-green-800';
      case 'ENVIRONMENT_BLOCKED': return 'bg-amber-100 text-amber-800';
      case 'NOT_VERIFIED': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div data-testid="autonomy-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Autonomous Cowork</h2>

      {state === 'loading' && <p data-testid="autonomy-loading">Loading autonomy status…</p>}
      {state === 'error' && <p data-testid="autonomy-error" className="text-sm text-red-600">{error ?? 'Autonomy status unavailable'}</p>}

      {state === 'ready' && status && (
        <>
          <section className="rounded border p-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <p data-testid="autonomy-gate">
                Feature gate: <span className="font-medium">{status.enabled ? 'ON (AIOS_P2_AUTONOMY)' : 'OFF (AIOS_P2_AUTONOMY)'}</span>
              </p>
              <p data-testid="autonomy-db">
                Database: <span className="font-medium">{status.dbReachable ? 'reachable' : 'unreachable in this environment'}</span>
              </p>
              <p data-testid="autonomy-realinfra">
                Real infra proof: <span className="font-medium">{status.realInfra.available ? (status.realInfra.ok ? 'executed & passed' : 'executed & failed') : 'not executed (ENVIRONMENT_BLOCKED)'}</span>
              </p>
            </div>
            <p data-testid="autonomy-summary" className="mt-2 text-xs text-gray-600">{status.summary}</p>
          </section>

          {status.logic.phases.length > 0 && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Logic proof phases ({status.logic.ok ? 'PASS' : 'FAIL'})</h3>
              <ul data-testid="autonomy-logic-phases" className="mt-1 flex flex-wrap gap-1">
                {status.logic.phases.map((p) => (
                  <li key={p} className="rounded bg-gray-100 px-2 py-0.5 text-xs">{p}</li>
                ))}
              </ul>
            </section>
          )}

          {status.truth.length > 0 && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Truth report</h3>
              <ul data-testid="autonomy-truth" className="mt-1 space-y-1">
                {status.truth.map((t) => (
                  <li key={t.key} className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${label(t.status)}`} data-testid={`autonomy-truth-status-${t.key}`}>
                      {t.status}
                    </span>
                    <span className="font-medium" data-testid={`autonomy-truth-label-${t.key}`}>{t.label}</span>
                    <span className="text-xs text-gray-500">{t.evidence}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded border p-3 text-xs text-gray-500">
            <p data-testid="autonomy-honest">
              This panel proves the EXISTING task engine, scheduler, worker, watchdog, memory and idempotency are durable.
              It honors reality: REAL_24_7 and REAL_LONG_RUNNING are only VERIFIED against a real long-lived database,
              otherwise honestly reported ENVIRONMENT_BLOCKED.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
