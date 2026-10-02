/**
 * CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence panel.
 * Server-authoritative deployment history: version, commit, environment, provider,
 * status, health/smoke gates, verification, rollback availability. Rollback is a
 * controlled, safety-checked operation; production rollback requires an explicit
 * confirmation (no silent rollback). Nothing is shown as rolled back before the
 * backend records and audits the outcome, and no secret material is rendered.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

export interface DeploymentSummary {
  deploymentId: string;
  projectId: string;
  environment: string;
  provider: string;
  service: string;
  version: string;
  commit: string | null;
  status: string;
  verification: string;
  health: string;
  smoke: string;
  rollbackAvailable: boolean;
  createdAt: string;
}

export interface RollbackRunView {
  id: string;
  projectId: string;
  environment: string;
  currentDeploymentId: string;
  targetDeploymentId: string;
  status: string;
  result: string;
  providerCapability: string;
  databaseCompat: string;
  reason?: string;
  safetyChecks?: { name: string; ok: boolean; detail: string }[];
  createdAt?: string;
  completedAt?: string | null;
}

export const ENV_LABEL: Record<string, string> = {
  development: 'Development',
  staging: 'Staging',
  production: 'Production',
};

const VERIFICATION_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  NOT_VERIFIED: 'not verified',
  PARTIAL: 'partial',
};

export function DeploymentHistoryPanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<DeploymentSummary[]>([]);
  const [current, setCurrent] = useState<DeploymentSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [lastRun, setLastRun] = useState<RollbackRunView | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [h, c] = await Promise.all([
        api<DeploymentSummary[]>(`/api/v1/release/${projectId}/history`),
        api<DeploymentSummary | null>(`/api/v1/release/${projectId}/current`),
      ]);
      setRows(Array.isArray(h) ? h : []);
      setCurrent(c);
      setState('ready');
    } catch {
      setRows([]);
      setCurrent(null);
      setState('error');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const doRollback = useCallback(
    async (target: DeploymentSummary) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const run = await api<RollbackRunView>(`/api/v1/release/${projectId}/rollback`, {
          method: 'POST',
          body: {
            targetDeploymentId: target.deploymentId,
            environment: target.environment,
            confirmed,
          },
        });
        setLastRun(run);
        setMessage(
          run.status === 'SUCCEEDED'
            ? `Rolled back to ${target.version}; verified by release service.`
            : `Rollback was not executed (${run.result}): ${run.reason ?? 'provider environment blocked or safety check failed'}`,
        );
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Rollback request failed');
      } finally {
        setBusy(false);
      }
    },
    [projectId, confirmed, load],
  );

  const isProd = (row: DeploymentSummary) => row.environment === 'production';

  const visible = rows.filter(
    (r) => filter === 'all' || r.environment === filter,
  );

  return (
    <div data-testid="deployment-history-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Deployment History &amp; Rollback</h2>

      <section data-testid="deployment-current" className="rounded border p-3 text-sm">
        <h3 className="text-sm font-medium">Current deployment</h3>
        {current ? (
          <p data-testid="deployment-current-row">
            {current.environment} · v{current.version}
            {current.commit ? ` @ ${current.commit.slice(0, 8)}` : ''} · {current.provider} ·{' '}
            [{current.status} · {VERIFICATION_LABEL[current.verification] ?? current.verification}]
          </p>
        ) : (
          <p data-testid="deployment-current-none">No current deployment identified.</p>
        )}
      </section>

      <section data-testid="deployment-history" className="rounded border p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Release history</h3>
          <label className="text-xs text-gray-600">
            Environment{' '}
            <select data-testid="deployment-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded border px-1 text-xs">
              <option value="all">all</option>
              <option value="development">Development</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
          </label>
        </div>

        {state === 'loading' && <p data-testid="deployment-history-loading">Loading deployment history…</p>}
        {state === 'error' && <p data-testid="deployment-history-error">Could not load deployment history.</p>}

        {state === 'ready' && visible.length === 0 && (
          <p data-testid="deployment-history-empty" className="text-sm text-gray-600">
            No deployment records for this environment.
          </p>
        )}

        {state === 'ready' && visible.map((row) => (
          <div key={row.deploymentId} data-testid={`deployment-row-${row.deploymentId}`} className="mt-2 rounded border p-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">v{row.version}</span>
              <span className="text-xs text-gray-500">{ENV_LABEL[row.environment] ?? row.environment}</span>
              <span className="text-xs text-gray-500">{row.provider}</span>
              <span className="text-xs text-gray-500">{row.service}</span>
              {row.commit ? <code className="text-xs text-gray-600">{row.commit.slice(0, 8)}</code> : <span className="text-xs text-gray-400">no commit</span>}
              <span className="text-xs">
                [{row.status} · {VERIFICATION_LABEL[row.verification] ?? row.verification}]
              </span>
              <span className="text-xs" data-testid={`deployment-health-${row.deploymentId}`}>health: {row.health}</span>
              <span className="text-xs" data-testid={`deployment-smoke-${row.deploymentId}`}>smoke: {row.smoke}</span>
              <span className="text-xs text-gray-500">
                {current?.deploymentId === row.deploymentId ? '◀ current' : ''}
              </span>
            </div>
            {row.rollbackAvailable ? (
              <div className="mt-2 flex items-center gap-3 text-xs">
                {isProd(row) && (
                  <label className="flex items-center gap-1">
                    <input
                      data-testid={`deployment-confirm-${row.deploymentId}`}
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    Confirm production rollback
                  </label>
                )}
                <button
                  data-testid={`deployment-rollback-${row.deploymentId}`}
                  className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                  disabled={busy || (isProd(row) && !confirmed)}
                  onClick={() => void doRollback(row)}
                >
                  {busy ? 'Rolling back…' : 'Roll back'}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </section>

      {lastRun && (
        <section data-testid="deployment-rollback-result" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">Last rollback</h3>
          <p>
            result: {lastRun.result} · provider capability: {lastRun.providerCapability} · db compat:{' '}
            {lastRun.databaseCompat}
          </p>
          {lastRun.reason && <p className="text-xs text-gray-700">{lastRun.reason}</p>}
          {Array.isArray(lastRun.safetyChecks) && lastRun.safetyChecks.length > 0 && (
            <ul className="mt-1 text-xs">
              {lastRun.safetyChecks.map((c) => (
                <li key={c.name} data-testid={`rollback-check-${c.name}`} className="text-gray-600">
                  <Icon name={c.ok ? 'check' : 'close'} size={13} /> {c.detail}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {error && <p data-testid="deployment-rollback-error" className="text-sm text-red-600">{error}</p>}
      {message && <p data-testid="deployment-message" className="text-sm text-gray-700">{message}</p>}
    </div>
  );
}
