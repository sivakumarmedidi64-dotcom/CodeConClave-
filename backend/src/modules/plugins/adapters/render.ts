/**
 * CodeConClave - Render adapter (user-supplied Read API token).
 * Real Render REST API. Health via /v1/user; services + deployments reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const RENDER_API = 'https://api.render.com/v1';

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function rdFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${RENDER_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('render_unauthorized', 'Render rejected the API token');
  }
  if (!response.ok) throw AppError.unavailable('render_api_rejected', `Render API failed (${response.status})`);
  return response.json();
}

export const renderAdapter: PluginAdapter = {
  id: 'render',
  name: 'Render',
  provider: 'render.com',
  version: '1.0.0',
  capabilities: [PluginCapability.DEPLOYMENTS],
  oauth: null,
  actions: [
    {
      name: 'user.get',
      permission: PluginPermission.READ,
      scope: 'deployments:read',
      idempotent: true,
      description: 'The Render account the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'services.list',
      permission: PluginPermission.READ,
      scope: 'deployments:read',
      idempotent: true,
      description: 'Services on the Render account.',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
    },
    {
      name: 'deployments.list',
      permission: PluginPermission.READ,
      scope: 'deployments:read',
      idempotent: true,
      description: 'Recent deployments for a named service.',
      inputSchema: z.object({ owner: z.string().min(1).max(400), repo: z.string().min(1).max(400) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('render_token_missing', 'Render connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('render_token_missing', 'Render connection requires a token credential');
    try {
      const payload = (await rdFetch(token, '/user')) as { email?: string; id?: string };
      if (!payload?.email) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.email };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'render_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('render_token_missing', 'Render connection requires a token credential');
    switch (action.name) {
      case 'user.get':
        return { ok: true, data: await rdFetch(token, '/user'), latencyMs: Date.now() - start };
      case 'services.list':
        return { ok: true, data: await rdFetch(token, `/services?limit=${Number(input.limit ?? 25)}`), latencyMs: Date.now() - start };
      case 'deployments.list': {
        const services = (await rdFetch(token, '/services?limit=50')) as { data?: Array<{ service: { id?: string; name?: string } }> };
        const pair = String(input.repo).toLowerCase();
        const match = Array.isArray(services?.data)
          ? services.data.find((d) => String(d?.service?.name ?? '').toLowerCase().includes(pair))
          : undefined;
        if (!match?.service?.id) {
          throw AppError.notFound('render_service_not_found', `No Render service matches "${input.repo}"`);
        }
        return { ok: true, data: await rdFetch(token, `/services/${match.service.id}/deploys?limit=5`), latencyMs: Date.now() - start };
      }
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Render action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};