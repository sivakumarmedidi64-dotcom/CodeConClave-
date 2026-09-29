/**
 * CodeConClave - HubSpot adapter (user-supplied private app token).
 * Real HubSpot CRM v3 API. Health via contacts:list; contacts/companies/deals
 * reads. Read-only by design.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginPermission } from '@codeconclave/shared';

const HUBSPOT_API = 'https://api.hubapi.com/crm/v3/objects';
const ID_MAX = 64;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function hsFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${HUBSPOT_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('hubspot_unauthorized', 'HubSpot rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('hubspot_api_rejected', `HubSpot API failed (${response.status})`);
  return response.json();
}

export const hubspotAdapter: PluginAdapter = {
  id: 'hubspot',
  name: 'HubSpot',
  provider: 'hubspot.com',
  version: '1.0.0',
  capabilities: [],
  oauth: null,
  actions: [
    {
      name: 'contacts.list',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'Contacts, most recently updated first.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
      }),
    },
    {
      name: 'contact.get',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'One contact by id.',
      inputSchema: z.object({ id: z.string().min(1).max(ID_MAX) }),
    },
    {
      name: 'companies.list',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'Companies, most recently updated first.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
      }),
    },
    {
      name: 'deals.list',
      permission: PluginPermission.READ,
      scope: 'crm:read',
      idempotent: true,
      description: 'Deals, most recently updated first.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('hubspot_token_missing', 'HubSpot connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('hubspot_token_missing', 'HubSpot connection requires a token credential');
    try {
      const payload = (await hsFetch(token, '/contacts?limit=1')) as { results?: unknown[] };
      if (!Array.isArray(payload?.results)) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'hubspot_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('hubspot_token_missing', 'HubSpot connection requires a token credential');
    switch (action.name) {
      case 'contacts.list':
        return { ok: true, data: await hsFetch(token, `/contacts?limit=${Number(input.limit ?? 10)}`), latencyMs: Date.now() - start };
      case 'contact.get':
        return { ok: true, data: await hsFetch(token, `/contacts/${encodeURIComponent(String(input.id))}`), latencyMs: Date.now() - start };
      case 'companies.list':
        return { ok: true, data: await hsFetch(token, `/companies?limit=${Number(input.limit ?? 10)}`), latencyMs: Date.now() - start };
      case 'deals.list':
        return { ok: true, data: await hsFetch(token, `/deals?limit=${Number(input.limit ?? 10)}`), latencyMs: Date.now() - start };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown HubSpot action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};