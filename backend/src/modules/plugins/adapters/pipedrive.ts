/**
 * CodeConClave - Pipedrive adapter (user-supplied API token).
 * Real Pipedrive REST v1. Health via users/me with api_token query param;
 * deals/persons/pipelines reads. Read-only by design.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginPermission } from '@codeconclave/shared';

const PIPE_API = 'https://api.pipedrive.com/v1';

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function pdFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${PIPE_API}${path}?api_token=${encodeURIComponent(token)}`, {
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('pipedrive_unauthorized', 'Pipedrive rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('pipedrive_api_rejected', `Pipedrive API failed (${response.status})`);
  return response.json();
}

const listSchema = { limit: z.coerce.number().int().min(1).max(100).default(20) };

export const pipedriveAdapter: PluginAdapter = {
  id: 'pipedrive',
  name: 'Pipedrive',
  provider: 'pipedrive.com',
  version: '1.0.0',
  capabilities: [],
  oauth: null,
  actions: [
    {
      name: 'users.me',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'The Pipedrive user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'deals.list',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'Open deals, by value.',
      inputSchema: z.object(listSchema),
    },
    {
      name: 'persons.list',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'People in the CRM.',
      inputSchema: z.object(listSchema),
    },
    {
      name: 'pipelines.list',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'Active pipelines.',
      inputSchema: z.object(listSchema),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('pipedrive_token_missing', 'Pipedrive connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('pipedrive_token_missing', 'Pipedrive connection requires a token credential');
    try {
      const payload = (await pdFetch(token, '/users/me')) as { data?: { id?: number } };
      if (!payload?.data?.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'pipedrive_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('pipedrive_token_missing', 'Pipedrive connection requires a token credential');
    switch (action.name) {
      case 'users.me':
        return { ok: true, data: await pdFetch(token, '/users/me'), latencyMs: Date.now() - start };
      case 'deals.list':
        return { ok: true, data: await pdFetch(token, `/deals?limit=${Number(input.limit ?? 20)}`), latencyMs: Date.now() - start };
      case 'persons.list':
        return { ok: true, data: await pdFetch(token, `/persons?limit=${Number(input.limit ?? 20)}`), latencyMs: Date.now() - start };
      case 'pipelines.list':
        return { ok: true, data: await pdFetch(token, `/pipelines?limit=${Number(input.limit ?? 20)}`), latencyMs: Date.now() - start };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Pipedrive action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};