/**
 * CodeConClave - Coda adapter (user-supplied API token).
 * Real Coda API v1 (/apis/v1). Health via whoami; docs/tables/rows reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const CODA_API = 'https://coda.io/apis/v1';
const ID_MAX = 80;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function codaFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${CODA_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('coda_unauthorized', 'Coda rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('coda_api_rejected', `Coda API failed (${response.status})`);
  return response.json();
}

export const codaAdapter: PluginAdapter = {
  id: 'coda',
  name: 'Coda',
  provider: 'coda.io',
  version: '1.0.0',
  capabilities: [PluginCapability.DOCUMENTS],
  oauth: null,
  actions: [
    {
      name: 'whoami',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'The Coda user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'docs.list',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'Documents available to the token.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
    {
      name: 'tables.list',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'Tables inside a document.',
      inputSchema: z.object({
        doc_id: z.string().min(1).max(ID_MAX),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('coda_token_missing', 'Coda connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('coda_token_missing', 'Coda connection requires a token credential');
    try {
      const payload = (await codaFetch(token, '/whoami')) as { name?: string; email?: string };
      if (!payload?.name && !payload?.email) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.name ?? payload.email };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'coda_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('coda_token_missing', 'Coda connection requires a token credential');
    switch (action.name) {
      case 'whoami':
        return { ok: true, data: await codaFetch(token, '/whoami'), latencyMs: Date.now() - start };
      case 'docs.list':
        return { ok: true, data: await codaFetch(token, `/docs?limit=${Number(input.limit ?? 20)}`), latencyMs: Date.now() - start };
      case 'tables.list':
        return {
          ok: true,
          data: await codaFetch(token, `/docs/${encodeURIComponent(String(input.doc_id))}/tables?limit=${Number(input.limit ?? 20)}`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Coda action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};