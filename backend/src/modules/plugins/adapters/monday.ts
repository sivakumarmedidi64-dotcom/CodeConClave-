/**
 * CodeConClave - monday.com adapter (user-supplied API token).
 * Real monday.com GraphQL API v2. Health via whoami query; board/items reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const MONDAY_API = 'https://api.monday.com/v2';

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function mondayQuery(token: string, query: string): Promise<unknown> {
  const response = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal: outboundSignal(),
  });
  const payload = (await response.json()) as { errors?: unknown[]; data?: unknown };
  if (Array.isArray(payload.errors) || !response.ok) {
    throw AppError.unauthorized('monday_unauthorized', 'monday.com rejected the token');
  }
  return payload.data;
}

export const mondayAdapter: PluginAdapter = {
  id: 'monday',
  name: 'monday.com',
  provider: 'monday.com',
  version: '1.0.0',
  capabilities: [PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'account.get',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'The monday.com account the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'boards.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Boards available to the token.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
    {
      name: 'items.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Items (rows) in a board.',
      inputSchema: z.object({
        board_id: z.coerce.number().int().positive(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('monday_token_missing', 'monday.com connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('monday_token_missing', 'monday.com connection requires a token credential');
    try {
      const data = (await mondayQuery(token, 'query { account { id name } }')) as { account?: { id?: unknown } } | null;
      if (!data?.account?.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'monday_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('monday_token_missing', 'monday.com connection requires a token credential');
    switch (action.name) {
      case 'account.get':
        return { ok: true, data: await mondayQuery(token, 'query { account { id name } }'), latencyMs: Date.now() - start };
      case 'boards.list':
        return {
          ok: true,
          data: await mondayQuery(token, `query { boards(limit: ${Number(input.limit ?? 20)}) { id name } }`),
          latencyMs: Date.now() - start,
        };
      case 'items.list':
        return {
          ok: true,
          data: await mondayQuery(
            token,
            `query { boards(ids: [${Number(input.board_id)}]) { items_page(limit: ${Number(input.limit ?? 20)}) { items { id name } } } }`,
          ),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown monday.com action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};