/**
 * CodeConClave - Trello adapter (user-supplied "API Key:Token" pair).
 * Real Trello REST API v1. Single credential value is "key:token"; health via
 * members/me; boards/lists reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const TRELLO_API = 'https://api.trello.com/1';
const ID_MAX = 64;

interface TrelloAuth {
  key: string;
  token: string;
}

function trelloAuth(creds: PluginCredentials): TrelloAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const key = raw.slice(0, sep);
  const token = raw.slice(sep + 1);
  if (!key || !token) return null;
  return { key, token };
}

async function trelloFetch(auth: TrelloAuth, path: string): Promise<unknown> {
  const response = await fetch(`${TRELLO_API}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(auth.key)}&token=${encodeURIComponent(auth.token)}`, {
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('trello_unauthorized', 'Trello rejected the API key / token pair');
  }
  if (!response.ok) throw AppError.unavailable('trello_api_rejected', `Trello API failed (${response.status})`);
  return response.json();
}

export const trelloAdapter: PluginAdapter = {
  id: 'trello',
  name: 'Trello',
  provider: 'trello.com',
  version: '1.0.0',
  capabilities: [PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'member.me',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'The Trello member the pair belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'boards.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Boards the member can see.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'lists.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Lists inside a board.',
      inputSchema: z.object({ board_id: z.string().min(1).max(ID_MAX) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!trelloAuth(creds)) {
      throw AppError.badRequest('trello_auth_invalid', 'Trello connection requires an "API Key:Token" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = trelloAuth(creds);
    if (!auth) throw AppError.badRequest('trello_auth_invalid', 'Trello connection requires an "API Key:Token" credential');
    try {
      const payload = (await trelloFetch(auth, '/members/me/')) as { id?: string; username?: string };
      if (!payload?.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.username ?? undefined };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'trello_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = trelloAuth(creds);
    if (!auth) throw AppError.badRequest('trello_auth_invalid', 'Trello connection requires an "API Key:Token" credential');
    switch (action.name) {
      case 'member.me':
        return { ok: true, data: await trelloFetch(auth, '/members/me/'), latencyMs: Date.now() - start };
      case 'boards.list':
        return {
          ok: true,
          data: await trelloFetch(auth, `/members/me/boards?fields=id,name`),
          latencyMs: Date.now() - start,
        };
      case 'lists.list':
        return {
          ok: true,
          data: await trelloFetch(auth, `/boards/${encodeURIComponent(String(input.board_id))}/lists?fields=id,name`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Trello action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};