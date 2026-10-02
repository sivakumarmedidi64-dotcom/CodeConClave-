/**
 * CodeConClave - Zendesk adapter (user-supplied "subdomain:email:token").
 * Real Zendesk Support API v2. Basic auth (email + API token) against the
 * tenant subdomain. Health via users/me; tickets reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginPermission } from '@codeconclave/shared';

const ID_MAX = 64;
const TEXT_MAX = 2000;

interface ZdAuth {
  subdomain: string;
  email: string;
  token: string;
}

function zdAuth(creds: PluginCredentials): ZdAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [subdomain, email, token] = parts as [string, string, string];
  if (!subdomain || !email || !token) return null;
  return { subdomain, email, token };
}

async function zdFetch(auth: ZdAuth, path: string): Promise<unknown> {
  const response = await fetch(`https://${auth.subdomain}.zendesk.com/api/v2${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.email}/token:${auth.token}`).toString('base64')}`,
    },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('zendesk_unauthorized', 'Zendesk rejected the subdomain / email / token triple');
  }
  if (!response.ok) throw AppError.unavailable('zendesk_api_rejected', `Zendesk API failed (${response.status})`);
  return response.json();
}

export const zendeskAdapter: PluginAdapter = {
  id: 'zendesk',
  name: 'Zendesk',
  provider: 'zendesk.com',
  version: '1.0.0',
  capabilities: [],
  oauth: null,
  actions: [
    {
      name: 'users.me',
      permission: PluginPermission.READ,
      scope: 'support:read',
      idempotent: true,
      description: 'The Zendesk user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'tickets.list',
      permission: PluginPermission.READ,
      scope: 'support:read',
      idempotent: true,
      description: 'Recent tickets for the account.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
      }),
    },
    {
      name: 'ticket.get',
      permission: PluginPermission.READ,
      scope: 'support:read',
      idempotent: true,
      description: 'One ticket with its comments.',
      inputSchema: z.object({
        id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    },
    {
      name: 'ticket.create',
      permission: PluginPermission.CREATE,
      scope: 'support:create',
      idempotent: false,
      description: 'Create a support ticket (write; approval required).',
      inputSchema: z.object({
        subject: z.string().min(1).max(TEXT_MAX),
        comment: z.string().min(1).max(50_000),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!zdAuth(creds)) {
      throw AppError.badRequest('zendesk_auth_invalid', 'Zendesk connection requires a "subdomain:email:token" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = zdAuth(creds);
    if (!auth) throw AppError.badRequest('zendesk_auth_invalid', 'Zendesk connection requires a "subdomain:email:token" credential');
    try {
      const payload = (await zdFetch(auth, '/users/me')) as { user?: { id?: number } };
      if (!payload?.user?.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'zendesk_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = zdAuth(creds);
    if (!auth) throw AppError.badRequest('zendesk_auth_invalid', 'Zendesk connection requires a "subdomain:email:token" credential');
    switch (action.name) {
      case 'users.me':
        return { ok: true, data: await zdFetch(auth, '/users/me'), latencyMs: Date.now() - start };
      case 'tickets.list':
        return { ok: true, data: await zdFetch(auth, `/tickets?sort_by=created_at&sort_order=desc&per_page=${Number(input.limit ?? 25)}`), latencyMs: Date.now() - start };
      case 'ticket.get':
        return { ok: true, data: await zdFetch(auth, `/tickets/${Number(input.id)}`), latencyMs: Date.now() - start };
      case 'ticket.create': {
        const response = await fetch(`https://${auth.subdomain}.zendesk.com/api/v2/tickets`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${auth.email}/token:${auth.token}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ticket: { subject: String(input.subject), comment: { body: String(input.comment) }, priority: input.priority ?? 'normal' } }),
          signal: outboundSignal(),
        });
        if (!response.ok) throw AppError.unavailable('zendesk_api_rejected', `Zendesk API failed (${response.status})`);
        return { ok: true, data: await response.json(), latencyMs: Date.now() - start };
      }
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Zendesk action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};