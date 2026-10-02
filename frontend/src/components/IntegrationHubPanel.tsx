/**
 * CodeConClave — PKG-26 — Universal Integration Hub panel.
 * Renders the read-only /api/v1/integrations/hub catalog: providers (plugin
 * connectors), deployment-provider capability matrix, webhook sources and
 * observability. Honest server-derived states only — nothing here fakes a
 * live connection, token, or webhook.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

export interface HubProvider {
  provider: string;
  name: string;
  category: string;
  kind: string;
  state: string;
  integration: string;
  health: string;
  serverConfigured: boolean;
  adapterAvailable: boolean;
  connection: { id: string; state: string; scopes: string[]; lastHealthCheckAt: string | null; lastError: string | null; lastEventAt: string | null } | null;
  capabilities: string[];
  actions: Array<{ name: string; permission: string; scope: string; idempotent: boolean }>;
  oauthRequired: boolean;
}

export interface DeploymentCapability {
  provider: string;
  state: string;
  supportsRollback: boolean;
  live: boolean;
  reason: string;
}

export interface HubData {
  providers: HubProvider[];
  deploymentProviders: DeploymentCapability[];
  webhookSources: Array<{ source: string; count: number; enabled: number }>;
  observability: { sentryConfigured: boolean; metricsAvailable: boolean };
  live: 'ENVIRONMENT_BLOCKED';
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

const STATE_BADGE: Record<string, string> = {
  CONNECTED: 'bg-green-100 text-green-800',
  AVAILABLE: 'bg-green-100 text-green-800',
  CONFIGURED: 'bg-sky-100 text-sky-800',
  AUTH_REQUIRED: 'bg-amber-100 text-amber-800',
  ENVIRONMENT_BLOCKED: 'bg-amber-100 text-amber-800',
  DISCONNECTED: 'bg-gray-200 text-gray-700',
  UNCONFIGURED: 'bg-gray-100 text-gray-600',
  UNSUPPORTED: 'bg-gray-100 text-gray-600',
  ERROR: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-red-100 text-red-800',
};

export function IntegrationHubPanel() {
  const [hub, setHub] = useState<HubData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const res = await api<{ providers: HubProvider[]; deploymentProviders: DeploymentCapability[]; webhookSources: HubData['webhookSources']; observability: HubData['observability']; live: HubData['live'] }>('/api/v1/integrations/hub');
      setHub({
        providers: res.providers,
        deploymentProviders: res.deploymentProviders,
        webhookSources: res.webhookSources,
        observability: res.observability,
        live: res.live,
      });
      setState('ready');
    } catch (e) {
      setState('error');
      setError(message(e, 'Integration hub unavailable'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const badge = (s: string) => STATE_BADGE[s] ?? 'bg-gray-100 text-gray-700';

  return (
    <div data-testid="integration-hub-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Universal Integration Hub</h2>

      {state === 'loading' && <p data-testid="hub-loading">Loading integration hub…</p>}
      {state === 'error' && <p data-testid="hub-error" className="text-sm text-red-600">{error ?? 'Integration hub unavailable'}</p>}

      {state === 'ready' && hub && (
        <>
          <section className="rounded border p-3 text-xs text-gray-500">
            <p data-testid="hub-live">
              Live provider status: <span className="font-medium">{hub.live}</span> — no external network, OAuth or webhook
              delivery is performed in this environment. All states below are server-derived and honest.
            </p>
          </section>

          <section className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">Observed providers ({hub.providers.length})</h3>
            <ul data-testid="hub-providers" className="mt-2 space-y-1">
              {hub.providers.map((p) => (
                <li key={p.provider} className="flex flex-wrap items-center gap-2" data-testid={`hub-provider-${p.provider}`}>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge(p.state)}`} data-testid={`hub-state-${p.provider}`}>
                    {p.state}
                  </span>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-gray-500">{p.category}</span>
                  {p.connection && (
                    <span className="text-xs text-gray-500" data-testid={`hub-scopes-${p.provider}`}>
                      scopes: {p.connection.scopes.length}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">Deployment providers</h3>
            <ul data-testid="hub-deployment" className="mt-2 space-y-1">
              {hub.deploymentProviders.map((d) => (
                <li key={d.provider} className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge(d.state)}`} data-testid={`hub-dep-state-${d.provider}`}>
                    {d.state}
                  </span>
                  <span className="font-medium">{d.provider}</span>
                  <span className="text-xs text-gray-500">{d.live ? 'live' : d.reason}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">Inbound webhook sources</h3>
            {hub.webhookSources.length === 0 ? (
              <p data-testid="hub-webhooks-empty" className="mt-1 text-xs text-gray-500">No webhook secrets configured.</p>
            ) : (
              <ul data-testid="hub-webhooks" className="mt-2 space-y-1">
                {hub.webhookSources.map((w) => (
                  <li key={w.source} className="flex items-center gap-2">
                    <span className="font-medium">{w.source}</span>
                    <span className="text-xs text-gray-500" data-testid={`hub-webhook-${w.source}`}>
                      {w.count} secret(s), {w.enabled} enabled
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded border p-3 text-xs text-gray-500">
            <p data-testid="hub-observability">
              Observability: Sentry {hub.observability.sentryConfigured ? 'configured' : 'not configured (ENVIRONMENT_BLOCKED)'} · metrics available
            </p>
          </section>
        </>
      )}
    </div>
  );
}
