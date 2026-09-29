/**
 * CodeConClave - ServiceNow adapter (user-supplied "instance:username:password").
 * Real ServiceNow Table API with HTTP Basic. Health via the sys_user table;
 * generic table reads are scoped to read-only.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const INSTANCE_RE = /^[a-z0-9-]{2,63}\.service-now\.com$/i;

interface SnAuth {
  instance: string;
  basic: string;
}

function snAuth(creds: PluginCredentials): SnAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [instance, user, pass] = parts;
  if (!instance || !user || !pass) return null;
  const host = `${instance}.service-now.com`;
  if (!INSTANCE_RE.test(host)) return null;
  return { instance, basic: Buffer.from(`${user}:${pass}`).toString('base64') };
}

async function snFetch(auth: SnAuth, table: string, limit: number): Promise<unknown> {
  const url = `https://${auth.instance}.service-now.com/api/now/table/${encodeURIComponent(table)}?sysparm_limit=${limit}&sysparm_exclude_reference_link=true`;
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth.basic}`, Accept: 'application/json' },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('servicenow_unauthorized', 'ServiceNow rejected the instance / username / password combination');
  }
  if (response.status === 404) throw AppError.notFound('servicenow_instance_not_found', `No ServiceNow instance at ${auth.instance}.service-now.com`);
  if (!response.ok) throw AppError.unavailable('servicenow_api_rejected', `ServiceNow API failed (${response.status})`);
  return response.json();
}

export const servicenowAdapter: PluginAdapter = {
  id: 'servicenow',
  name: 'ServiceNow',
  provider: 'service-now.com',
  version: '1.0.0',
  capabilities: [PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'users.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Users visible to the account (sys_user table).',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
    },
    {
      name: 'incidents.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Incidents visible to the account (incident table).',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!snAuth(creds)) {
      throw AppError.badRequest('servicenow_auth_invalid', 'ServiceNow connection requires an "instance:username:password" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = snAuth(creds);
    if (!auth) throw AppError.badRequest('servicenow_auth_invalid', 'ServiceNow connection requires an "instance:username:password" credential');
    try {
      const payload = (await snFetch(auth, 'sys_user', 1)) as { result?: unknown[] };
      if (!Array.isArray(payload?.result)) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: auth.instance };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'servicenow_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = snAuth(creds);
    if (!auth) throw AppError.badRequest('servicenow_auth_invalid', 'ServiceNow connection requires an "instance:username:password" credential');
    switch (action.name) {
      case 'users.list':
        return { ok: true, data: await snFetch(auth, 'sys_user', Number(input.limit ?? 25)), latencyMs: Date.now() - start };
      case 'incidents.list':
        return { ok: true, data: await snFetch(auth, 'incident', Number(input.limit ?? 25)), latencyMs: Date.now() - start };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown ServiceNow action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};