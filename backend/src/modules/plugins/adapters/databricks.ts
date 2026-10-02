/**
 * CodeConClave - Databricks adapter (user-supplied "Workspace URL:Token").
 * Single credential value is "https://<workspace>:<token>". Real Databricks
 * REST 2.0. Health via /api/2.0/current-user; clusters/jobs reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginPermission } from '@codeconclave/shared';

interface DBxAuth {
  host: string;
  token: string;
}

function dbxAuth(creds: PluginCredentials): DBxAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const sep = raw.lastIndexOf(':');
  if (sep <= 0) return null;
  let host = raw.slice(0, sep).replace(/\/+$/, '');
  const token = raw.slice(sep + 1);
  if (!host || !token) return null;
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  return { host, token };
}

async function dbxFetch(auth: DBxAuth, path: string): Promise<unknown> {
  const response = await fetch(`${auth.host}${path}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('databricks_unauthorized', 'Databricks rejected the workspace URL / token pair');
  }
  if (!response.ok) throw AppError.unavailable('databricks_api_rejected', `Databricks API failed (${response.status})`);
  return response.json();
}

export const databricksAdapter: PluginAdapter = {
  id: 'databricks',
  name: 'Databricks',
  provider: 'databricks.com',
  version: '1.0.0',
  capabilities: [],
  oauth: null,
  actions: [
    {
      name: 'current-user',
      permission: PluginPermission.READ,
      scope: 'data:read',
      idempotent: true,
      description: 'The Databricks user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'clusters.list',
      permission: PluginPermission.READ,
      scope: 'data:read',
      idempotent: true,
      description: 'Clusters in the workspace.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'jobs.list',
      permission: PluginPermission.READ,
      scope: 'data:read',
      idempotent: true,
      description: 'Jobs in the workspace.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!dbxAuth(creds)) {
      throw AppError.badRequest('databricks_auth_invalid', 'Databricks connection requires a "workspace URL:token" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = dbxAuth(creds);
    if (!auth) throw AppError.badRequest('databricks_auth_invalid', 'Databricks connection requires a "workspace URL:token" credential');
    try {
      const payload = (await dbxFetch(auth, '/api/2.0/current-user')) as { userName?: string };
      if (!payload?.userName) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.userName };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'databricks_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = dbxAuth(creds);
    if (!auth) throw AppError.badRequest('databricks_auth_invalid', 'Databricks connection requires a "workspace URL:token" credential');
    switch (action.name) {
      case 'current-user':
        return { ok: true, data: await dbxFetch(auth, '/api/2.0/current-user'), latencyMs: Date.now() - start };
      case 'clusters.list':
        return { ok: true, data: await dbxFetch(auth, '/api/2.0/clusters/list'), latencyMs: Date.now() - start };
      case 'jobs.list':
        return {
          ok: true,
          data: await dbxFetch(auth, `/api/2.1/jobs/list?limit=${Number(input.limit ?? 25)}`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Databricks action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};