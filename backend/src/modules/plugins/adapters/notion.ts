/**
 * CodeConClave - Notion adapter (user-supplied integration token).
 * Real Notion API v1 (https://api.notion.com/v1): user identity + search for
 * health, page reads and creation. Token stored as an encrypted credential.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const NOTION_API = 'https://api.notion.com/v1';
const ID_MAX = 64;
const TEXT_MAX = 2000;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function notionFetch(token: string, path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(`${NOTION_API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('notion_unauthorized', 'Notion rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('notion_api_rejected', `Notion API failed (${response.status})`);
  return response.json();
}

export const notionAdapter: PluginAdapter = {
  id: 'notion',
  name: 'Notion',
  provider: 'notion.so',
  version: '1.0.0',
  capabilities: [PluginCapability.DOCUMENTS],
  oauth: null,
  actions: [
    {
      name: 'users.me',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'The Notion user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'databases.search',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'Search Notion databases across the workspace.',
      inputSchema: z.object({
        query: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
    },
    {
      name: 'pages.search',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'Search Notion pages across the workspace.',
      inputSchema: z.object({
        query: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
    },
    {
      name: 'page.get',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'One page by id.',
      inputSchema: z.object({ page_id: z.string().min(1).max(ID_MAX) }),
    },
    {
      name: 'page.create',
      permission: PluginPermission.CREATE,
      scope: 'documents:create',
      idempotent: false,
      description: 'Create a blank page inside a database.',
      inputSchema: z.object({
        database_id: z.string().min(1).max(ID_MAX),
        title: z.string().min(1).max(TEXT_MAX),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('notion_token_missing', 'Notion connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('notion_token_missing', 'Notion connection requires a token credential');
    try {
      const payload = (await notionFetch(token, '/users/me')) as { object?: string; id?: string };
      if (payload?.object !== 'user' || !payload.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'notion_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('notion_token_missing', 'Notion connection requires a token credential');
    switch (action.name) {
      case 'users.me':
        return { ok: true, data: await notionFetch(token, '/users/me'), latencyMs: Date.now() - start };
      case 'databases.search':
        return {
          ok: true,
          data: await notionFetch(token, '/search', {
            method: 'POST',
            body: {
              filter: { value: 'database', property: 'object' },
              ...(input.query ? { query: String(input.query) } : {}),
              page_size: Number(input.limit ?? 10),
            },
          }),
          latencyMs: Date.now() - start,
        };
      case 'pages.search':
        return {
          ok: true,
          data: await notionFetch(token, '/search', {
            method: 'POST',
            body: {
              filter: { value: 'page', property: 'object' },
              ...(input.query ? { query: String(input.query) } : {}),
              page_size: Number(input.limit ?? 10),
            },
          }),
          latencyMs: Date.now() - start,
        };
      case 'page.get':
        return { ok: true, data: await notionFetch(token, `/pages/${encodeURIComponent(String(input.page_id))}`), latencyMs: Date.now() - start };
      case 'page.create':
        return {
          ok: true,
          data: await notionFetch(token, '/pages', {
            method: 'POST',
            body: {
              parent: { database_id: String(input.database_id) },
              properties: { title: { title: [{ text: { content: String(input.title) } }] } },
            },
          }),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Notion action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};