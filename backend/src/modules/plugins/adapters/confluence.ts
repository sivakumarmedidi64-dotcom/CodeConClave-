/**
 * CodeConClave - Confluence adapter (user-supplied "site:email:API-token").
 * Real Confluence Cloud REST API with HTTP Basic. Health via the current-user
 * endpoint; space / page reads. The site is the "company" of company.atlassian.net.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const ATL_RE = /^[a-z0-9-]{2,63}\.atlassian\.net$/i;

interface AtlAuth {
  site: string;
  basic: string;
}

function atlAuth(creds: PluginCredentials): AtlAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [site, email, token] = parts;
  if (!site || !email || !token) return null;
  const host = `${site}.atlassian.net`;
  if (!ATL_RE.test(host)) return null;
  return { site, basic: Buffer.from(`${email}:${token}`).toString('base64') };
}

async function confFetch(auth: AtlAuth, path: string): Promise<unknown> {
  const response = await fetch(`https://${auth.site}.atlassian.net/wiki/rest/api${path}`, {
    headers: { Authorization: `Basic ${auth.basic}`, Accept: 'application/json' },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('atlassian_unauthorized', 'Atlassian rejected the site / email / API token combination');
  }
  if (response.status === 404) throw AppError.notFound('atlassian_site_not_found', `No Confluence site found at ${auth.site}.atlassian.net`);
  if (!response.ok) throw AppError.unavailable('confluence_api_rejected', `Confluence API failed (${response.status})`);
  return response.json();
}

export const confluenceAdapter: PluginAdapter = {
  id: 'confluence',
  name: 'Confluence',
  provider: 'atlassian.net',
  version: '1.0.0',
  capabilities: [PluginCapability.DOCUMENTS],
  oauth: null,
  actions: [
    {
      name: 'user.current',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'The Confluence user the API token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'spaces.list',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'Spaces in the site.',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
    },
    {
      name: 'pages.list',
      permission: PluginPermission.READ,
      scope: 'documents:read',
      idempotent: true,
      description: 'Pages in a space.',
      inputSchema: z.object({ spaceKey: z.string().min(1).max(200) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!atlAuth(creds)) {
      throw AppError.badRequest('confluence_auth_invalid', 'Confluence connection requires a "site:email:API-token" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = atlAuth(creds);
    if (!auth) throw AppError.badRequest('confluence_auth_invalid', 'Confluence connection requires a "site:email:API-token" credential');
    try {
      const payload = (await confFetch(auth, '/user/current')) as { displayName?: string; username?: string };
      if (!payload?.displayName) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.displayName };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'confluence_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = atlAuth(creds);
    if (!auth) throw AppError.badRequest('confluence_auth_invalid', 'Confluence connection requires a "site:email:API-token" credential');
    switch (action.name) {
      case 'user.current':
        return { ok: true, data: await confFetch(auth, '/user/current'), latencyMs: Date.now() - start };
      case 'spaces.list':
        return { ok: true, data: await confFetch(auth, `/space?limit=${Number(input.limit ?? 25)}`), latencyMs: Date.now() - start };
      case 'pages.list':
        return {
          ok: true,
          data: await confFetch(auth, `/content?type=page&spaceKey=${encodeURIComponent(String(input.spaceKey))}&limit=50&expand=title`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Confluence action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};