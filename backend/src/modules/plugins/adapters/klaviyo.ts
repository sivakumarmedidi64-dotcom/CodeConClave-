/**
 * CodeConClave - Klaviyo adapter (user-supplied private API key).
 * Real Klaviyo legacy v1 API (a.klaviyo.com/api/v1). Health via lists; lists
 * and campaigns reads. Read-only by design.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const KLAVIYO_API = 'https://a.klaviyo.com/api/v1';

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function kvFetch(key: string, path: string): Promise<unknown> {
  const response = await fetch(`${KLAVIYO_API}${path}?api_key=${encodeURIComponent(key)}`, {
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('klaviyo_unauthorized', 'Klaviyo rejected the API key');
  }
  if (!response.ok) throw AppError.unavailable('klaviyo_api_rejected', `Klaviyo API failed (${response.status})`);
  return response.json();
}

export const klaviyoAdapter: PluginAdapter = {
  id: 'klaviyo',
  name: 'Klaviyo',
  provider: 'klaviyo.com',
  version: '1.0.0',
  capabilities: [PluginCapability.EMAIL],
  oauth: null,
  actions: [
    {
      name: 'lists.list',
      permission: PluginPermission.READ,
      scope: 'email:read',
      idempotent: true,
      description: 'Lists in the account.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
    {
      name: 'campaigns.list',
      permission: PluginPermission.READ,
      scope: 'email:read',
      idempotent: true,
      description: 'Recent campaigns.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('klaviyo_key_missing', 'Klaviyo connection requires an API key credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const key = tokenFor(creds);
    if (!key) throw AppError.badRequest('klaviyo_key_missing', 'Klaviyo connection requires an API key credential');
    try {
      const payload = (await kvFetch(key, '/lists')) as { object?: string };
      if (payload?.object !== 'list') return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'klaviyo_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const key = tokenFor(creds);
    if (!key) throw AppError.badRequest('klaviyo_key_missing', 'Klaviyo connection requires an API key credential');
    switch (action.name) {
      case 'lists.list':
        return { ok: true, data: await kvFetch(key, `/lists?limit=${Number(input.limit ?? 20)}`), latencyMs: Date.now() - start };
      case 'campaigns.list':
        return { ok: true, data: await kvFetch(key, `/campaigns?limit=${Number(input.limit ?? 20)}`), latencyMs: Date.now() - start };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Klaviyo action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};