/**
 * CodeConClave - Vercel adapter (Stage 25.5).
 * Real Vercel REST API (https://api.vercel.com): projects/deployments read +
 * trigger a deployment. Token comes from encrypted credentials; deployments
 * are approval-gated (DEPLOY is a sensitive action in the shared policy).
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const VERCEL_API = 'https://api.vercel.com';
const ID_MAX = 200;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function vercelFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${VERCEL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('vercel_unauthorized', 'Vercel rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('vercel_api_rejected', `Vercel API failed (${response.status})`);
  return response.json();
}

export const vercelAdapter: PluginAdapter = {
  id: 'vercel',
  name: 'Vercel',
  provider: 'vercel.com',
  version: '1.0.0',
  capabilities: [PluginCapability.DEPLOYMENTS],
  oauth: null,
  actions: [
    {
      name: 'projects.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'List Vercel projects the token can access.',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'deployments.list',
      permission: PluginPermission.READ,
      scope: 'deployments:read',
      idempotent: true,
      description: 'List recent deployments for a Vercel project.',
      inputSchema: z.object({ projectId: z.string().min(1).max(ID_MAX).optional(), limit: z.coerce.number().int().min(1).max(50).default(10), timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'deployments.create',
      permission: PluginPermission.WRITE,
      scope: 'deployments:write',
      idempotent: false,
      description: 'Trigger a new deployment for a Vercel project.',
      inputSchema: z.object({ projectId: z.string().min(1).max(ID_MAX), timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('vercel_token_missing', 'Vercel connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('vercel_token_missing', 'Vercel connection requires a token credential');
    try {
      const payload = (await vercelFetch(token, '/v9/projects?limit=1')) as { projects?: unknown[] };
      if (!payload || !Array.isArray(payload.projects)) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: 'token accepted' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'vercel_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('vercel_token_missing', 'Vercel connection requires a token credential');
    if (action.name === 'projects.list') {
      const data = await vercelFetch(token, `/v9/projects?limit=${Number(input.limit ?? 20)}`);
      return { ok: true, data, latencyMs: Date.now() - start };
    }
    if (action.name === 'deployments.list') {
      const query = input.projectId ? `?projectId=${encodeURIComponent(String(input.projectId))}&limit=${Number(input.limit ?? 10)}` : `?limit=${Number(input.limit ?? 10)}`;
      const data = await vercelFetch(token, `/v6/deployments${query}`);
      return { ok: true, data, latencyMs: Date.now() - start };
    }
    if (action.name === 'deployments.create') {
      const data = await vercelFetch(token, `/v13/deployments?projectId=${encodeURIComponent(String(input.projectId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(input.projectId) }),
      });
      return { ok: true, data, latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Vercel action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};