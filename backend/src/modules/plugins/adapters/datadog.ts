/**
 * CodeConClave - Datadog adapter (user-supplied api-key:app-key pair).
 * Real Datadog REST (v1/v2). Health via /api/v2/users/me with the
 * Datadog API/application tokens as headers; users + monitor reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const DATADOG_API = 'https://api.datadoghq.com';

interface DdAuth {
  apiKey: string;
  appKey: string;
}

function ddAuth(creds: PluginCredentials): DdAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const apiKey = raw.slice(0, sep);
  const appKey = raw.slice(sep + 1);
  if (!apiKey || !appKey) return null;
  return { apiKey, appKey };
}

async function ddFetch(auth: DdAuth, path: string): Promise<unknown> {
  const response = await fetch(`${DATADOG_API}${path}`, {
    headers: { 'DD-API-KEY': auth.apiKey, 'DD-APPLICATION-KEY': auth.appKey, Accept: 'application/json' },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('datadog_unauthorized', 'Datadog rejected the API key / application key pair');
  }
  if (!response.ok) throw AppError.unavailable('datadog_api_rejected', `Datadog API failed (${response.status})`);
  return response.json();
}

export const datadogAdapter: PluginAdapter = {
  id: 'datadog',
  name: 'Datadog',
  provider: 'datadoghq.com',
  version: '1.0.0',
  capabilities: [PluginCapability.OBSERVABILITY, PluginCapability.MONITORING],
  oauth: null,
  actions: [
    {
      name: 'users.me',
      permission: PluginPermission.READ,
      scope: 'observability:read',
      idempotent: true,
      description: 'The Datadog user the application key belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'monitors.list',
      permission: PluginPermission.READ,
      scope: 'monitoring:read',
      idempotent: true,
      description: 'Monitors visible to the application key (v1).',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!ddAuth(creds)) {
throw AppError.badRequest('datadog_auth_invalid', 'Datadog connection requires the api-key:app-key credential pair');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = ddAuth(creds);
    if (!auth) throw AppError.badRequest('datadog_auth_invalid', 'Datadog connection requires the api-key:app-key credential pair');
    try {
      const payload = (await ddFetch(auth, '/api/v2/users/me')) as { data?: { attributes?: { name?: string } } };
      if (!payload?.data) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.data.attributes?.name ?? 'datadog_user' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'datadog_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = ddAuth(creds);
    if (!auth) throw AppError.badRequest('datadog_auth_invalid', 'Datadog connection requires the api-key:app-key credential pair');
    switch (action.name) {
      case 'users.me':
        return { ok: true, data: await ddFetch(auth, '/api/v2/users/me'), latencyMs: Date.now() - start };
      case 'monitors.list':
        return { ok: true, data: await ddFetch(auth, `/api/v1/monitor?limit=${Number(input.limit ?? 25)}`), latencyMs: Date.now() - start };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Datadog action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};