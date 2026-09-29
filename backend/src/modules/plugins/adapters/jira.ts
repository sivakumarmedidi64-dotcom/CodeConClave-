/**
 * CodeConClave - Jira adapter (user-supplied "site:email:API-token").
 * Real Jira Cloud REST API 3 with HTTP Basic. Health via /rest/api/3/myself;
 * project and issue (JQL) reads. Atlassian API tokens are issued in Jira,
 * the site is the "company" part of company.atlassian.net.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const ATL_RE = /^[a-z0-9-]{2,63}\.atlassian\.net$/i;

interface AtlAuth {
  site: string;
  email: string;
  token: string;
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
  const basic = Buffer.from(`${email}:${token}`).toString('base64');
  return { site, email, token, basic };
}

async function atlFetch(auth: AtlAuth, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://${auth.site}.atlassian.net${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth.basic}`, Accept: 'application/json', ...(init?.headers ?? {}) },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('atlassian_unauthorized', 'Atlassian rejected the site / email / API token combination');
  }
  if (response.status === 404) throw AppError.notFound('atlassian_site_not_found', `No Jira site found at ${auth.site}.atlassian.net`);
  if (!response.ok) throw AppError.unavailable('atlassian_api_rejected', `Jira API failed (${response.status})`);
  return response.json();
}

export const jiraAdapter: PluginAdapter = {
  id: 'jira',
  name: 'Jira',
  provider: 'atlassian.net',
  version: '1.0.0',
  capabilities: [PluginCapability.ISSUES, PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'user.myself',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'The Jira user the API token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'projects.list',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'Projects visible to the user.',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(50).default(25) }),
    },
    {
      name: 'issues.search',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'Search issues with JQL (e.g. project = DEMO order by updated DESC).',
      inputSchema: z.object({ jql: z.string().min(1).max(2000) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!atlAuth(creds)) {
      throw AppError.badRequest('jira_auth_invalid', 'Jira connection requires a "site:email:API-token" credential (e.g. mycompany:you@mail.com:ATATT...)');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = atlAuth(creds);
    if (!auth) throw AppError.badRequest('jira_auth_invalid', 'Jira connection requires a "site:email:API-token" credential');
    try {
      const payload = (await atlFetch(auth, '/rest/api/3/myself')) as { displayName?: string; emailAddress?: string };
      if (!payload?.displayName) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.displayName };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'jira_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = atlAuth(creds);
    if (!auth) throw AppError.badRequest('jira_auth_invalid', 'Jira connection requires a "site:email:API-token" credential');
    switch (action.name) {
      case 'user.myself':
        return { ok: true, data: await atlFetch(auth, '/rest/api/3/myself'), latencyMs: Date.now() - start };
      case 'projects.list':
        return { ok: true, data: await atlFetch(auth, `/rest/api/3/project/search?startAt=0&maxResults=${Number(input.limit ?? 25)}`), latencyMs: Date.now() - start };
      case 'issues.search':
        return {
          ok: true,
          data: await atlFetch(auth, '/rest/api/3/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jql: String(input.jql), maxResults: 50, fields: ['summary', 'status', 'assignee', 'updated'] }),
          }),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Jira action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};