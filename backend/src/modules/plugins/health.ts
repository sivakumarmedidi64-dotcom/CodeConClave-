/**
 * CodeConClave — plugins module (health + catalog + lifecycle).
 * plugin_connections have health sweeps: stale heartbeats mark ERROR with a
 * recorded last_error; users see honest states (DISCONNECTED/CONNECTING/
 * CONNECTED/DEGRADED/FAILED/REAUTH_REQUIRED/ERROR/REVOKED). Connections only
 * flip to CONNECTED after a real handshake (OAuth/API verify) — never by UI
 * claim. Phase 10 adds disconnect/reauthorize, scope management, events
 * listing and the plugin_health ledger with degradation/failure/recovery
 * transitions + notifications.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import {
  AuditAction,
  NotificationType,
  PluginPermission,
  type PluginPermission as PluginPermissionType,
  type PluginIntegrationStatus,
} from '@codeconclave/shared';
import { env } from '../../config/env.js';
import { revokePluginCredentials } from './credentials.js';

const PLUGIN_TYPES = [
  'github', 'google', 'resend', 'slack', 'teams', 'discord', 'notion', 'linear',
  'jira', 'figma', 'sentry', 'cloudflare', 'supabase', 'vercel', 'render', 'vscode', 'webhook',
  'stripe', 'twilio', 'pagerduty', 'asana',
  'gitlab', 'hubspot', 'pipedrive', 'clickup', 'monday', 'coda', 'trello', 'klaviyo', 'databricks', 'zendesk',
  'datadog', 'mailgun', 'confluence', 'servicenow',
] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];

/** Adapters genuinely implemented in this deployment (honest marketplace capability). */
export const ADAPTER_IDS = [
  'github', 'google', 'resend', 'slack', 'linear', 'discord', 'sentry', 'vercel', 'cloudflare', 'webhook',
  'notion', 'stripe', 'twilio', 'pagerduty', 'asana',
  'gitlab', 'hubspot', 'pipedrive', 'clickup', 'monday', 'coda', 'trello', 'klaviyo', 'databricks', 'zendesk',
  'datadog', 'mailgun', 'confluence', 'servicenow', 'jira', 'supabase', 'render',
] as const;

export interface PluginConnectionRow {
  id: string;
  owner_id: string;
  plugin_type: PluginType;
  name: string;
  state: string;
  scopes: string[];
  credential_ref: string | null;
  last_health_check_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PluginCatalogueRow {
  plugin_type: PluginType;
  name: string;
  description: string | null;
  capabilities: unknown[];
  enabled: boolean;
  category: string | null;
  popular: boolean;
  required_permissions: unknown[];
}

export interface PluginScopeRow {
  id: string;
  connection_id: string;
  scope: string;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export interface PluginEventRow {
  id: string;
  connection_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  state: string;
  created_at: Date;
}

export interface PluginHealthRow {
  id: string;
  connection_id: string;
  checked_at: Date;
  ok: boolean;
  latency_ms: number;
  consecutive_failures: number;
  last_error: string | null;
  detail: Record<string, unknown> | null;
}

export async function listCatalogue(): Promise<PluginCatalogueRow[]> {
  return withSystem<PluginCatalogueRow[]>((db) => db.query<PluginCatalogueRow>('SELECT * FROM plugins WHERE enabled = true ORDER BY name').then((r) => r.rows));
}

/**
 * Marketplace search (Stage 25.5). Instant fuzzy match over name/description/
 * category/capability/provider plus deterministic filters. Each result carries
 * the user's connection state and a server-derived health status — the UI
 * never infers health on its own.
 */
export async function searchCatalogue(
  userId: string,
  params: { q?: string; category?: string; capability?: string; state?: string; status?: string; integration?: string; popular?: string; limit?: number },
): Promise<PluginCatalogueRow[]> {
  const rows = await listCatalogue();
  const connections = await listConnections(userId);
  const byType = new Map(connections.map((c) => [c.plugin_type, c]));

  let out = rows.map((row) => {
    const connection = byType.get(row.plugin_type as PluginType);
    const state = connection?.state ?? 'DISCONNECTED';
    const status = derivePluginHealthStatus(row.plugin_type as string, state, connection?.last_error ?? null);
    return {
      ...row,
      state,
      status,
      adapterAvailable: ADAPTER_IDS.includes(row.plugin_type as never),
      serverConfigured: pluginServerConfigured(row.plugin_type as string),
      integration: classifyPluginIntegration(row.plugin_type as string, connection),
    };
  });

  if (params.q) {
    const q = params.q.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    out = out.filter((row) => {
      const haystack = [
        row.name,
        row.description ?? '',
        String(row.category ?? ''),
        String(row.plugin_type),
        ...((row.capabilities as string[]) ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }
  if (params.category) out = out.filter((row) => row.category === params.category);
  if (params.capability) out = out.filter((row) => (row.capabilities as string[]).includes(params.capability ?? ''));
  if (params.state) out = out.filter((row) => row.state === params.state);
  if (params.status) out = out.filter((row) => row.status === params.status);
  if (params.integration) out = out.filter((row) => row.integration === params.integration);
  if (params.popular === 'true') out = out.filter((row) => row.popular);
  return out.slice(0, Math.min(100, Math.max(1, params.limit ?? 50)));
}

/**
 * Server-derived health status (Stage 25.5):
 *  - no adapter implemented     → NOT_CONFIGURED
 *  - no connection              → NOT_CONNECTED
 *  - REAUTH_REQUIRED state      → REAUTH_REQUIRED
 *  - ERROR/FAILED/REVOKED       → UNAVAILABLE
 *  - DEGRADED                   → DEGRADED
 *  - CONNECTED                  → HEALTHY
 *  - anything else              → NOT_CONNECTED
 */
export function derivePluginHealthStatus(pluginType: string, state: string, lastError: string | null): import('@codeconclave/shared').PluginHealthStatus {
  if (!ADAPTER_IDS.includes(pluginType as never)) return 'NOT_CONFIGURED';
  if (state === 'DISCONNECTED' || state === 'CONNECTING') return 'NOT_CONNECTED';
  if (state === 'REAUTH_REQUIRED') return 'REAUTH_REQUIRED';
  if (state === 'DEGRADED') return 'DEGRADED';
  if (state === 'CONNECTED') return 'HEALTHY';
  if (state === 'ERROR' || state === 'FAILED' || state === 'REVOKED') return lastError ? 'UNAVAILABLE' : 'UNAVAILABLE';
  return 'NOT_CONNECTED';
}

/**
 * Server-side integration classification (Stage 25.5). Deterministic and
 * honest: a connector is only LIVE when a real connection is usable right
 * now; BLOCKED when a connection exists but is unusable; CONFIGURED when the
 * adapter exists and this deployment can connect (server credentials present
 * or a user-supplied token path); NOT_CONFIGURED when required server config
 * is missing; UNSUPPORTED when no adapter is registered in this build.
 */
export function pluginServerConfigured(pluginType: string): boolean {
  switch (pluginType) {
    case 'github':
      return Boolean(env.GITHUB_APP_ID || env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_SECRET);
    case 'google':
      return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    case 'resend':
      return Boolean(env.RESEND_API_KEY);
    case 'webhook':
      return Boolean(env.PLUGIN_WEBHOOK_ALLOWED_HOSTS);
    case 'slack':
    case 'linear':
    case 'discord':
    case 'sentry':
    case 'vercel':
    case 'cloudflare':
    case 'notion':
    case 'stripe':
    case 'twilio':
    case 'pagerduty':
    case 'asana':
    case 'gitlab':
    case 'hubspot':
    case 'pipedrive':
    case 'clickup':
    case 'monday':
    case 'coda':
    case 'trello':
    case 'klaviyo':
    case 'databricks':
    case 'zendesk':
    case 'datadog':
    case 'mailgun':
    case 'confluence':
    case 'servicenow':
    case 'jira':
    case 'supabase':
    case 'render':
      // Per-connection credential path only: connect with a user-supplied token.
      return true;
    default:
      return false;
  }
}

export function classifyPluginIntegration(
  pluginType: string,
  connection: PluginConnectionRow | undefined,
): PluginIntegrationStatus {
  if (!ADAPTER_IDS.includes(pluginType as never)) return 'UNSUPPORTED';
  if (connection) {
    if (connection.state === 'CONNECTED' || connection.state === 'DEGRADED') return 'LIVE';
    if (connection.state === 'FAILED' || connection.state === 'ERROR' || connection.state === 'REVOKED' || connection.state === 'REAUTH_REQUIRED') {
      return 'BLOCKED';
    }
  }
  return pluginServerConfigured(pluginType) ? 'CONFIGURED' : 'NOT_CONFIGURED';
}

export async function listConnections(userId: string): Promise<PluginConnectionRow[]> {
  return withTenant<PluginConnectionRow[]>(userId, (db) =>
    db.query<PluginConnectionRow>('SELECT * FROM plugin_connections WHERE owner_id = $1 ORDER BY updated_at DESC', [userId]).then((r) => r.rows),
  );
}

export async function connectPlugin(
  userId: string,
  pluginType: PluginType,
  name: string,
  credentialRef?: string,
): Promise<PluginConnectionRow> {
  if (!PLUGIN_TYPES.includes(pluginType)) throw AppError.badRequest('invalid_plugin_type', 'Unknown plugin type');
  const exists = await withTenant<PluginConnectionRow[]>(userId, (db) =>
    db
      .query<PluginConnectionRow>('SELECT * FROM plugin_connections WHERE owner_id = $1 AND plugin_type = $2', [userId, pluginType])
      .then((r) => r.rows),
  );
  if (exists[0]) throw AppError.conflict('plugin_connected', 'A connection for this plugin already exists');

  const state: string = credentialRef ? 'CONNECTED' : 'CONNECTING';
  const id = newId(PREFIX.PLUGIN);
  await withTenant(userId, (db) =>
    db.query(
      `INSERT INTO plugin_connections (id, owner_id, plugin_type, name, state, credential_ref)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, userId, pluginType, name, state, credentialRef ?? null],
    ),
  );
  const row = (await withTenant<PluginConnectionRow[]>(userId, (db) =>
    db.query<PluginConnectionRow>('SELECT * FROM plugin_connections WHERE id = $1', [id]).then((r) => r.rows),
  ))[0]!;
  await recordAudit({
    action: AuditAction.PLUGIN_CONNECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_connection',
    resourceId: id,
    detail: { pluginType, name: row.name },
  });
  return row;
}

export async function revokePlugin(userId: string, connectionId: string): Promise<void> {
  const row = await getConnection(userId, connectionId);
  await withTenant(userId, (db) => db.query(`UPDATE plugin_connections SET state = 'REVOKED', credential_ref = NULL WHERE id = $1`, [connectionId]));
  await revokePluginCredentials(userId, connectionId);
  await withTenant(userId, (db) => db.query(`UPDATE plugin_scopes SET revoked_at = now() WHERE connection_id = $1 AND revoked_at IS NULL`, [connectionId]));
  await recordAudit({
    action: AuditAction.PLUGIN_REVOKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_connection',
    resourceId: connectionId,
    detail: { pluginType: row.plugin_type, name: row.name },
  });
}

export async function getConnection(userId: string, connectionId: string): Promise<PluginConnectionRow> {
  const rows = await withTenant<PluginConnectionRow[]>(userId, (db) =>
    db
      .query<PluginConnectionRow>('SELECT * FROM plugin_connections WHERE id = $1 AND owner_id = $2', [connectionId, userId])
      .then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Plugin connection');
  return rows[0];
}

export async function getConnectionInternal(connectionId: string): Promise<PluginConnectionRow | null> {
  const rows = await withSystem<PluginConnectionRow[]>((db) =>
    db.query<PluginConnectionRow>('SELECT * FROM plugin_connections WHERE id = $1', [connectionId]).then((r) => r.rows),
  );
  return rows[0] ?? null;
}

export async function setConnectionState(connectionId: string, state: string, lastError?: string): Promise<void> {
  await withSystem((db) =>
    db.query(
      `UPDATE plugin_connections SET state = $2, last_error = $3, last_health_check_at = now() WHERE id = $1`,
      [connectionId, state, lastError ?? null],
    ),
  );
}

export async function recordPluginEvent(connectionId: string, eventType: string, payload: Record<string, unknown>, state = 'RECEIVED'): Promise<void> {
  await withSystem((db) =>
    db.query(
      `INSERT INTO plugin_events (id, connection_id, event_type, payload, state) VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [newId(PREFIX.PLUGIN), connectionId, eventType, JSON.stringify(payload), state],
    ),
  );
}

/** State transition with owner notification (degraded/failed/reauth/recovered). */
export async function transitionConnectionState(
  connectionId: string,
  to: string,
  opts: { lastError?: string | null; actorUserId?: string; notifyOwner?: boolean } = {},
): Promise<void> {
  await setConnectionState(connectionId, to, opts.lastError ?? undefined);
  const row = await getConnectionInternal(connectionId);
  if (!row) return;
  await recordPluginEvent(connectionId, 'connection.state', { from: null, to, error: opts.lastError ?? null }, 'RECORDED');
  if (opts.actorUserId) {
    await recordAudit({
      action: AuditAction.PLUGIN_HEALTH_CHANGED,
      actorUserId: opts.actorUserId,
      scope: 'USER',
      tenantId: row.owner_id,
      resourceType: 'plugin_connection',
      resourceId: connectionId,
      detail: { state: to, error: opts.lastError ?? null },
    });
  }
  if (opts.notifyOwner !== false) {
    const notification: { type: (typeof NotificationType)[keyof typeof NotificationType]; title: string; body?: string } | null =
      to === 'DEGRADED'
        ? { type: NotificationType.PLUGIN_DEGRADED, title: 'Plugin degraded', body: `${row.name} is degrading due to repeated failures.` }
        : to === 'FAILED'
          ? { type: NotificationType.PLUGIN_FAILED, title: 'Plugin failed', body: `${row.name} stopped working. Reconnect or reauthorize it.` }
          : to === 'REAUTH_REQUIRED'
            ? { type: NotificationType.PLUGIN_REAUTH_REQUIRED, title: 'Plugin reauthorization required', body: `${row.name} needs reauthorization to keep working.` }
            : to === 'CONNECTED'
              ? { type: NotificationType.PLUGIN_RECOVERED, title: 'Plugin recovered', body: `${row.name} is healthy again.` }
              : null;
    if (notification) {
      await notify(row.owner_id, notification.type, notification.title, {
        body: notification.body,
        resourceType: 'plugin_connection',
        resourceId: connectionId,
        metadata: { pluginType: row.plugin_type, state: to },
      }).catch(() => undefined);
    }
  }
}

/** Disconnect (soft): keeps credentials so reconnect works; differs from revoke. */
export async function disconnectPlugin(userId: string, connectionId: string): Promise<PluginConnectionRow> {
  const row = await getConnection(userId, connectionId);
  if (row.state === 'REVOKED') throw AppError.conflict('plugin_revoked', 'A revoked plugin cannot be disconnected');
  await transitionConnectionState(connectionId, 'DISCONNECTED', { actorUserId: userId });
  await recordAudit({
    action: AuditAction.PLUGIN_DISCONNECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_connection',
    resourceId: connectionId,
    detail: { pluginType: row.plugin_type },
  });
  return (await getConnection(userId, connectionId)) as PluginConnectionRow;
}

/** Reauthorize: OAuth adapters return the authorize URL; token adapters verify stored credentials. */
export async function reauthorizePlugin(
  userId: string,
  connectionId: string,
  authUrlFor?: (state: string) => string,
): Promise<{ authUrl?: string }> {
  const row = await getConnection(userId, connectionId);
  if (row.state === 'REVOKED') throw AppError.conflict('plugin_revoked', 'A revoked plugin cannot be reauthorized');
  if (authUrlFor) {
    await transitionConnectionState(connectionId, 'REAUTH_REQUIRED', { actorUserId: userId });
    const authUrl = authUrlFor(pluginOAuthState(userId, connectionId));
    return { authUrl };
  }
  await transitionConnectionState(connectionId, 'CONNECTING', { actorUserId: userId });
  await recordAudit({
    action: AuditAction.PLUGIN_REAUTHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_connection',
    resourceId: connectionId,
    detail: { pluginType: row.plugin_type },
  });
  return {};
}

/** Server-authoritative scope update: replaces active grants, audited. */
export async function updateConnectionScopes(userId: string, connectionId: string, scopes: string[]): Promise<string[]> {
  const row = await getConnection(userId, connectionId);
  if (row.state === 'REVOKED') throw AppError.conflict('plugin_revoked', 'A revoked plugin has no scopes');
  const canonical = [...new Set(scopes.map((s) => s.trim()).filter(Boolean))] as PluginPermissionType[];
  const valid = Object.values(PluginPermission) as string[];
  for (const s of canonical) {
    if (!valid.includes(s)) throw AppError.badRequest('invalid_plugin_scope', `Unknown plugin scope: ${s}`);
  }
  await withTenant(userId, (db) =>
    db.query(
      `UPDATE plugin_scopes SET revoked_at = now() WHERE connection_id = $1 AND revoked_at IS NULL`,
      [connectionId],
    ),
  );
  for (const scope of canonical) {
    await withTenant(userId, (db) =>
      db.query(
        `INSERT INTO plugin_scopes (id, connection_id, scope, granted_at) VALUES ($1,$2,$3,now())`,
        [newId(PREFIX.PLUGIN + '_scope'), connectionId, scope],
      ),
    );
  }
  await withTenant(userId, (db) =>
    db.query(`UPDATE plugin_connections SET scopes = $2::jsonb, updated_at = now() WHERE id = $1`, [
      connectionId,
      JSON.stringify(canonical),
    ]),
  );
  await recordAudit({
    action: AuditAction.PLUGIN_SCOPE_CHANGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_connection',
    resourceId: connectionId,
    detail: { scopes: canonical },
  });
  return canonical;
}

/** Active (non-revoked, non-expired) scope rows for a connection. */
export async function listPluginScopes(connectionId: string): Promise<PluginScopeRow[]> {
  return withSystem<PluginScopeRow[]>((db) =>
    db
      .query<PluginScopeRow>(
        `SELECT * FROM plugin_scopes WHERE connection_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY granted_at`,
        [connectionId],
      )
      .then((r) => r.rows),
  );
}

/** Effective permission set for a connection: granted scopes + connection.scopes. */
export async function effectivePluginScopes(connectionId: string): Promise<Set<string>> {
  const rows = await listPluginScopes(connectionId);
  const effective = new Set<string>();
  for (const r of rows) effective.add(r.scope);
  return effective;
}

export async function listPluginEvents(userId: string, connectionId: string, limit = 50): Promise<PluginEventRow[]> {
  await getConnection(userId, connectionId);
  return withTenant<PluginEventRow[]>(userId, (db) =>
    db
      .query<PluginEventRow>(
        `SELECT * FROM plugin_events WHERE connection_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [connectionId, Math.min(200, Math.max(1, limit))],
      )
      .then((r) => r.rows),
  );
}

/** Append-only health ledger; called after every check or action outcome. */
export async function recordPluginHealth(
  connectionId: string,
  ok: boolean,
  latencyMs: number,
  consecutiveFailures: number,
  lastError?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await withSystem((db) =>
    db.query(
      `INSERT INTO plugin_health (id, connection_id, checked_at, ok, latency_ms, consecutive_failures, last_error, detail)
       VALUES ($1,$2,now(),$3,$4,$5,$6,$7::jsonb)`,
      [newId(PREFIX.PLUGIN + '_health'), connectionId, ok, Math.max(0, Math.round(latencyMs)), consecutiveFailures, lastError ?? null, JSON.stringify(detail ?? {})],
    ),
  );
}

// ---------------------------------------------------------------- oauth state

export function pluginOAuthState(userId: string, connectionId: string): string {
  return `plg:${userId}:${connectionId}`;
}

export function parsePluginOAuthState(state: string): { userId: string; connectionId: string } {
  const parts = state.split(':');
  if (parts.length !== 3 || parts[0] !== 'plg') throw AppError.badRequest('plugin_oauth_state_invalid', 'Invalid plugin OAuth state');
  return { userId: parts[1]!, connectionId: parts[2]! };
}

/** Watchdog: connections whose health check is stale (>10 min) → ERROR (honest). */
export async function sweepPluginHealth(): Promise<number> {
  const result = await withSystem((db) =>
    db.query(
      `UPDATE plugin_connections SET state = 'ERROR', last_error = 'health_check_timeout', last_health_check_at = now()
        WHERE state IN ('CONNECTING','CONNECTED','DEGRADED','REAUTH_REQUIRED')
          AND last_health_check_at < now() - interval '10 minutes'
        RETURNING id`,
    ),
  );
  return result.rowCount ?? 0;
}