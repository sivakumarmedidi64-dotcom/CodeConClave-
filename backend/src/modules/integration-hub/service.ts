/**
 * CodeConClave — PKG-26 — Universal Integration Hub (read-only surface).
 *
 * Consolidates the EXISTING integration substrate — the plugin hub
 * (`/api/v1/plugins`), deployment-provider abstraction (`/api/v1/release`),
 * inbound-webhook ingestion (`/api/v1/webhooks`), and observability — into ONE
 * coherent, read-only catalog with honest provider state. It does NOT add a
 * second engine, connection store, or automation pipeline: it reads the same
 * tables and functions the real engines already maintain and maps them to the
 * PKG-26 state vocabulary.
 *
 * Security invariants (verified by integration-hub.security.test.ts):
 *  - no token / secret / credential value is ever returned;
 *  - hub responses are owner-scoped (tenant isolation);
 *  - state is server-derived, never a client/UI claim.
 */
import { listAdapters } from '../plugins/sdk.js';
import {
  listConnections,
  pluginServerConfigured,
  classifyPluginIntegration,
  derivePluginHealthStatus,
  type PluginConnectionRow,
  type PluginType,
} from '../plugins/health.js';
import { env } from '../../config/env.js';
import { pool, withTenant, withSystem } from '../../shared/db.js';

export type HubState =
  | 'AVAILABLE'
  | 'CONNECTED'
  | 'AUTH_REQUIRED'
  | 'CONFIGURED'
  | 'UNCONFIGURED'
  | 'DISCONNECTED'
  | 'EXPIRED'
  | 'ERROR'
  | 'UNSUPPORTED'
  | 'ENVIRONMENT_BLOCKED';

export interface HubConnection {
  id: string;
  provider: string;
  state: string;
  scopes: string[];
  lastHealthCheckAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
}

export interface HubProvider {
  provider: string;
  name: string;
  category: string;
  kind: 'git' | 'communication' | 'issue_tracking' | 'observability' | 'deployment' | 'webhook' | 'knowledge' | 'design';
  state: HubState;
  integration: string;
  health: string;
  serverConfigured: boolean;
  adapterAvailable: boolean;
  connection: HubConnection | null;
  capabilities: string[];
  actions: Array<{ name: string; permission: string; scope: string; idempotent: boolean }>;
  oauthRequired: boolean;
}

const CATEGORY: Record<string, { category: string; kind: HubProvider['kind'] }> = {
  github: { category: 'Source Control', kind: 'git' },
  gitlab: { category: 'Source Control', kind: 'git' },
  slack: { category: 'Communication', kind: 'communication' },
  discord: { category: 'Communication', kind: 'communication' },
  teams: { category: 'Communication', kind: 'communication' },
  linear: { category: 'Issue Tracking', kind: 'issue_tracking' },
  jira: { category: 'Issue Tracking', kind: 'issue_tracking' },
  notion: { category: 'Knowledge', kind: 'knowledge' },
  figma: { category: 'Design', kind: 'design' },
  sentry: { category: 'Observability', kind: 'observability' },
  vercel: { category: 'Deployment', kind: 'deployment' },
  railway: { category: 'Deployment', kind: 'deployment' },
  render: { category: 'Deployment', kind: 'deployment' },
  cloudflare: { category: 'Deployment', kind: 'deployment' },
  webhook: { category: 'Webhook', kind: 'webhook' },
};

/**
 * Map an existing plugin connection state + adapter presence + server config
 * into the PKG-26 hub-state vocabulary (server-derived, honest).
 */
export function hubStateFor(
  connection: PluginConnectionRow | undefined,
  opts: { serverConfigured: boolean; adapterAvailable: boolean },
): HubState {
  if (!opts.adapterAvailable) return 'UNSUPPORTED';
  if (!connection) {
    return opts.serverConfigured ? 'AVAILABLE' : 'UNCONFIGURED';
  }
  switch (connection.state) {
    case 'CONNECTED': return 'CONNECTED';
    case 'DEGRADED': return 'ERROR';
    case 'REAUTH_REQUIRED': return 'AUTH_REQUIRED';
    case 'DISCONNECTED': return 'DISCONNECTED';
    case 'ERROR': return 'ERROR';
    case 'FAILED': return 'ERROR';
    case 'REVOKED': return 'DISCONNECTED';
    default: return 'CONFIGURED';
  }
}

/** Read-only hub provider view for one plugin/connector type. */
export async function hubProvider(
  userId: string,
  pluginType: string,
  connection: PluginConnectionRow | undefined,
): Promise<HubProvider> {
  const adapter = listAdapters().find((a) => a.id === pluginType);
  const adapterAvailable = !!adapter;
  const serverConfigured = pluginServerConfigured(pluginType);
  const integration = classifyPluginIntegration(pluginType, connection);
  const health = derivePluginHealthStatus(pluginType, connection?.state ?? 'DISCONNECTED', connection?.last_error ?? null);
  const cat = CATEGORY[pluginType] ?? { category: 'Integration', kind: 'webhook' as HubProvider['kind'] };

  let connectionView: HubConnection | null = null;
  if (connection) {
    const rows = await withSystem((q) => q.query(
      `SELECT
         (SELECT max(created_at)::text FROM plugin_events WHERE connection_id = $1) AS last_event_at
       FROM plugin_connections WHERE id = $1`,
      [connection.id],
    ));
    const lastEventAt = (rows.rows[0]?.last_event_at as string | null) ?? null;
    connectionView = {
      id: connection.id,
      provider: connection.plugin_type,
      state: connection.state,
      scopes: connection.scopes,
      lastHealthCheckAt: connection.last_health_check_at ? connection.last_health_check_at.toISOString() : null,
      lastError: connection.last_error,
      lastEventAt,
    };
  }

  const oauthRequired = adapter?.oauth?.required ?? false;

  return {
    provider: pluginType,
    name: adapter?.name ?? pluginType,
    category: cat.category,
    kind: cat.kind,
    state: hubStateFor(connection, { serverConfigured, adapterAvailable }),
    integration,
    health,
    serverConfigured,
    adapterAvailable,
    connection: connectionView,
    capabilities: adapter?.capabilities ?? [],
    actions: adapter?.actions.map((a) => ({ name: a.name, permission: a.permission, scope: a.scope, idempotent: a.idempotent })) ?? [],
    oauthRequired,
  };
}

/** The `modules/plugins` provider set — non-deployment connectors. */
export function pluginProviderTypes(): string[] {
  return ['github', 'slack', 'linear', 'discord', 'sentry', 'vercel', 'cloudflare', 'webhook'];
}

/**
 * Full read-only Integration Hub for one authenticated user.
 * Merges: plugin connectors + webhook sources + observability presence.
 * Deployment providers are exposed via `releaseProviderCapabilities`.
 */
export async function buildIntegrationHub(userId: string): Promise<{
  providers: HubProvider[];
  webhookSources: Array<{ source: string; count: number; enabled: number }>;
  observability: { sentryConfigured: boolean; metricsAvailable: boolean };
  live: 'ENVIRONMENT_BLOCKED';
}> {
  const connections = await listConnections(userId);
  const byType = new Map(connections.map((c) => [c.plugin_type, c]));

  // Webhook sources from the user's encrypted webhook_secrets (no secrets exposed).
  const whRows = await withTenant(userId, (q) => q.query(
    `SELECT source, count(*)::int AS count, count(*) FILTER (WHERE enabled)::int AS enabled
     FROM webhook_secrets WHERE owner_id = $1 GROUP BY source`,
    [userId],
  ));

  const providers: HubProvider[] = [];
  for (const t of pluginProviderTypes()) {
    providers.push(await hubProvider(userId, t, byType.get(t as PluginType)));
  }

  return {
    providers,
    webhookSources: whRows.rows.map((r) => ({
      source: String(r.source),
      count: Number(r.count ?? 0),
      enabled: Number(r.enabled ?? 0),
    })),
    observability: {
      sentryConfigured: Boolean(env.SENTRY_DSN && env.SENTRY_ENABLED !== 'false'),
      metricsAvailable: true,
    },
    live: 'ENVIRONMENT_BLOCKED',
  };
}

/**
 * Deployment-provider capability matrix (honest). Reuses the release provider
 * abstraction — adapter/config/credential existence is never treated as live.
 */
export async function deploymentProviderCapabilities(): Promise<
  Array<{ provider: string; state: string; supportsRollback: boolean; live: boolean; reason: string }>
> {
  const { listProviderCapabilities } = await import('../release/provider.js');
  const { kubernsStatus } = await import('../kuberns/adapter.js');
  const kuberns = kubernsStatus();
  // Map the Kuberns boundary state into the hub's fixed provider vocabulary;
  // the detailed DISABLED/CONFIGURATION_REQUIRED state stays on /kuberns/status.
  const kubernsHubState = kuberns.state === 'CONFIGURED' ? 'CONFIGURED' : 'UNCONFIGURED';
  return [
    ...listProviderCapabilities().map((c) => ({
      provider: c.provider,
      state: c.state,
      supportsRollback: c.supportsRollback,
      live: c.live,
      reason: c.reason,
    })),
    {
      provider: 'kuberns',
      state: kubernsHubState,
      supportsRollback: true,
      live: kuberns.live,
      reason: kuberns.reason,
    },
  ];
}
