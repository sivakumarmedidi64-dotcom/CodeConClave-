/**
 * CodeConClave - PagerDuty adapter (user-supplied API token).
 * Real PagerDuty REST API v2 (https://api.pagerduty.com): user identity for
 * health + on-call lookup, incident list/read. Read-only by design.
 * Auth header is "Token token=<token>" per PagerDuty convention.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const PD_API = 'https://api.pagerduty.com';
const ID_MAX = 120;
const TEXT_MAX = 1000;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function pdFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${PD_API}${path}`, {
    headers: {
      Authorization: `Token token=${token}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('pagerduty_unauthorized', 'PagerDuty rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('pagerduty_api_rejected', `PagerDuty API failed (${response.status})`);
  return response.json();
}

export const pagerdutyAdapter: PluginAdapter = {
  id: 'pagerduty',
  name: 'PagerDuty',
  provider: 'pagerduty.com',
  version: '1.0.0',
  capabilities: [PluginCapability.MONITORING, PluginCapability.OBSERVABILITY],
  oauth: null,
  actions: [
    {
      name: 'users.me',
      permission: PluginPermission.READ,
      scope: 'incidents:read',
      idempotent: true,
      description: 'The PagerDuty user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'incidents.list',
      permission: PluginPermission.READ,
      scope: 'incidents:read',
      idempotent: true,
      description: 'List open incidents, newest first.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
        statuses: z.array(z.enum(['triggered', 'acknowledged', 'resolved'])).max(3).optional(),
      }),
    },
    {
      name: 'oncalls.current',
      permission: PluginPermission.READ,
      scope: 'incidents:read',
      idempotent: true,
      description: 'Who is on call right now for each escalation policy.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
      }),
    },
    {
      name: 'incident.get',
      permission: PluginPermission.READ,
      scope: 'incidents:read',
      idempotent: true,
      description: 'One incident by id.',
      inputSchema: z.object({
        id: z.string().min(1).max(ID_MAX),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('pagerduty_token_missing', 'PagerDuty connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('pagerduty_token_missing', 'PagerDuty connection requires a token credential');
    try {
      const payload = (await pdFetch(token, '/users/me')) as { user?: { name?: string; email?: string } };
      if (!payload?.user?.email) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.user.name ?? payload.user.email };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'pagerduty_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('pagerduty_token_missing', 'PagerDuty connection requires a token credential');
    switch (action.name) {
      case 'users.me':
        return { ok: true, data: await pdFetch(token, '/users/me'), latencyMs: Date.now() - start };
      case 'incidents.list': {
        const statuses = Array.isArray(input.statuses) && input.statuses.length ? String((input.statuses as string[]).map((s) => `statuses[]=${s}`).join('&')) : '';
        return {
          ok: true,
          data: await pdFetch(token, `/incidents?limit=${Number(input.limit ?? 10)}${statuses ? `&${statuses}` : ''}`),
          latencyMs: Date.now() - start,
        };
      }
      case 'oncalls.current':
        return { ok: true, data: await pdFetch(token, `/oncalls?limit=${Number(input.limit ?? 10)}`), latencyMs: Date.now() - start };
      case 'incident.get':
        return { ok: true, data: await pdFetch(token, `/incidents/${encodeURIComponent(String(input.id))}`), latencyMs: Date.now() - start };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown PagerDuty action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};